import { scanLolahEvent } from './event-scan.js'
import { fetchHyperliquidMarketContext } from './hyperliquid-context.js'
import { requestPolydeskMarketContext } from './polydesk-client.js'
import type { UpbitListingEvent } from './upbit-listing-monitor.js'
import {
  assessUpbitListingScan,
  upbitListingNewsEvent,
  type UpbitMarketAssessment,
} from './upbit-shadow-replay.js'

export async function enrichLiveUpbitListing(input: {
  event: UpbitListingEvent
  symbol: string
  polydeskEndpoint: string
  fetcher?: typeof fetch
  now?: () => Date
}): Promise<UpbitMarketAssessment> {
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? (() => new Date())
  const scan = await scanLolahEvent({
    event: upbitListingNewsEvent(input.event, input.symbol),
    targetMarket: input.symbol,
    maxNewsAgeSeconds: 600,
  }, {
    getPolydeskContext: event => requestPolydeskMarketContext(input.polydeskEndpoint, event, fetcher),
    getHyperliquidContext: market => fetchHyperliquidMarketContext(market, fetcher, now()),
    now,
  })
  return assessUpbitListingScan(input.event, input.symbol, scan)
}
