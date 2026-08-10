export type LolahVerificationStatus = 'official_source' | 'corroborated' | 'unverified'

export type LolahEventType =
  | 'exploit'
  | 'shutdown'
  | 'delisting'
  | 'listing'
  | 'token_unlock'
  | 'acquisition'
  | 'lawsuit'
  | 'regulatory_action'
  | 'leadership_change'
  | 'partnership'
  | 'governance_decision'
  | 'network_outage'

export type LolahNewsEvent = {
  schema: 'lolah-news-event-v1'
  eventId: string
  headline: string
  summary?: string
  publisher: string
  sourceUrl: string
  publishedAt: string
  detectedAt: string
  entities: string[]
  eventType: LolahEventType
  verification: {
    status: LolahVerificationStatus
    supportingSources: string[]
  }
}

export type PolydeskMarketContext = {
  schema: 'polydesk-market-context-v1'
  provider: 'polydesk'
  eventId: string
  matchStatus: 'matched' | 'ambiguous' | 'no_relevant_market'
  searchedAt: string
  reason?: string
  confidenceAdjustment?: 'reduce' | 'block_trade'
  match?: { question: string; matchConfidence: number; marketUrl?: string }
  consensus?: {
    marketDataStatus: 'complete' | 'partial'
    outcome?: string
    probabilityNow?: number
    probabilityBeforeNews?: number
    probabilityChange?: number
    bestBid?: number
    bestAsk?: number
    spread?: number
    nearTouchDepthShares?: number
    volumeUsd?: number
    liquidityUsd?: number
    openInterestUsd?: number
    observedAt: string
  }
  candidates: Array<{ question: string; matchConfidence: number; marketUrl?: string }>
}

export type HyperliquidMarketContext = {
  schema: 'lolah-hyperliquid-context-v1'
  venue: 'hyperliquid'
  market: string
  marketStatus: 'available' | 'not_found'
  observedAt: string
  markPrice?: number
  oraclePrice?: number
  previousDayPrice?: number
  dayChangeFraction?: number
  fundingRate?: number
  openInterestBase?: number
  bestBid?: number
  bestAsk?: number
  bestBidSizeBase?: number
  bestAskSizeBase?: number
  nearTouchLiquidityUsd?: number
  spreadBps?: number
  contextMode?: 'live' | 'historical_replay'
  eventReferencePrice?: number
  eventMoveFraction?: number
  replayWindowMinutes?: number
  historicalLiquidityAvailable?: false
}

export type LolahEventScan = {
  schema: 'lolah-event-scan-v1'
  eventId: string
  state: 'context_ready' | 'watch' | 'no_trade'
  reason: string
  confidenceAdjustment: 'normal' | 'reduced' | 'blocked'
  executionAllowed: false
  polydesk: PolydeskMarketContext
  hyperliquid: HyperliquidMarketContext
  observedAt: string
}
