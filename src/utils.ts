export const createArray = (length: number) => Array(length).fill(null)

const MAX_SAFE_INTEGER = 9007199254740991
// Converts date to a reverse timestamp key to sort in kv newest date first and groups by <time unit>
export const getMinuteTimeKey = (time = Date.now()) => (MAX_SAFE_INTEGER - Math.floor(time / 1000 / 60)).toString()
export const getHourTimeKey = (time = Date.now()) => (MAX_SAFE_INTEGER - Math.floor(time / 1000 / 60 / 60)).toString()
export const getDayTimeKey = (time = Date.now()) => (MAX_SAFE_INTEGER - Math.floor(time / 1000 / 60 / 60 / 24)).toString()

export const minuteKeyToTime = (key: string) => (MAX_SAFE_INTEGER - parseInt(key)) * 1000 * 60
export const hourKeyToTime = (key: string) => (MAX_SAFE_INTEGER - parseInt(key)) * 1000 * 60 * 60

const COLO_RANGES = [
	'AMS', 'BCN', 'BNU', 'BUD', 'CFC',
	'CMH', 'CWB', 'DME', 'DXB', 'FLN',
	'GRU', 'HAM', 'HYD', 'ITJ', 'JOI',
	'KIX', 'LAX', 'LLK', 'MBA', 'MEX',
	'MPM', 'NBO', 'ORD', 'PBM', 'PNH',
	'RIC', 'SFO', 'SLC', 'SYD', 'TLV',
	'ULN', 'XNH', 'YYZ'
]

export const getColoRangeNumber = (colo: string) => {
	const index = COLO_RANGES.findIndex(range => colo < range)

	return index !== -1 ? index + 1 : COLO_RANGES.length
}

export const R2_DATA_CENTERS = [
	['AMS', 'ARN', 'ATL', 'CDG', 'DEN'],
	['DFW', 'EWR', 'FRA', 'HKG', 'IAD'],
	['KIX', 'LAX', 'LHR', 'MAD', 'MIA'],
	['MRS', 'MXP', 'NRT', 'ORD', 'PRG'],
	['SEA', 'SIN', 'SJC', 'TPE', 'VIE']
]

export type R2Operation = 'get' | 'put'
interface R2OperationSettings {
	env: Bindings
	bytes: number
	colo: string
	source: string

	operation: R2Operation
}
interface R2OperationResult {
	operation: R2Operation
	bytes: number
	latency: number
	source: string
}
export const getR2OperationLatency = async ({ env, bytes, colo, source, operation }: R2OperationSettings): Promise<R2OperationResult> => {
	const start = Date.now()

	const bucket = (env as any)[`BUCKET_${source}`] as R2Bucket

	if (!bucket) throw new Error(`Error R2 bucket ${source} not found`)

	try {
		if (operation === 'put')
			await bucket.put(`${bytes}/${colo.slice(0, 3)}`, ''.padStart(bytes, 'a'))
		else {
			const v = await bucket.get(`${bytes}/${colo.slice(0, 3)}`)

			if (v === null) {
				throw new Error('File not found')
			} else {
				await v.text()
			}
		}
	} catch (error: any) {
		console.error(`Error failed to run operation ${operation} for file ${bytes}/${colo.slice(0, 3)}. R2 ${source}. Message:`, error.message)
		throw error
	}

	const end = Date.now()

	return {
		operation,
		source,
		bytes,
		latency: end - start,
	}
}

export const promiseResult = <T>(promise: Promise<T>) => promise.then<[T, null]>(result => [result, null]).catch<[null, Error]>(error => [null, error])
