import { handleLolahPublicRequest, type LolahPublicRouteDependencies } from './public-service-routes.js'

const MAX_BODY_BYTES = 4 * 1_024

type NodeRequest = AsyncIterable<Uint8Array | string> & {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
}

type NodeResponse = {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

function send(response: NodeResponse, status: number, headers: Record<string, string>, body: Record<string, unknown>) {
  response.statusCode = status
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
  response.end(JSON.stringify(body))
}

async function readBody(request: NodeRequest) {
  const declaredLength = Object.entries(request.headers)
    .find(([name]) => name.toLowerCase() === 'content-length')?.[1]
  const firstLength = Array.isArray(declaredLength) ? declaredLength[0] : declaredLength
  if (firstLength !== undefined) {
    const parsed = Number(firstLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid_content_length')
    if (parsed > MAX_BODY_BYTES) throw new Error('body_too_large')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large')
    chunks.push(buffer)
  }
  if (!chunks.length) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error('invalid_json')
  }
}

export function createLolahPublicNodeHandler(dependencies: LolahPublicRouteDependencies) {
  return async (request: NodeRequest, response: NodeResponse) => {
    const method = String(request.method ?? 'GET').toUpperCase()
    let path: string
    try {
      const requestUrl = String(request.url ?? '/')
      if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) throw new Error('invalid_url')
      path = new URL(requestUrl, 'http://lolah.invalid').pathname
    } catch {
      send(response, 400, { 'content-type': 'application/json', 'cache-control': 'no-store' }, {
        ok: false, error: 'Request URL is invalid.',
      })
      return
    }
    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request)
      const result = await handleLolahPublicRequest({ method, path, body }, dependencies)
      send(response, result.status, result.headers, result.body)
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'body_too_large'
      const invalidLength = error instanceof Error && error.message === 'invalid_content_length'
      send(response, tooLarge ? 413 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' }, {
        ok: false,
        error: tooLarge ? 'Request body is too large.'
          : invalidLength ? 'Content-Length is invalid.' : 'Request JSON is invalid.',
      })
    }
  }
}
