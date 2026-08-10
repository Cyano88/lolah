import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { LolahDurableStateStore } from '../src/durable-state.js'
import { expandRegistryWithHyperliquidUniverse } from '../src/hyperliquid-universe.js'
import { runLiveReadOnlyScan } from '../src/live-scan.js'
import { validateLiveShadowPolydeskEndpoint } from '../src/live-shadow-runner.js'
import { preflightPolydeskMarketContext } from '../src/polydesk-client.js'
import { validateSourceRegistry, type LolahSourceRegistry } from '../src/source-registry.js'
import { runContinuousXIntelligenceWorker } from '../src/x-intelligence-worker.js'
import { loadOrPinXSourceRegistry } from '../src/x-source-pin.js'

function value(name: string) {
  return String(process.env[name] ?? '').trim()
}

async function registry(bearerToken: string, statePath: string) {
  const inline = value('LOLAH_X_SOURCE_REGISTRY_JSON')
  if (inline) return validateSourceRegistry(JSON.parse(inline) as LolahSourceRegistry)
  const path = value('LOLAH_X_SOURCE_REGISTRY_PATH')
  if (path) {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 512 * 1_024) throw new Error('X source registry is invalid.')
    return validateSourceRegistry(JSON.parse(await readFile(path, 'utf8')) as LolahSourceRegistry)
  }
  return loadOrPinXSourceRegistry({
    catalogPath: resolve(value('LOLAH_X_SOURCE_CATALOG_PATH') || 'config/x-source-catalog.json'),
    pinPath: value('LOLAH_X_SOURCE_PIN_PATH') || resolve(dirname(statePath), 'source-registry-pin.json'),
    bearerToken,
  })
}

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

function waitForAbort() {
  return new Promise<void>(resolve => {
    const keepAlive = setInterval(() => undefined, 60_000)
    const finish = () => {
      clearInterval(keepAlive)
      resolve()
    }
    if (controller.signal.aborted) finish()
    else controller.signal.addEventListener('abort', finish, { once: true })
  })
}

async function start() {
  const statePath = value('LOLAH_X_STATE_PATH')
  const bearerToken = value('LOLAH_X_BEARER_TOKEN')
  const polydeskToken = value('LOLAH_POLYDESK_CONTEXT_TOKEN')
  if (!statePath) throw new Error('LOLAH_X_STATE_PATH is required.')
  if (bearerToken.length < 20 || bearerToken.length > 8_192) throw new Error('LOLAH_X_BEARER_TOKEN is required.')
  if (polydeskToken.length < 32 || polydeskToken.length > 8_192) throw new Error('LOLAH_POLYDESK_CONTEXT_TOKEN is required.')
  const polydeskEndpoint = validateLiveShadowPolydeskEndpoint(
    value('LOLAH_POLYDESK_CONTEXT_ENDPOINT'),
    'production_shadow',
  )
  const sources = await expandRegistryWithHyperliquidUniverse(await registry(bearerToken, statePath))
  let failures = 0
  while (!controller.signal.aborted) {
    try {
      await preflightPolydeskMarketContext(polydeskEndpoint, polydeskToken)
      break
    } catch {
      failures += 1
      const retryAfterMs = Math.min(60_000, 1_000 * 2 ** Math.min(6, failures - 1))
      console.error(JSON.stringify({ component: 'x_intelligence', state: 'preflight_unavailable', retryAfterMs }))
      await new Promise(resolve => setTimeout(resolve, retryAfterMs))
    }
  }
  if (controller.signal.aborted) return
  console.log(JSON.stringify({
    component: 'x_intelligence', state: 'enabled', sources: sources.sources.length,
    entities: sources.entities.length, simulationOnly: true, sendAllowed: false, executionAllowed: false,
  }))
  const store = new LolahDurableStateStore(statePath)
  await runContinuousXIntelligenceWorker({
    registry: sources,
    bearerToken,
    store,
    signal: controller.signal,
    scan: request => runLiveReadOnlyScan(request, {
      polydeskEndpoint,
      polydeskBearerToken: polydeskToken,
    }),
    onCycle: result => {
      if (result.postsFetched || result.eventsAccepted || result.contextCompleted) {
        console.log(JSON.stringify(result))
      }
    },
    onError: failure => console.error(JSON.stringify(failure)),
  })
}

if (value('LOLAH_X_ENABLED') !== 'true') {
  console.log(JSON.stringify({ component: 'x_intelligence', state: 'disabled', simulationOnly: true }))
  await waitForAbort()
} else {
  await start()
}
