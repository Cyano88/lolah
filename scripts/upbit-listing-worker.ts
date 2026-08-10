import { UpbitListingWorkerStore, runContinuousUpbitListingWorker } from '../src/upbit-listing-worker.js'
import { UpbitSignedRelay } from '../src/upbit-signed-relay.js'
import type { UpbitSignedRelaySnapshot } from '../src/upbit-listing-source.js'

const statePath = String(process.env.LOLAH_UPBIT_STATE_PATH ?? '').trim()
if (!statePath) throw new Error('LOLAH_UPBIT_STATE_PATH is required.')
const source = String(process.env.LOLAH_UPBIT_SOURCE ?? '').trim()
if (source !== 'signed_relay') throw new Error('LOLAH_UPBIT_SOURCE must be signed_relay in deployed mode.')
const relayUrl = String(process.env.LOLAH_UPBIT_RELAY_URL ?? '').trim()
const relayPublicKey = String(process.env.LOLAH_UPBIT_RELAY_PUBLIC_KEY_SPKI_BASE64 ?? '').trim()

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

await runContinuousUpbitListingWorker({
  store: new UpbitListingWorkerStore(statePath),
  signal: controller.signal,
  sourceFactory: snapshot => new UpbitSignedRelay(
    relayUrl,
    relayPublicKey,
    fetch,
    snapshot?.schema === 'lolah-upbit-relay-state-v1' ? snapshot as UpbitSignedRelaySnapshot : undefined,
  ),
  onCycle: result => {
    if (result.eventsObserved > 0 || result.alertsPrepared > 0) {
      console.log(JSON.stringify(result))
    }
  },
  onError: failure => console.error(JSON.stringify(failure)),
})
