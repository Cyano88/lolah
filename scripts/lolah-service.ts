import { createServer } from 'node:http'
import { createLolahPublicNodeHandler } from '../src/public-node-adapter.js'
import {
  createXRuntimeUsageBudget,
  runXWorkerFromEnvironment,
  xWorkerRuntimeConfig,
  type XWorkerRuntimeState,
} from '../src/x-worker-runtime.js'

const port = Number(String(process.env.PORT ?? '10000').trim())
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid.')
const config = xWorkerRuntimeConfig()
const usageBudget = createXRuntimeUsageBudget()
let runtimeState: XWorkerRuntimeState = {
  state: 'disabled', dailyPostCap: config.dailyPostCap,
  simulationOnly: true, sendAllowed: false, executionAllowed: false,
}
const controller = new AbortController()
const handler = createLolahPublicNodeHandler({
  runtimeState: () => runtimeState,
  usage: () => usageBudget.snapshot(),
})
const server = createServer((request, response) => void handler(request, response))

await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen)
  server.listen(port, '0.0.0.0', () => resolveListen())
})
console.log(JSON.stringify({ component: 'lolah_service', state: 'listening', port, publicAlertRoutes: false }))

const shutdown = () => controller.abort()
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

try {
  await runXWorkerFromEnvironment({
    signal: controller.signal,
    onState: state => { runtimeState = state },
  })
} finally {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
}
