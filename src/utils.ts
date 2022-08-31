export type R2Operation = 'get' | 'put' | 'delete'
interface R2OperationSettings {
	source: R2Bucket

	operation: R2Operation
	bytes: number

	file: string
}
interface R2OperationResult {
	latency: number
}
export const getR2OperationLatency = async ({ bytes, source, operation, file }: R2OperationSettings): Promise<R2OperationResult> => {
	const start = Date.now()

	try {
		if (operation === 'put')
			await source.put(file, ''.padStart(bytes, 'a'))
		else if (operation === 'delete')
			await source.delete(file)
		else {
			const v = await source.get(file)

			if (v === null) {
				throw new Error('File not found')
			} else {
				await v.text()
			}
		}
	} catch (error: any) {
		console.error(`Error failed to run operation ${operation} for file ${file}. Message:`, error.message)
		throw error
	}

	const end = Date.now()

	return { latency: end - start }
}

export const promiseResult = <T>(promise: Promise<T>) => promise.then<[T, null]>(result => [result, null]).catch<[null, Error]>(error => [null, error])
