import type { LolahEventScan } from './contracts.js'
import { scanLolahEvent, type LolahScanRequest } from './event-scan.js'
import { fetchHyperliquidMarketContext } from './hyperliquid-context.js'
import { requestPolydeskMarketContext } from './polydesk-client.js'

export type LiveLolahScanOptions = {
  polydeskEndpoint: string
  polydeskBearerToken?: string
  fetcher?: typeof fetch
  now?: () => Date
}

export async function runLiveReadOnlyScan(
  request: LolahScanRequest,
  options: LiveLolahScanOptions,
): Promise<LolahEventScan> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? (() => new Date())
  return scanLolahEvent(request, {
    getPolydeskContext: event => requestPolydeskMarketContext(
      options.polydeskEndpoint, event, fetcher, options.polydeskBearerToken,
    ),
    getHyperliquidContext: market => fetchHyperliquidMarketContext(market, fetcher, now()),
    now,
  })
}
