import { runUpbitWorkerFromEnvironment } from '../src/upbit-worker-runtime.js'

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

await runUpbitWorkerFromEnvironment({
  signal: controller.signal,
  environment: {
    ...process.env,
    LOLAH_UPBIT_ENABLED: process.env.LOLAH_UPBIT_ENABLED ?? 'true',
  },
})
