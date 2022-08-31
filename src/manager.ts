import { Hono } from 'hono'
import { R2Operation } from './utils'

interface Operation {
	operation: R2Operation
	bytes: number
	file: string
}

export interface OperationsState {
	dfw: Operation
	lhr: Operation
}

export class OperationsManager implements DurableObject {
	private app = new Hono<Bindings>()

	// Flow = put -> get -> delete
	getNextOperation(op: Operation): Operation {
		if (op.operation === 'put') {
			return {
				operation: 'get',
				bytes: op.bytes,
				file: op.file
			}
		} else if (op.operation === 'get') {
			return {
				operation: 'delete',
				bytes: op.bytes,
				file: op.file
			}
		} else {
			let nextBytes = op.bytes === 0 ? 1000000 : op.bytes === 1000000 ? 5000000 : op.bytes === 5000000 ? 25000000 : 0

			return {
				operation: 'put',
				bytes: nextBytes,
				file: `${this.state.id.toString()}-${crypto.randomUUID()}`
			}
		}
	}

	operationsEqual(a: Operation, b: Operation) {
		return a.operation === b.operation && a.bytes === b.bytes && a.file === b.file
	}

	constructor(private state: DurableObjectState, private env: Bindings) {
		this.state.blockConcurrencyWhile(async () => {
			const currentState = await this.state.storage.get<OperationsState>('state')

			// This durable object was just now created, so create its initial state
			if (!currentState) {
				await this.state.storage.put<OperationsState>('state', {
					dfw: { operation: 'put', bytes: 0, file: `${this.state.id.toString()}-${crypto.randomUUID()}` },
					lhr: { operation: 'put', bytes: 0, file: `${this.state.id.toString()}-${crypto.randomUUID()}` }
				})
			}
		})

		this.app.get('/', async c => {
			const currentState = await this.state.storage.get<OperationsState>('state')

			// shouldn't ever happen really
			if (!currentState) return c.json({ error: 'failed to get state?' }, 400)

			return c.json(currentState)
		})

		this.app.post('/', async c => {
			const currentState = await this.state.storage.get<OperationsState>('state')

			// shouldn't ever happen really
			if (!currentState) return c.json({ error: 'failed to get state?' }, 400)

			const results = await c.req.json<{
				dfw: {
					success: boolean
					operation: R2Operation
					bytes: number
					file: string
				}
				lhr: {
					success: boolean
					operation: R2Operation
					bytes: number
					file: string
				}
			}>()

			await this.state.storage.put<OperationsState>('state', {
				dfw: results.dfw.success && this.operationsEqual(currentState.dfw, results.dfw) ? this.getNextOperation(currentState.dfw) : currentState.dfw,
				lhr: results.lhr.success && this.operationsEqual(currentState.lhr, results.lhr) ? this.getNextOperation(currentState.lhr) : currentState.lhr
			})

			return c.json({ ok: true })
		})
	}

	async fetch(request: Request) {
		return this.app.fetch(request, this.env)
	}
}
