import { Hono } from 'hono'
import { OperationsManager, OperationsState } from './manager'
import { getR2OperationLatency, promiseResult } from './utils'

const app = new Hono<Bindings>()

app.get('/track/r2', async c => {
	// const agent = c.req.headers.get('user-agent')
	// if (!c.req.cf || !agent?.includes(c.env.LB_POOL_ID)) {
	// 	c.env.ErrorAnalytics.writeDataPoint({
	// 		blobs: ['NONE', c.req.cf?.colo?.slice(0, 3) ?? 'IDK', 'request:TrackR2', ''],
	// 		doubles: [1]
	// 	})

	// 	return c.json({ error: 'invalid request' }, 400)
	// }

	const colo = c.req.cf!.colo.slice(0, 3).toUpperCase()
	const id = c.env.OperationsManager.idFromName(colo)
	const res = await promiseResult(c.env.OperationsManager.get(id).fetch('https://fake-host/'))

	if (res[0] === null || !res[0].ok) {
		const error = res[0] === null ? res[1].message : await res[0].text()
		c.env.ErrorAnalytics.writeDataPoint({
			blobs: ['DO', colo, 'fetch:OperationsManagerCurrentState', id.toString(), error],
			doubles: [1]
		})

		return c.json({ error: 'cannot get current operation state' }, 503)
	}

	const state = await res[0].json<OperationsState>()

	c.executionCtx?.waitUntil(
		Promise.allSettled([
			getR2OperationLatency({
				bytes: state.dfw.bytes,
				source: c.env.BUCKET_DFW,
				operation: state.dfw.operation,
				file: state.dfw.file
			}),
			getR2OperationLatency({
				bytes: state.lhr.bytes,
				source: c.env.BUCKET_LHR,
				operation: state.lhr.operation,
				file: state.lhr.file
			})
		]).then(([dfw, lhr]) => {
			if (dfw.status === 'fulfilled' && dfw.value.latency !== -1) {
				c.env.LatencyAnalytics.writeDataPoint({
					blobs: ['R2', 'DFW', colo, state.dfw.operation, `${state.dfw.bytes}`],
					doubles: [dfw.value.latency]
				})
			} else if (dfw.status !== 'fulfilled') {
				c.env.ErrorAnalytics.writeDataPoint({
					blobs: ['R2:DFW', colo, `${state.dfw.operation}:${state.dfw.bytes}`, state.dfw.file, (dfw.reason as any).message],
					doubles: [1]
				})
			}

			if (lhr.status === 'fulfilled' && lhr.value.latency !== -1) {
				c.env.LatencyAnalytics.writeDataPoint({
					blobs: ['R2', 'LHR', colo, state.lhr.operation, `${state.lhr.bytes}`],
					doubles: [lhr.value.latency]
				})
			} else if (lhr.status !== 'fulfilled') {
				c.env.ErrorAnalytics.writeDataPoint({
					blobs: ['R2:LHR', colo, `${state.lhr.operation}:${state.lhr.bytes}`, state.lhr.file, (lhr.reason as any).message],
					doubles: [1]
				})
			}

			const results = {
				dfw: {
					success: dfw.status === 'fulfilled',
					file: state.dfw.file,
					operation: state.dfw.operation,
					bytes: state.dfw.bytes
				},
				lhr: {
					success: lhr.status === 'fulfilled',
					file: state.lhr.file,
					operation: state.lhr.operation,
					bytes: state.lhr.bytes
				}
			}

			return c.env.OperationsManager.get(id).fetch('https://fake-host/', {
				method: 'POST',
				body: JSON.stringify(results)
			})
		}).catch((err: Error) => {
			c.env.ErrorAnalytics.writeDataPoint({
				blobs: ['DO', colo, 'fetch:OperationsManagerCompleteOperation', id.toString(), err.message],
				doubles: [1]
			})
		})
	)

	return c.json({ queued: true, state })
})

export default {
	fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx)
	}
}

export { OperationsManager }
