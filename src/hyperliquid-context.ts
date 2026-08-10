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

function bestLevel(levels: unknown, mode: 'max' | 'min') {
  if (!Array.isArray(levels)) return undefined
  const parsed = levels.map(level => isRecord(level)
    ? { price: number(level.px), size: number(level.sz) }
    : undefined)
    .filter((level): level is { price: number; size: number | undefined } => level?.price !== undefined)
  if (!parsed.length) return undefined
  return parsed.reduce((best, level) => mode === 'max'
    ? level.price > best.price ? level : best
    : level.price < best.price ? level : best)
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
  const bid = bestLevel(levels[0], 'max')
  const ask = bestLevel(levels[1], 'min')
  const bestBid = bid?.price
  const bestAsk = ask?.price
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
    bestBidSizeBase: bid?.size,
    bestAskSizeBase: ask?.size,
    nearTouchLiquidityUsd: bid?.size !== undefined && ask?.size !== undefined
      ? round(bestBid! * bid.size + bestAsk! * ask.size)
      : undefined,
    spreadBps,
  }
}

export async function fetchHyperliquidHistoricalReplayContext(
  requestedMarket: string,
  eventAt: Date,
  fetcher: FetchLike = fetch,
): Promise<HyperliquidMarketContext> {
  const market = normalizeMarket(requestedMarket)
  const eventMs = eventAt.getTime()
  if (!Number.isFinite(eventMs)) throw new Error('Hyperliquid replay time is invalid.')
  const metaPayload = await postInfo(fetcher, { type: 'metaAndAssetCtxs' })
  if (!Array.isArray(metaPayload) || !isRecord(metaPayload[0]) || !Array.isArray(metaPayload[1])) {
    throw new Error('Hyperliquid returned an invalid market metadata response.')
  }
  const universe = Array.isArray(metaPayload[0].universe) ? metaPayload[0].universe : []
  const marketEntry = universe.find(item => isRecord(item)
    && String(item.name ?? '').toUpperCase() === market.toUpperCase())
  if (!isRecord(marketEntry)) {
    return {
      schema: 'lolah-hyperliquid-context-v1', venue: 'hyperliquid', market,
      marketStatus: 'not_found', observedAt: eventAt.toISOString(),
      contextMode: 'historical_replay', historicalLiquidityAvailable: false,
    }
  }
  const officialName = String(marketEntry.name ?? market)
  const candlePayload = await postInfo(fetcher, {
    type: 'candleSnapshot',
    req: {
      coin: officialName,
      interval: '5m',
      startTime: eventMs - 24 * 60 * 60_000,
      endTime: eventMs + 10 * 60_000,
    },
  })
  if (!Array.isArray(candlePayload)) throw new Error('Hyperliquid returned invalid replay candles.')
  const candles = candlePayload.map(value => isRecord(value) ? {
    start: number(value.t), end: number(value.T), close: number(value.c),
  } : undefined).filter((value): value is { start: number; end: number; close: number } =>
    value?.start !== undefined && value.end !== undefined && value.close !== undefined && value.close > 0)
    .sort((left, right) => left.start - right.start)
  const before = [...candles].reverse().find(candle => candle.end < eventMs)
  const after = candles.find(candle => candle.start <= eventMs && candle.end >= eventMs)
  if (!before || !after) throw new Error('Hyperliquid replay candles do not bracket the listing event.')
  return {
    schema: 'lolah-hyperliquid-context-v1', venue: 'hyperliquid', market: officialName,
    marketStatus: 'available', observedAt: new Date(after.end).toISOString(),
    markPrice: after.close, contextMode: 'historical_replay',
    eventReferencePrice: before.close,
    eventMoveFraction: round((after.close - before.close) / before.close),
    replayWindowMinutes: 5,
    historicalLiquidityAvailable: false,
  }
}
