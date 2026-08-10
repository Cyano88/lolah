import type { LolahNewsEvent } from './contracts.js'
import { fetchHyperliquidMarketContext } from './hyperliquid-context.js'
import { requestPolydeskMarketContext } from './polydesk-client.js'
import { fetchRecentXPosts } from './x-recent-search.js'

type Component<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_configured'; errorCode: 'not_configured' }
  | { status: 'unavailable'; errorCode: 'provider_unavailable' }

export type LolahLiveShadowInput = {
  event: LolahNewsEvent
  targetMarket: string
  polydeskEndpoint: string
  mode?: 'production_shadow' | 'local_staging'
  x?: {
    query: string
    bearerToken?: string
  }
  fetcher?: typeof fetch
  now?: () => Date
}

export type LolahLiveShadowResult = {
  schema: 'lolah-live-shadow-v1'
  state: 'complete' | 'partial' | 'unavailable'
  eventId: string
  targetMarket: string
  observedAt: string
  components: {
    x: Component<{
      fetched: number
      pagesFetched: 1
      newestCreatedAt?: string
    }>
    polydesk: Component<{
      matchStatus: 'matched' | 'ambiguous' | 'no_relevant_market'
      candidateCount: number
      marketDataStatus?: 'complete' | 'partial'
      searchedAt: string
    }>
    hyperliquid: Component<{
      market: string
      marketStatus: 'available' | 'not_found'
      observedAt: string
      markPrice?: number
      bestBid?: number
      bestAsk?: number
      spreadBps?: number
    }>
  }
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

function validateEvent(event: LolahNewsEvent) {
  if (!event || event.schema !== 'lolah-news-event-v1'
    || !/^evt_[a-zA-Z0-9_-]{3,120}$/.test(event.eventId)
    || !Array.isArray(event.entities) || event.entities.length < 1
    || !Number.isFinite(Date.parse(event.publishedAt))
    || !Number.isFinite(Date.parse(event.detectedAt))) {
    throw new Error('Live shadow event is invalid.')
  }
}

export function validateLiveShadowPolydeskEndpoint(
  value: string,
  mode: 'production_shadow' | 'local_staging',
) {
  const endpoint = new URL(value)
  const commonInvalid = endpoint.username
    || endpoint.password
    || endpoint.pathname !== '/api/agent/polymarket-context'
    || endpoint.search
    || endpoint.hash
  const productionInvalid = mode === 'production_shadow'
    && (endpoint.protocol !== 'https:' || endpoint.hostname !== 'polydesk.trade' || endpoint.port)
  const stagingInvalid = mode === 'local_staging'
    && (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port)
  if (commonInvalid || productionInvalid || stagingInvalid) {
    throw new Error('Live shadow PolyDesk endpoint is not allowlisted.')
  }
  return endpoint.toString()
}

function positive(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

function nonnegative(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

async function xComponent(input: LolahLiveShadowInput, fetcher: typeof fetch) {
  const token = input.x?.bearerToken
  if (!input.x || !token) {
    return { status: 'not_configured', errorCode: 'not_configured' } as const
  }
  if (token.length < 20 || token.length > 8_192) {
    return { status: 'unavailable', errorCode: 'provider_unavailable' } as const
  }
  try {
    const result = await fetchRecentXPosts(input.x.query, token, fetcher)
    const newestCreatedAt = result.posts
      .map(post => post.createdAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    return {
      status: 'ok',
      data: {
        fetched: result.posts.length,
        pagesFetched: 1 as const,
        ...(newestCreatedAt ? { newestCreatedAt } : {}),
      },
    } as const
  } catch {
    return { status: 'unavailable', errorCode: 'provider_unavailable' } as const
  }
}

export async function runLolahLiveShadow(
  input: LolahLiveShadowInput,
): Promise<LolahLiveShadowResult> {
  validateEvent(input.event)
  const mode = input.mode ?? 'production_shadow'
  const polydeskEndpoint = validateLiveShadowPolydeskEndpoint(input.polydeskEndpoint, mode)
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? (() => new Date())
  const observedAt = now()
  if (!Number.isFinite(observedAt.getTime())) throw new Error('Live shadow time is invalid.')

  const [xResult, polydeskResult, hyperliquidResult] = await Promise.all([
    xComponent(input, fetcher),
    requestPolydeskMarketContext(polydeskEndpoint, input.event, fetcher)
      .then(context => ({
        status: 'ok' as const,
        data: {
          matchStatus: context.matchStatus,
          candidateCount: context.candidates.length,
          ...(context.consensus?.marketDataStatus
            ? { marketDataStatus: context.consensus.marketDataStatus }
            : {}),
          searchedAt: context.searchedAt,
        },
      }))
      .catch(() => ({ status: 'unavailable' as const, errorCode: 'provider_unavailable' as const })),
    fetchHyperliquidMarketContext(input.targetMarket, fetcher, observedAt)
      .then(context => ({
        status: 'ok' as const,
        data: {
          market: context.market,
          marketStatus: context.marketStatus,
          observedAt: context.observedAt,
          ...(positive(context.markPrice) ? { markPrice: context.markPrice } : {}),
          ...(positive(context.bestBid) ? { bestBid: context.bestBid } : {}),
          ...(positive(context.bestAsk) ? { bestAsk: context.bestAsk } : {}),
          ...(nonnegative(context.spreadBps) ? { spreadBps: context.spreadBps } : {}),
        },
      }))
      .catch(() => ({ status: 'unavailable' as const, errorCode: 'provider_unavailable' as const })),
  ])

  const components = {
    x: xResult,
    polydesk: polydeskResult,
    hyperliquid: hyperliquidResult,
  }
  const statuses = Object.values(components).map(component => component.status)
  const ok = statuses.filter(status => status === 'ok').length
  return {
    schema: 'lolah-live-shadow-v1',
    state: ok === statuses.length ? 'complete' : ok > 0 ? 'partial' : 'unavailable',
    eventId: input.event.eventId,
    targetMarket: input.targetMarket,
    observedAt: observedAt.toISOString(),
    components,
    simulationOnly: true,
    sendAllowed: false,
    executionAllowed: false,
  }
}
