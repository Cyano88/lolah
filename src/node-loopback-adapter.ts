import {
  handleLolahLocalRequest,
  type LolahLocalRouteDependencies,
} from './local-service-routes.js'

const MAX_BODY_BYTES = 64 * 1_024

export type NodeLikeRequest = AsyncIterable<Uint8Array | string> & {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket: { remoteAddress?: string }
}

export type NodeLikeResponse = {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

function isLoopback(value: string | undefined) {
  if (!value) return false
  const normalized = value.toLowerCase()
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  const octets = ipv4.split('.')
  const validIpv4Loopback = octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  return normalized === '::1'
    || normalized === 'localhost'
    || validIpv4Loopback
}

function send(response: NodeLikeResponse, status: number, body: Record<string, unknown>) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

async function readBody(request: NodeLikeRequest) {
  const declaredLength = Object.entries(request.headers)
    .find(([name]) => name.toLowerCase() === 'content-length')?.[1]
  const firstLength = Array.isArray(declaredLength) ? declaredLength[0] : declaredLength
  if (firstLength !== undefined) {
    const parsedLength = Number(firstLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw new Error('invalid_content_length')
    if (parsedLength > MAX_BODY_BYTES) throw new Error('body_too_large')
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

export function createLolahLoopbackNodeHandler(dependencies: LolahLocalRouteDependencies) {
  return async (request: NodeLikeRequest, response: NodeLikeResponse) => {
    if (!isLoopback(request.socket.remoteAddress)) {
      send(response, 403, { ok: false, error: 'Loopback access only.' })
      return
    }
    const method = String(request.method ?? 'GET').toUpperCase()
    let path: string
    try {
      const requestUrl = String(request.url ?? '/')
      if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) throw new Error('invalid_url_form')
      path = new URL(requestUrl, 'http://127.0.0.1').pathname
    } catch {
      send(response, 400, { ok: false, error: 'Request URL is invalid.' })
      return
    }
    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request)
      const headers: Record<string, string | undefined> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value[0] : value
      }
      const result = await handleLolahLocalRequest({ method, path, headers, body }, dependencies)
      response.statusCode = result.status
      for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value)
      response.end(JSON.stringify(result.body))
    } catch (error) {
      if (error instanceof Error && error.message === 'body_too_large') {
        send(response, 413, { ok: false, error: 'Request body is too large.' })
      } else if (error instanceof Error && error.message === 'invalid_content_length') {
        send(response, 400, { ok: false, error: 'Content-Length is invalid.' })
      } else if (error instanceof Error && error.message === 'invalid_json') {
        send(response, 400, { ok: false, error: 'Request JSON is invalid.' })
      } else {
        send(response, 503, { ok: false, error: 'Local adapter is unavailable.' })
      }
    }
  }
}
