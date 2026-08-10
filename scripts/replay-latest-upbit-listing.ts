import { scanLolahEvent } from '../src/event-scan.js'
import { fetchHyperliquidHistoricalReplayContext } from '../src/hyperliquid-context.js'
import { requestPolydeskMarketContext } from '../src/polydesk-client.js'
import {
  fetchLatestCoinListingUpbitListing,
  runUpbitHistoricalShadowReplay,
} from '../src/upbit-shadow-replay.js'

const item = await fetchLatestCoinListingUpbitListing(fetch, process.env.LOLAH_REPLAY_SYMBOL)
const result = await runUpbitHistoricalShadowReplay({
  item,
  simulatedTransportDelayMs: 250,
  scan: request => scanLolahEvent(request, {
    getPolydeskContext: event => requestPolydeskMarketContext(
      process.env.POLYDESK_CONTEXT_ENDPOINT ?? 'https://polydesk.trade/api/agent/polymarket-context',
      event,
    ),
    getHyperliquidContext: market => fetchHyperliquidHistoricalReplayContext(
      market,
      new Date(request.event.detectedAt),
    ),
    now: () => new Date(item.sent_time + 1_000),
  }),
})

console.log(JSON.stringify(result, null, 2))
if (result.assessments.every(item => item.state === 'provider_unavailable')) process.exitCode = 1
