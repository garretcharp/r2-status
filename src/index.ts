import { Hono } from 'hono'
import { getColoRangeNumber, getR2OperationLatency, R2Operation, R2_DATA_CENTERS } from './utils'

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

app.get('/track/r2', async c => {
	const agent = c.req.headers.get('user-agent')
	if (!c.req.cf || !agent?.includes(c.env.LB_POOL_ID)) return c.json({ error: 'invalid request' }, 400)

	const caller = c.req.cf.colo.slice(0, 3), minutesSinceStart = Math.floor(((Date.now() - STARTED) / 1000) / 60)
	const [operation, bytes, sources] = OPTIONS[(minutesSinceStart + getColoRangeNumber(caller)) % OPTIONS.length]

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
			for (const result of results) {
				if (result.status === 'rejected') continue

				const { value } = result

				c.env.LatencyAnalytics.writeDataPoint({
					blobs: ['R2', value.source, caller, value.operation, `${value.bytes}`],
					doubles: [value.latency]
				})
			}
		})
	)

	return c.json({ queued: true, message: `Queued ${operation} operation for file of ${bytes} bytes to the following buckets: [${sources.join(', ')}]` })
})

export default {
	fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx)
	}
}
