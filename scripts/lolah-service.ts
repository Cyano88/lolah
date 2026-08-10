import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { createLolahPublicNodeHandler } from '../src/public-node-adapter.js'
import { runSupervisedRuntime } from '../src/runtime-supervisor.js'
import {
  runUpbitWorkerFromEnvironment,
  upbitWorkerRuntimeConfig,
  type UpbitWorkerRuntimeState,
} from '../src/upbit-worker-runtime.js'
import {
  createXRuntimeUsageBudget,
  runXWorkerFromEnvironment,
  xWorkerRuntimeConfig,
  type XWorkerRuntimeState,
} from '../src/x-worker-runtime.js'

const port = Number(String(process.env.PORT ?? '10000').trim())
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid.')
const xConfig = xWorkerRuntimeConfig()
const upbitEnabled = String(process.env.LOLAH_UPBIT_ENABLED ?? '').trim() === 'true'
const serviceEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  LOLAH_UPBIT_STATE_PATH: process.env.LOLAH_UPBIT_STATE_PATH
    || (upbitEnabled ? '' : resolve(dirname(xConfig.statePath), 'upbit-state.json')),
}
const upbitConfig = upbitWorkerRuntimeConfig(serviceEnvironment)
if (resolve(xConfig.statePath) === resolve(upbitConfig.statePath)) {
  throw new Error('X and Upbit workers require separate state files.')
}
const usageBudget = createXRuntimeUsageBudget()
let xRuntimeState: XWorkerRuntimeState = {
  state: 'disabled', dailyPostCap: xConfig.dailyPostCap,
  simulationOnly: true, sendAllowed: false, executionAllowed: false,
}
let upbitRuntimeState: UpbitWorkerRuntimeState = {
  state: 'disabled', provider: 'disabled', enrichment: 'disabled',
  simulationOnly: true, sendAllowed: false, executionAllowed: false,
}
const controller = new AbortController()
const handler = createLolahPublicNodeHandler({
  runtimeStates: () => ({ x: xRuntimeState, upbit: upbitRuntimeState }),
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
  await Promise.all([
    runSupervisedRuntime({
      component: 'x_intelligence', signal: controller.signal,
      run: () => runXWorkerFromEnvironment({
        signal: controller.signal,
        onState: state => { xRuntimeState = state },
      }),
      onFailure: () => {
        xRuntimeState = { ...xRuntimeState, state: 'preflight_unavailable' }
      },
    }),
    runSupervisedRuntime({
      component: 'upbit_monitor', signal: controller.signal,
      run: () => runUpbitWorkerFromEnvironment({
        signal: controller.signal,
        environment: serviceEnvironment,
        onState: state => { upbitRuntimeState = state },
      }),
      onFailure: () => {
        upbitRuntimeState = { ...upbitRuntimeState, state: 'unavailable' }
      },
    }),
  ])
} finally {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
}
