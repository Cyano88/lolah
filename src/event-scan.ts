import type { HyperliquidMarketContext, LolahEventScan, LolahNewsEvent, PolydeskMarketContext } from './contracts.js'

export type LolahScanRequest = {
  event: LolahNewsEvent
  targetMarket: string
  maxNewsAgeSeconds?: number
}

export type LolahScanDependencies = {
  getPolydeskContext: (event: LolahNewsEvent) => Promise<PolydeskMarketContext>
  getHyperliquidContext: (market: string) => Promise<HyperliquidMarketContext>
  now: () => Date
}

function validEvent(event: LolahNewsEvent) {
  if (event.schema !== 'lolah-news-event-v1') throw new Error('Lolah event schema is unsupported.')
  if (!event.eventId.startsWith('evt_')) throw new Error('Lolah eventId is invalid.')
  if (!event.entities.length) throw new Error('Lolah event requires at least one entity.')
  if (!Number.isFinite(Date.parse(event.detectedAt))) throw new Error('Lolah event detectedAt is invalid.')
}

export async function scanLolahEvent(
  request: LolahScanRequest,
  dependencies: LolahScanDependencies,
): Promise<LolahEventScan> {
  validEvent(request.event)
  const observedAt = dependencies.now()
  const maxAge = Math.max(30, Math.min(request.maxNewsAgeSeconds ?? 600, 86_400))
  const ageMs = observedAt.getTime() - Date.parse(request.event.detectedAt)
  const [polydesk, hyperliquid] = await Promise.all([
    dependencies.getPolydeskContext(request.event),
    dependencies.getHyperliquidContext(request.targetMarket),
  ])
  const common = {
    schema: 'lolah-event-scan-v1' as const,
    eventId: request.event.eventId,
    executionAllowed: false as const,
    polydesk,
    hyperliquid,
    observedAt: observedAt.toISOString(),
  }
  if (ageMs < -30_000 || ageMs > maxAge * 1_000) {
    return { ...common, state: 'no_trade', reason: 'The news event is stale or has an invalid detection time.', confidenceAdjustment: 'blocked' }
  }
  if (request.event.verification.status === 'unverified') {
    return { ...common, state: 'watch', reason: 'The event is unverified and cannot support an actionable thesis.', confidenceAdjustment: 'blocked' }
  }
  if (polydesk.matchStatus === 'ambiguous') {
    return { ...common, state: 'no_trade', reason: 'PolyDesk found similarly relevant markets and blocked an arbitrary match.', confidenceAdjustment: 'blocked' }
  }
  if (hyperliquid.marketStatus === 'not_found') {
    return { ...common, state: 'no_trade', reason: 'The requested Hyperliquid market is unavailable.', confidenceAdjustment: 'blocked' }
  }
  if (polydesk.matchStatus === 'no_relevant_market') {
    return {
      ...common,
      state: 'context_ready',
      reason: 'Verified news and Hyperliquid context are available, but PolyDesk found no relevant active market.',
      confidenceAdjustment: 'reduced',
    }
  }
  if (polydesk.consensus?.marketDataStatus !== 'complete') {
    return {
      ...common,
      state: 'context_ready',
      reason: 'PolyDesk matched a market, but current order-book or historical data is incomplete.',
      confidenceAdjustment: 'reduced',
    }
  }
  return {
    ...common,
    state: 'context_ready',
    reason: 'Verified news, PolyDesk market consensus, and Hyperliquid market context are available for thesis generation.',
    confidenceAdjustment: 'normal',
  }
}
