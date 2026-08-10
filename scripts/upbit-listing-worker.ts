import { UpbitListingWorkerStore, runContinuousUpbitListingWorker } from '../src/upbit-listing-worker.js'

const statePath = String(process.env.LOLAH_UPBIT_STATE_PATH ?? '').trim()
if (!statePath) throw new Error('LOLAH_UPBIT_STATE_PATH is required.')

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

await runContinuousUpbitListingWorker({
  store: new UpbitListingWorkerStore(statePath),
  signal: controller.signal,
  onCycle: result => {
    if (result.eventsObserved > 0 || result.alertsPrepared > 0) {
      console.log(JSON.stringify(result))
    }
  },
})
