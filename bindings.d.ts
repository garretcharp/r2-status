type Service = 'R2:DFW' | 'R2:LHR' | 'DO' | 'KV' | 'NONE'

type Colo = string
type BucketSource = 'DFW' | 'LHR' | string

type Operation = string

interface Bindings {
	// BUCKET_AMS: R2Bucket
	// BUCKET_ARN: R2Bucket
	// BUCKET_ATL: R2Bucket
	// BUCKET_CDG: R2Bucket
	// BUCKET_DEN: R2Bucket
	BUCKET_DFW: R2Bucket
	// BUCKET_EWR: R2Bucket
	// BUCKET_FRA: R2Bucket
	// BUCKET_HKG: R2Bucket
	// BUCKET_IAD: R2Bucket
	// BUCKET_KIX: R2Bucket
	// BUCKET_LAX: R2Bucket
	BUCKET_LHR: R2Bucket
	// BUCKET_MAD: R2Bucket
	// BUCKET_MIA: R2Bucket
	// BUCKET_MRS: R2Bucket
	// BUCKET_MXP: R2Bucket
	// BUCKET_NRT: R2Bucket
	// BUCKET_ORD: R2Bucket
	// BUCKET_PRG: R2Bucket
	// BUCKET_SEA: R2Bucket
	// BUCKET_SIN: R2Bucket
	// BUCKET_SJC: R2Bucket
	// BUCKET_TPE: R2Bucket
	// BUCKET_VIE: R2Bucket

	OperationsManager: DurableObjectNamespace

	LatencyAnalytics: {
		writeDataPoint: (point: {
			blobs: ['R2', BucketSource, Colo, Operation, `${number}`]
			doubles: [number]
		}) => void
	}

	ErrorAnalytics: {
		writeDataPoint: (point: {
			blobs: [Service, Colo, Operation, string]
			doubles: [1]
		}) => void
	}

	LB_POOL_ID: string
}
