import {
  UpbitListingWorkerStore,
  runContinuousUpbitEnrichmentWorker,
  runContinuousUpbitListingWorker,
} from '../src/upbit-listing-worker.js'
import {
  COINLISTING_UPBIT_ENDPOINT,
  CoinListingUpbitSource,
  coinListingFrames,
} from '../src/coinlisting-upbit-source.js'
import type { UpbitCoinListingSnapshot } from '../src/upbit-listing-source.js'
import { enrichLiveUpbitListing } from '../src/upbit-live-enrichment.js'
import { validateLiveShadowPolydeskEndpoint } from '../src/live-shadow-runner.js'

const statePath = String(process.env.LOLAH_UPBIT_STATE_PATH ?? '').trim()
if (!statePath) throw new Error('LOLAH_UPBIT_STATE_PATH is required.')
const source = String(process.env.LOLAH_UPBIT_SOURCE ?? '').trim()
if (source !== 'coinlisting') throw new Error('LOLAH_UPBIT_SOURCE must be coinlisting in deployed mode.')
const apiKey = String(process.env.LOLAH_COINLISTING_KEY ?? '').trim()
const endpoint = String(process.env.LOLAH_COINLISTING_ENDPOINT ?? COINLISTING_UPBIT_ENDPOINT).trim()

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

const store = new UpbitListingWorkerStore(statePath)
const snapshot = await store.getMonitorSnapshot()
const frames = coinListingFrames({
  apiKey,
  endpoint,
  signal: controller.signal,
  onStatus: status => console.log(JSON.stringify({ provider: 'coinlisting', ...status })),
})
const coinListing = new CoinListingUpbitSource(
  frames,
  snapshot?.schema === 'lolah-upbit-coinlisting-state-v1' ? snapshot as UpbitCoinListingSnapshot : undefined,
)

const enrichmentEnabled = String(process.env.LOLAH_UPBIT_ENRICHMENT_ENABLED ?? '').trim() === 'true'
const polydeskEndpoint = enrichmentEnabled
  ? validateLiveShadowPolydeskEndpoint(
      String(process.env.LOLAH_POLYDESK_CONTEXT_ENDPOINT ?? '').trim(),
      'production_shadow',
    )
  : undefined

const listingWorker = runContinuousUpbitListingWorker({
  store,
  signal: controller.signal,
  source: coinListing,
  onCycle: result => {
    if (result.eventsObserved > 0 || result.alertsPrepared > 0) {
      console.log(JSON.stringify(result))
    }
  },
  onError: failure => console.error(JSON.stringify(failure)),
})

if (!enrichmentEnabled) {
  console.log(JSON.stringify({ component: 'upbit_enrichment', state: 'disabled' }))
  await listingWorker
} else {
  if (!polydeskEndpoint) throw new Error('LOLAH_POLYDESK_CONTEXT_ENDPOINT is required.')
  const enrichmentWorker = runContinuousUpbitEnrichmentWorker({
    store,
    signal: controller.signal,
    enrich: (event, symbol) => enrichLiveUpbitListing({ event, symbol, polydeskEndpoint }),
    onCycle: result => console.log(JSON.stringify(result)),
    onError: failure => console.error(JSON.stringify(failure)),
  })
  console.log(JSON.stringify({ component: 'upbit_enrichment', state: 'enabled' }))
  await Promise.all([listingWorker, enrichmentWorker])
}
