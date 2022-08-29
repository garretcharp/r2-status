import { Hono } from 'hono'
import { bulkWrite } from './kv'
import { getColoRangeNumber, getDayTimeKey, getHourTimeKey, getMinuteTimeKey, getR2OperationLatency, hourKeyToTime, minuteKeyToTime, promiseResult, R2Operation, R2_DATA_CENTERS } from './utils'

const STARTED = 1660172400000

const FILE_SIZES = [
	0,
	1000000,
	5000000,
	25000000
]

const OPTIONS: ([R2Operation, number, string[]])[] = []

for (const sources of R2_DATA_CENTERS) {
	for (const BYTES of FILE_SIZES) {
		OPTIONS.push(['get', BYTES, sources])
		OPTIONS.push(['put', BYTES, sources])
	}
}

const app = new Hono<Bindings>()

app.get('/timeseries/r2', async c => {
	const start = new Date().setUTCMinutes(0, 0, 0)

	const keys: string[] = []

	for (let i = 0; i < 24; i++) keys.push(`Aggregates/R2/Hour/${getHourTimeKey(start - (1000 * 60 * 60 * i))}`)

	const results = await Promise.all(keys.map(key => c.env.Tracking.get(key)))

	return new Response(`[${results.join(',')}]`, { headers: { 'Content-Type': 'application/json' }, status: 200 })
})

app.get('/track/r2', async c => {
	if (!c.req.cf) return c.json({ error: 'no cloudflare props' }, 400)

	const agent = c.req.headers.get('user-agent')

	if (!agent?.includes(c.env.LB_POOL_ID)) return c.json({ error: 'invalid user-agent' }, 400)

	const now = Date.now()

	const caller = c.req.cf.colo.slice(0, 3), minutesSinceStart = Math.floor(((now - STARTED) / 1000) / 60)
	const time = getMinuteTimeKey(now)

	const [operation, bytes, sources] = OPTIONS[(minutesSinceStart + getColoRangeNumber(caller)) % OPTIONS.length]

	const current = await c.env.Tracking.get(`TimeSeries/R2/${time}/${caller}/${operation}/${bytes}`)

	if (typeof current === 'string') {
		return c.json({ queued: false, message: 'already tracked current minute' })
	}

	c.executionCtx?.waitUntil(
		Promise.allSettled(
			sources.map(async source => {
				return getR2OperationLatency({
					env: c.env,
					colo: caller,
					bytes,
					source,
					operation
				})
			})
		).then(results => {
			const data = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof getR2OperationLatency>>>[]

			if (data.length === 0) return Promise.resolve()

			for (const result of results) {
				if (result.status === 'rejected') continue

				const { value } = result

				c.env.LatencyAnalytics.writeDataPoint({
					blobs: ['R2', value.source, caller, value.operation, `${value.bytes}`],
					doubles: [value.latency]
				})
			}

			return c.env.Tracking.put(`TimeSeries/R2/${time}/${caller}/${operation}/${bytes}`, '', {
				metadata: data.reduce((acc, { value }) => {
					return { ...acc, [value.source]: value.latency }
				}, {})
			})
		}).catch((error: any) => {
			console.error('Error writing results to KV', error.message)
		})
	)

	return c.json({ queued: true, message: `Queued ${operation} operation for file of ${bytes} bytes to the following buckets: [${sources.join(', ')}]` })
})

type colo = string
type bytes = number

interface R2AggregatedView {
	[key: `${colo}->${colo}`]: {
		[key: bytes]: {
			get: number[]
			put: number[]
		}
	}
}

export class AggregationJobs implements DurableObject {
	private app = new Hono<Bindings>()

	private alarmRunning: boolean = false

	private cache: { [key: string]: any } = {}

	private setValue<T>(key: string, value: T) {
		this.cache[key] = value
		this.state.storage.put(key, value)
	}

	private async getValue<T>(key: string): Promise<T | undefined> {
		const value = (this.cache[key] as T | undefined) ?? await this.state.storage.get<T>(key, { noCache: true })

		this.cache[key] = value

		return value
	}

	private setAlarm(time: number) {
		this.cache[`_alarm`] = time
		this.state.storage.setAlarm(time)
	}

	private async getAlarm(): Promise<number | null> {
		const value = (this.cache[`_alarm`] as number | undefined) ?? await this.state.storage.getAlarm()

		if (typeof value === 'number') this.cache[`_alarm`] = value
		else delete this.cache[`_alarm`]

		return value
	}

	constructor(private state: DurableObjectState, private env: Bindings) {
		this.state.blockConcurrencyWhile(async () => {
			await Promise.all([
				this.getValue('queue'),
				this.getAlarm()
			])

			const queue = await this.getValue<any[]>('queue')

			if (queue && queue.every(q => typeof q.time === 'number')) {
				this.setValue('queue', [...new Set(queue.map(v => new Date(v.time).setUTCHours(23, 59, 59, 999)))])
			}
		})

		this.app.post('/', async c => {
			const { scheduledTime } = await c.req.json<{ scheduledTime: number }>()

			this.hourlyAggregations(scheduledTime)

			return c.json({ queued: true, message: 'enqueued work' })
		})

		this.app.get('/queue', async c => {
			const [queue, alarm] = await Promise.all([
				this.getValue<any[]>('queue'),
				this.state.storage.getAlarm()
			])

			return c.json({
				id: this.state.id.toString(),
				alarm: {
					running: this.alarmRunning,
					next: alarm ? new Date(alarm).toISOString() : null
				},
				queue
			})
		})

		this.app.get('/logs', async c => {
			const values = await this.state.storage.list({ prefix: 'Logs/', reverse: true, limit: 1000 })

			return c.json({
				values: Object.fromEntries(values.entries()),
				size: values.size
			})
		})
	}

	async fetch(request: Request) {
		return this.app.fetch(request, this.env)
	}

	async alarm() {
		try {
			this.alarmRunning = true
			this.cache[`_alarm`] = null

			this.state.storage.put(`Logs/${new Date().toISOString()}/${crypto.randomUUID()}`, {
				message: `Starting alarm`
			})

			const queueResult = await promiseResult(this.state.storage.get<any[]>('queue'))
			if (queueResult[1] || !queueResult[0]?.length) {
				this.state.storage.put(`Logs/${new Date().toISOString()}/${crypto.randomUUID()}`, {
					message: `Aggregation alarm for failed because it could not get the queue, or queue was empty`,
					data: {
						queue: queueResult[0],
						error: queueResult[1]?.message
					}
				})
				this.setAlarm(Date.now() + 1000 * 5)
				this.alarmRunning = false
				return
			}

			const time = queueResult[0][0]

			const aggregationResult = await promiseResult(this.dailyAggregations(time))

			const currentQueueResult = await promiseResult(this.state.storage.get<any[]>('queue'))

			if (currentQueueResult[1]) {
				this.state.storage.put(`Logs/${new Date().toISOString()}/${crypto.randomUUID()}`, {
					message: `Aggregation alarm finalizing for ${new Date(time).toISOString()} failed because it could not get the current queue`,
					data: { error: currentQueueResult[1].message }
				})
				this.setAlarm(Date.now() + 1000 * 5)
				this.alarmRunning = false
				return
			}

			const currentQueue = currentQueueResult[0]

			if (!currentQueue?.length) {
				this.state.storage.put(`Logs/${new Date().toISOString()}/${crypto.randomUUID()}`, {
					message: `Aggregation alarm finalizing for ${new Date(time).toISOString()} failed because the current queue was empty`
				})
				this.setAlarm(Date.now() + 1000 * 5)
				this.alarmRunning = false
				return
			}

			if (aggregationResult[1]) {
				this.state.storage.put(`Logs/${new Date().toISOString()}/${crypto.randomUUID()}`, {
					message: `Aggregation alarm for ${new Date(time).toISOString()} failed`,
					data: { error: aggregationResult[1].message }
				})
				this.setAlarm(Date.now() + 1000 * 5)
			} else {
				this.setValue('queue', currentQueue.slice(1))

				if (currentQueue.length > 1) this.setAlarm(Date.now())
			}

			this.alarmRunning = false
		} catch (error: any) {
			this.state.storage.put(`Logs/${new Date().toISOString()}/${crypto.randomUUID()}`, {
				message: `Some error happened in the alarm. Message: ${error.message}`,
			})
			this.setAlarm(Date.now() + 1000 * 5)
		} finally {
			this.state.storage.put(`Logs/${new Date().toISOString()}/${crypto.randomUUID()}`, {
				message: `Alarm finished`
			})
			this.alarmRunning = false
		}
	}

	private runningHourlyAggregation = false
	async hourlyAggregations (scheduledTime: number) {
		if (this.runningHourlyAggregation) return
		this.runningHourlyAggregation = true

		const before = new Date(scheduledTime).setUTCMinutes(59, 59, 999)
		const after = new Date(scheduledTime - 1000 * 60 * 60 * 3).setUTCMinutes(0, 0, 0)

		let cursor: string | undefined, complete = false

		const grouped: Record<string, R2AggregatedView> = {}
		const times: { [key: string]: { start: number, end: number } } = {}

		try {
			do {
				const { keys, cursor: newCursor, list_complete } = await this.env.Tracking.list<Record<string, number>>({ prefix: 'TimeSeries/R2', cursor })

				cursor = newCursor, complete = list_complete

				for (const { name, metadata } of keys) {
					if (!metadata) continue

					const [reversedTime, caller, operation, byteString] = name.split('/').slice(2)

					const time = minuteKeyToTime(reversedTime), bytes = parseInt(byteString)

					if (time < after) {
						complete = true
						break
					} else if (time > before) continue

					const hour = getHourTimeKey(time)

					if (!grouped[hour]) grouped[hour] = {}

					if (!times[hour]) times[hour] = { start: time, end: time }
					if (time < times[hour].start) times[hour].start = time
					if (time > times[hour].end) times[hour].end = time

					for (const [source, latency] of Object.entries(metadata)) {
						const key: `${colo}->${colo}` = `${caller}->${source}`

						if (!grouped[hour][key]) grouped[hour][key] = {}
						if (!grouped[hour][key][bytes]) grouped[hour][key][bytes] = { get: [], put: [] }

						grouped[hour][key][bytes][operation as 'get' | 'put'].push(latency)
					}
				}
			} while (!complete && cursor)

			await bulkWrite({
				env: this.env,
				data: Object.entries(grouped).map(([hour, value]) => {
					return {
						key: `Aggregates/R2/Hour/${hour}`,
						value: JSON.stringify(value),
						metadata: {
							updated: new Date().toISOString(),
							start: new Date(times[hour].start).toISOString(),
							end: new Date(times[hour].end).toISOString()
						}
					}
				})
			})

			const currentDay = new Date(scheduledTime).setUTCHours(23, 59, 59, 999)

			const [queue, alarm] = await Promise.all([
				this.getValue<number[]>('queue'),
				this.getAlarm()
			])

			if (!queue || !queue.includes(currentDay)) this.setValue('queue', [...(queue ?? []), currentDay])
			if (!alarm) this.setAlarm(Date.now())
		} catch (error) {

		}

		this.runningHourlyAggregation = false
	}

	async dailyAggregations (scheduledTime: number) {
		const start = new Date(scheduledTime).setUTCHours(23, 0, 0, 0)

		const keys: string[] = []

		for (let i = 0; i < 24; i++) keys.push(`Aggregates/R2/Hour/${getHourTimeKey(start - (1000 * 60 * 60 * i))}`)

		const results = await Promise.allSettled(
			keys.map(key => this.env.Tracking.get<R2AggregatedView>(key, { type: 'json' }).then(value => {
				return {
					value,
					hour: hourKeyToTime(key.split('/')[3])
				}
			}))
		)

		const grouped: Record<string, R2AggregatedView> = {}
		const times: { [key: string]: { start: number, end: number } } = {}

		for (const result of results) {
			if (result.status !== 'fulfilled') continue

			const { value, hour } = result.value

			if (value === null) continue

			const day = getDayTimeKey(hour)

			if (!grouped[day]) grouped[day] = {}

			if (!times[day]) times[day] = { start: hour, end: hour }
			if (hour < times[day].start) times[day].start = hour
			if (hour > times[day].end) times[day].end = hour

			for (const [k, b] of Object.entries(value)) {
				const key = k as `${colo}->${colo}`

				if (!grouped[day][key]) grouped[day][key] = {}

				for (const [byteString, ops] of Object.entries(b as { [key: bytes]: { get: number[], put: number[] } })) {
					const bytes = parseInt(byteString)

					if (!grouped[day][key][bytes]) grouped[day][key][bytes] = { get: [], put: [] }

					grouped[day][key][bytes].get.push(...ops.get)
					grouped[day][key][bytes].put.push(...ops.put)
				}
			}
		}

		await bulkWrite({
			env: this.env,
			data: Object.entries(grouped).map(([day, value]) => {
				return {
					key: `Aggregates/R2/Day/${day}`,
					value: JSON.stringify(value),
					metadata: {
						updated: new Date().toISOString(),
						start: new Date(times[day].start).toISOString(),
						end: new Date(times[day].end).toISOString()
					}
				}
			})
		})
	}
}

app.get('/queue', async c => {
	return c.env.AggregationJobs.get(
		c.env.AggregationJobs.idFromName('AggregationJobs')
	).fetch('https://fake-host/queue')
})

app.get('/logs', async c => {
	return c.env.AggregationJobs.get(
		c.env.AggregationJobs.idFromName('AggregationJobs')
	).fetch('https://fake-host/logs')
})

export default {
	fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx)
	},
	async scheduled({ cron, scheduledTime }: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
		await env.AggregationJobs.get(
			env.AggregationJobs.idFromName('AggregationJobs')
		).fetch('https://fake-host/', {
			method: 'POST',
			body: JSON.stringify({ cron, scheduledTime })
		})
	}
}
