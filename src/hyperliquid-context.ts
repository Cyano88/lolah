import type { HyperliquidMarketContext } from './contracts.js'

type FetchLike = typeof fetch
type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function number(value: unknown) {
  const result = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(result) ? result : undefined
}

function normalizeMarket(value: string) {
  const market = value.trim()
  if (!/^(?:[a-z0-9]+:)?[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(market)) {
    throw new Error('Hyperliquid market symbol is invalid.')
  }
  const separator = market.indexOf(':')
  return separator < 0
    ? market.toUpperCase()
    : market.slice(0, separator).toLowerCase() + ':' + market.slice(separator + 1).toUpperCase()
}

async function postInfo(fetcher: FetchLike, body: JsonRecord) {
  const response = await fetcher('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error('Hyperliquid info request failed with HTTP ' + response.status + '.')
  return response.json() as Promise<unknown>
}

function bestPrice(levels: unknown, mode: 'max' | 'min') {
  if (!Array.isArray(levels)) return undefined
  const prices = levels.map(level => isRecord(level) ? number(level.px) : undefined)
    .filter((price): price is number => price !== undefined)
  if (!prices.length) return undefined
  return mode === 'max' ? Math.max(...prices) : Math.min(...prices)
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

export async function fetchHyperliquidMarketContext(
  requestedMarket: string,
  fetcher: FetchLike = fetch,
  now = new Date(),
): Promise<HyperliquidMarketContext> {
  const market = normalizeMarket(requestedMarket)
  const metaPayload = await postInfo(fetcher, { type: 'metaAndAssetCtxs' })
  if (!Array.isArray(metaPayload) || !isRecord(metaPayload[0]) || !Array.isArray(metaPayload[1])) {
    throw new Error('Hyperliquid returned an invalid market metadata response.')
  }
  const universe = Array.isArray(metaPayload[0].universe) ? metaPayload[0].universe : []
  const index = universe.findIndex(item => isRecord(item) && String(item.name ?? '').toUpperCase() === market.toUpperCase())
  if (index < 0) {
    return {
      schema: 'lolah-hyperliquid-context-v1',
      venue: 'hyperliquid',
      market,
      marketStatus: 'not_found',
      observedAt: now.toISOString(),
    }
  }
  const context = isRecord(metaPayload[1][index]) ? metaPayload[1][index] : {}
  const officialName = isRecord(universe[index]) ? String(universe[index].name ?? market) : market
  const bookPayload = await postInfo(fetcher, { type: 'l2Book', coin: officialName })
  const levels = isRecord(bookPayload) && Array.isArray(bookPayload.levels) ? bookPayload.levels : []
  const bestBid = bestPrice(levels[0], 'max')
  const bestAsk = bestPrice(levels[1], 'min')
  const midpoint = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined
  const spreadBps = midpoint && midpoint > 0 && bestBid !== undefined && bestAsk !== undefined
    ? round(((bestAsk - bestBid) / midpoint) * 10_000)
    : undefined
  const markPrice = number(context.markPx)
  const previousDayPrice = number(context.prevDayPx)
  return {
    schema: 'lolah-hyperliquid-context-v1',
    venue: 'hyperliquid',
    market: officialName,
    marketStatus: 'available',
    observedAt: now.toISOString(),
    markPrice,
    oraclePrice: number(context.oraclePx),
    previousDayPrice,
    dayChangeFraction: markPrice !== undefined && previousDayPrice && previousDayPrice > 0
      ? round((markPrice - previousDayPrice) / previousDayPrice)
      : undefined,
    fundingRate: number(context.funding),
    openInterestBase: number(context.openInterest),
    bestBid,
    bestAsk,
    spreadBps,
  }
}
