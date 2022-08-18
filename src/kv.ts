interface BulkWriteSettings {
	env: Bindings
	data: { key: string, value: string, metadata: any }[]
}

export const bulkWrite = async ({ env, data }: BulkWriteSettings) => {
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/storage/kv/namespaces/${env.KV_NAMESPACE}/bulk`, {
		method: 'PUT',
		body: JSON.stringify(data),
		headers: {
			Authorization: `Bearer ${env.KV_API_KEY}`,
			'Content-Type': 'application/json'
		}
	})

	if (!response.ok) {
		throw new Error(`KV bulk write failed: ${response.statusText} ${await response.text()}`)
	}

	return {
		status: response.status,
		data: await response.json()
	}
}
