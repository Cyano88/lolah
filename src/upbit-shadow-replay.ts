import type { HyperliquidMarketContext, LolahEventScan, LolahNewsEvent } from './contracts.js'
import { parseCoinListingFrame } from './coinlisting-upbit-source.js'
import type { LolahScanRequest } from './event-scan.js'
import type { UpbitListingEvent } from './upbit-listing-monitor.js'

const HISTORY_ENDPOINT = 'https://tokyo.coinlisting.pro/history?source=UPBIT&limit=20'

type JsonRecord = Record<string, unknown>

export type CoinListingHistoryItem = {
  source: 'UPBIT'
  title: string
  url: string
  detected_at_iso: string
  sent_time: number
  sent_time_iso?: string
  coins?: string[]
}

export type UpbitReplayAssessment = {
  symbol: string
  targetMarket: string
  state: LolahEventScan['state'] | 'provider_unavailable'
  marketPosture: 'positive_catalyst_watch' | 'chasing_risk' | 'weakness_watch'
    | 'market_unavailable' | 'risk_blocked' | 'context_unavailable'
  liquidityAssessment: 'adequate' | 'thin' | 'unknown'
  reason: string
  scan?: LolahEventScan
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

export type UpbitHistoricalReplayResult = {
  schema: 'lolah-upbit-shadow-replay-v1'
  mode: 'historical_replay'
  provider: 'coinlisting_public_history'
  event: UpbitListingEvent
  receiptTiming: {
    basis: 'provider_sent_time_plus_simulated_transport_delay'
    simulatedTransportDelayMs: number
    measuredLiveLatency: false
  }
  contextTiming: {
    hyperliquid: 'historical_five_minute_candles'
    polydesk: 'current_active_markets'
    historicalLiquidityAvailable: false
  }
  assessments: UpbitReplayAssessment[]
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function historyItem(value: unknown): CoinListingHistoryItem {
  if (!isRecord(value) || value.source !== 'UPBIT' || typeof value.title !== 'string'
    || typeof value.url !== 'string' || typeof value.detected_at_iso !== 'string'
    || !Number.isInteger(value.sent_time)) {
    throw new Error('CoinListing history item is invalid.')
  }
  if (value.coins !== undefined && (!Array.isArray(value.coins)
    || value.coins.some(coin => typeof coin !== 'string'))) {
    throw new Error('CoinListing history coins are invalid.')
  }
  return {
    source: 'UPBIT', title: value.title, url: value.url,
    detected_at_iso: value.detected_at_iso, sent_time: Number(value.sent_time),
    ...(typeof value.sent_time_iso === 'string' ? { sent_time_iso: value.sent_time_iso } : {}),
    ...(Array.isArray(value.coins) ? { coins: value.coins as string[] } : {}),
  }
}

export async function fetchLatestCoinListingUpbitListing(
  fetcher: typeof fetch = fetch,
  preferredSymbol?: string,
) {
  const preferred = preferredSymbol?.trim().toUpperCase()
  if (preferred && !/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(preferred)) {
    throw new Error('CoinListing replay symbol is invalid.')
  }
  const response = await fetcher(HISTORY_ENDPOINT, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error('CoinListing history failed with HTTP ' + response.status + '.')
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.items) || payload.items.length > 100) {
    throw new Error('CoinListing history response is invalid.')
  }
  for (const raw of payload.items) {
    const item = historyItem(raw)
    const event = parseCoinListingFrame({
      text: JSON.stringify(item), receivedAt: new Date(item.sent_time + 250),
    })
    if (event?.status === 'new_listing' && (!preferred || event.symbols.includes(preferred))) return item
  }
  throw new Error(preferred
    ? 'CoinListing history contains no supported Upbit listing for the requested symbol.'
    : 'CoinListing history contains no supported Upbit listing.')
}

export function upbitListingNewsEvent(event: UpbitListingEvent, symbol: string): LolahNewsEvent {
  const normalized = symbol.trim().toUpperCase()
  if (!event.symbols.includes(normalized)) throw new Error('Replay symbol is not part of the Upbit event.')
  return {
    schema: 'lolah-news-event-v1',
    eventId: 'evt_upbit_' + event.noticeId + '_' + normalized.toLowerCase(),
    headline: event.title,
    summary: normalized + ' received new Upbit market support in ' + event.quoteMarkets.join(', ') + '.',
    publisher: 'Upbit', sourceUrl: event.sourceUrl,
    publishedAt: event.firstPublishedAt, detectedAt: event.detectedAt,
    entities: [normalized], eventType: 'listing',
    verification: { status: 'official_source', supportingSources: [] },
  }
}

function liquidity(context: HyperliquidMarketContext): UpbitReplayAssessment['liquidityAssessment'] {
  if (context.marketStatus !== 'available'
    || context.nearTouchLiquidityUsd === undefined || context.spreadBps === undefined) return 'unknown'
  return context.nearTouchLiquidityUsd < 10_000 || context.spreadBps > 100 ? 'thin' : 'adequate'
}

function assessment(event: UpbitListingEvent, symbol: string, scan: LolahEventScan): UpbitReplayAssessment {
  const common = {
    symbol, targetMarket: symbol, state: scan.state,
    liquidityAssessment: liquidity(scan.hyperliquid), scan,
    simulationOnly: true as const, sendAllowed: false as const, executionAllowed: false as const,
  }
  if (scan.hyperliquid.marketStatus === 'not_found') {
    return { ...common, marketPosture: 'market_unavailable', reason: 'Hyperliquid has no matching perp market.' }
  }
  if (scan.state === 'no_trade' || scan.confidenceAdjustment === 'blocked') {
    return { ...common, marketPosture: 'risk_blocked', reason: scan.reason }
  }
  const change = scan.hyperliquid.eventMoveFraction ?? scan.hyperliquid.dayChangeFraction
  if (event.freshness === 'late' || (change !== undefined && change >= 0.10)) {
    return {
      ...common, marketPosture: 'chasing_risk',
      reason: event.freshness === 'late'
        ? 'The listing signal arrived outside the freshness window.'
        : 'The market is already at least 10% above its pre-event reference price.',
    }
  }
  if (change !== undefined && change <= -0.03) {
    return {
      ...common, marketPosture: 'weakness_watch',
      reason: 'The verified listing catalyst is present, but price is at least 3% below its pre-event reference.',
    }
  }
  return {
    ...common, marketPosture: 'positive_catalyst_watch',
    reason: 'The verified listing is fresh and the market has not crossed the 10% chasing threshold.',
  }
}

export async function runUpbitHistoricalShadowReplay(input: {
  item: CoinListingHistoryItem
  simulatedTransportDelayMs?: number
  scan: (request: LolahScanRequest) => Promise<LolahEventScan>
}): Promise<UpbitHistoricalReplayResult> {
  const delay = input.simulatedTransportDelayMs ?? 250
  if (!Number.isInteger(delay) || delay < 0 || delay > 5_000) {
    throw new Error('Replay transport delay must be 0 through 5000 milliseconds.')
  }
  const event = parseCoinListingFrame({
    text: JSON.stringify(input.item), receivedAt: new Date(input.item.sent_time + delay),
  })
  if (!event) throw new Error('CoinListing history item is not a supported Upbit listing.')
  const assessments = await Promise.all(event.symbols.map(async symbol => {
    try {
      const scan = await input.scan({
        event: upbitListingNewsEvent(event, symbol), targetMarket: symbol, maxNewsAgeSeconds: 600,
      })
      return assessment(event, symbol, scan)
    } catch {
      return {
        symbol, targetMarket: symbol, state: 'provider_unavailable' as const,
        marketPosture: 'context_unavailable' as const, liquidityAssessment: 'unknown' as const,
        reason: 'A context provider was unavailable; the replay failed closed.',
        simulationOnly: true as const, sendAllowed: false as const, executionAllowed: false as const,
      }
    }
  }))
  return {
    schema: 'lolah-upbit-shadow-replay-v1', mode: 'historical_replay',
    provider: 'coinlisting_public_history', event,
    receiptTiming: {
      basis: 'provider_sent_time_plus_simulated_transport_delay',
      simulatedTransportDelayMs: delay, measuredLiveLatency: false,
    },
    contextTiming: {
      hyperliquid: 'historical_five_minute_candles',
      polydesk: 'current_active_markets',
      historicalLiquidityAvailable: false,
    },
    assessments, simulationOnly: true, sendAllowed: false, executionAllowed: false,
  }
}

export const COINLISTING_UPBIT_HISTORY_ENDPOINT = HISTORY_ENDPOINT
