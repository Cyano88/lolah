import type { LolahNewsEvent, PolydeskMarketContext } from './contracts.js'

type FetchLike = typeof fetch

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function endpointUrl(value: string, bearerToken: string) {
  const parsed = new URL(value)
  const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error('PolyDesk endpoint must use HTTPS outside local development.')
  }
  if (bearerToken && (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'polydesk.trade'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/api/agent/polymarket-context'
    || parsed.search
    || parsed.hash
  )) {
    throw new Error('Authenticated PolyDesk endpoint is not allowlisted.')
  }
  return parsed.toString()
}

export async function requestPolydeskMarketContext(
  endpoint: string,
  event: LolahNewsEvent,
  fetcher: FetchLike = fetch,
  bearerToken = '',
): Promise<PolydeskMarketContext> {
  const token = String(bearerToken).trim()
  if (token && (token.length < 32 || token.length > 8_192)) {
    throw new Error('PolyDesk context authorization is not configured.')
  }
  const response = await fetcher(endpointUrl(endpoint, token), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ event }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('PolyDesk context request failed with HTTP ' + response.status + '.')
  const envelope: unknown = await response.json()
  if (!isRecord(envelope) || envelope.ok !== true || !isRecord(envelope.data)) {
    throw new Error('PolyDesk returned an invalid response envelope.')
  }
  const data = envelope.data
  if (data.schema !== 'polydesk-market-context-v1' || data.provider !== 'polydesk') {
    throw new Error('PolyDesk returned an unsupported context schema.')
  }
  if (data.eventId !== event.eventId) throw new Error('PolyDesk context eventId differs from the requested event.')
  if (!['matched', 'ambiguous', 'no_relevant_market'].includes(String(data.matchStatus))) {
    throw new Error('PolyDesk returned an unsupported match status.')
  }
  if (!Array.isArray(data.candidates)) throw new Error('PolyDesk context candidates are missing.')
  if (data.matchStatus === 'matched') {
    if (!isRecord(data.consensus) || !['complete', 'partial'].includes(String(data.consensus.marketDataStatus))) {
      throw new Error('PolyDesk matched context is missing market-data completeness.')
    }
  }
  return data as PolydeskMarketContext
}
