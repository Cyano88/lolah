import { createHash, timingSafeEqual } from 'node:crypto'
import type { LolahSubscriptionSignal } from './subscription-push.js'
import { validateSubscriptionSignal } from './subscription-push.js'

export const LOLAH_SUBSCRIPTION_FEED_URL =
  'https://lolah.onrender.com/internal/v1/subscription-signals'

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

export function validRelayToken(value: string) {
  const token = String(value).trim()
  return token.length >= 32 && token.length <= 8_192
}

export function authorizeRelayRequest(authorization: string | undefined, expectedToken: string) {
  if (!validRelayToken(expectedToken)) return false
  const prefix = 'Bearer '
  const header = String(authorization ?? '')
  if (!header.startsWith(prefix)) return false
  const supplied = header.slice(prefix.length)
  if (!validRelayToken(supplied)) return false
  return timingSafeEqual(digest(supplied), digest(expectedToken.trim()))
}

export function validateSubscriptionFeedUrl(value: string) {
  const normalized = String(value).trim()
  if (normalized !== LOLAH_SUBSCRIPTION_FEED_URL) {
    throw new Error('LOLAH_SUBSCRIPTION_FEED_URL must be the canonical Lolah HTTPS feed.')
  }
  return normalized
}

export async function fetchRelayedSubscriptionSignals(input: {
  url: string
  token: string
  fetcher?: typeof fetch
}): Promise<LolahSubscriptionSignal[]> {
  const url = validateSubscriptionFeedUrl(input.url)
  const token = String(input.token).trim()
  if (!validRelayToken(token)) throw new Error('LOLAH_SUBSCRIPTION_FEED_TOKEN is required.')
  const response = await (input.fetcher ?? fetch)(url, {
    method: 'GET',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('Lolah subscription feed is unavailable.')
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > 2 * 1_024 * 1_024) {
    throw new Error('Lolah subscription feed response is invalid.')
  }
  const encoded = await response.text()
  if (Buffer.byteLength(encoded, 'utf8') > 2 * 1_024 * 1_024) {
    throw new Error('Lolah subscription feed response is invalid.')
  }
  let payload: unknown
  try { payload = JSON.parse(encoded) as unknown } catch {
    throw new Error('Lolah subscription feed response is invalid.')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Lolah subscription feed response is invalid.')
  }
  const envelope = payload as {
    ok?: unknown
    schema?: unknown
    signals?: unknown
    executionAllowed?: unknown
  }
  if (envelope.ok !== true || envelope.schema !== 'lolah-subscription-feed-v1'
    || envelope.executionAllowed !== false) {
    throw new Error('Lolah subscription feed response is invalid.')
  }
  const signals = envelope.signals
  if (!Array.isArray(signals) || signals.length > 500) {
    throw new Error('Lolah subscription feed response is invalid.')
  }
  return signals.map(signal => validateSubscriptionSignal(signal as LolahSubscriptionSignal))
}
