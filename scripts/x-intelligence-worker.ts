import { runXWorkerFromEnvironment } from '../src/x-worker-runtime.js'

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

await runXWorkerFromEnvironment({ signal: controller.signal })
