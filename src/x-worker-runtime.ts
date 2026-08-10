import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { LolahDurableStateStore } from './durable-state.js'
import { expandRegistryWithHyperliquidUniverse } from './hyperliquid-universe.js'
import { runLiveReadOnlyScan } from './live-scan.js'
import { validateLiveShadowPolydeskEndpoint } from './live-shadow-runner.js'
import { preflightPolydeskMarketContext } from './polydesk-client.js'
import { validateSourceRegistry, type LolahSourceRegistry } from './source-registry.js'
import { runContinuousXIntelligenceWorker } from './x-intelligence-worker.js'
import { loadOrPinXSourceRegistry } from './x-source-pin.js'
import { XDailyUsageBudget } from './x-usage-budget.js'

export type XWorkerRuntimeState = {
  state: 'disabled' | 'preflight_unavailable' | 'enabled' | 'stopped'
  sources?: number
  entities?: number
  dailyPostCap: number
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

function value(environment: NodeJS.ProcessEnv, name: string) {
  return String(environment[name] ?? '').trim()
}

export function xWorkerRuntimeConfig(environment: NodeJS.ProcessEnv = process.env) {
  const statePath = value(environment, 'LOLAH_X_STATE_PATH')
  const dailyPostCap = Number(value(environment, 'LOLAH_X_DAILY_POST_CAP') || '50')
  if (!statePath) throw new Error('LOLAH_X_STATE_PATH is required.')
  const usagePath = value(environment, 'LOLAH_X_USAGE_PATH') || resolve(dirname(statePath), 'x-usage.json')
  return { statePath, dailyPostCap, usagePath }
}

export function createXRuntimeUsageBudget(environment: NodeJS.ProcessEnv = process.env) {
  const config = xWorkerRuntimeConfig(environment)
  return new XDailyUsageBudget(config.usagePath, config.dailyPostCap)
}

async function registry(environment: NodeJS.ProcessEnv, bearerToken: string, statePath: string) {
  const inline = value(environment, 'LOLAH_X_SOURCE_REGISTRY_JSON')
  if (inline) return validateSourceRegistry(JSON.parse(inline) as LolahSourceRegistry)
  const path = value(environment, 'LOLAH_X_SOURCE_REGISTRY_PATH')
  if (path) {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 512 * 1_024) throw new Error('X source registry is invalid.')
    return validateSourceRegistry(JSON.parse(await readFile(path, 'utf8')) as LolahSourceRegistry)
  }
  return loadOrPinXSourceRegistry({
    catalogPath: resolve(value(environment, 'LOLAH_X_SOURCE_CATALOG_PATH') || 'config/x-source-catalog.json'),
    pinPath: value(environment, 'LOLAH_X_SOURCE_PIN_PATH') || resolve(dirname(statePath), 'source-registry-pin.json'),
    bearerToken,
  })
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolveWait => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolveWait()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function state(
  current: XWorkerRuntimeState['state'],
  dailyPostCap: number,
  extra: Pick<XWorkerRuntimeState, 'sources' | 'entities'> = {},
): XWorkerRuntimeState {
  return {
    state: current, dailyPostCap, ...extra,
    simulationOnly: true, sendAllowed: false, executionAllowed: false,
  }
}

export async function runXWorkerFromEnvironment(input: {
  signal: AbortSignal
  environment?: NodeJS.ProcessEnv
  onState?: (state: XWorkerRuntimeState) => void
}) {
  const environment = input.environment ?? process.env
  const config = xWorkerRuntimeConfig(environment)
  if (value(environment, 'LOLAH_X_ENABLED') !== 'true') {
    const disabled = state('disabled', config.dailyPostCap)
    input.onState?.(disabled)
    console.log(JSON.stringify({ component: 'x_intelligence', ...disabled }))
    await wait(2_147_000_000, input.signal)
    input.onState?.(state('stopped', config.dailyPostCap))
    return
  }

  const bearerToken = value(environment, 'LOLAH_X_BEARER_TOKEN')
  const polydeskToken = value(environment, 'LOLAH_POLYDESK_CONTEXT_TOKEN')
  if (bearerToken.length < 20 || bearerToken.length > 8_192) throw new Error('LOLAH_X_BEARER_TOKEN is required.')
  if (polydeskToken.length < 32 || polydeskToken.length > 8_192) throw new Error('LOLAH_POLYDESK_CONTEXT_TOKEN is required.')
  const polydeskEndpoint = validateLiveShadowPolydeskEndpoint(
    value(environment, 'LOLAH_POLYDESK_CONTEXT_ENDPOINT'),
    'production_shadow',
  )
  const sources = await expandRegistryWithHyperliquidUniverse(await registry(environment, bearerToken, config.statePath))
  const usageBudget = new XDailyUsageBudget(config.usagePath, config.dailyPostCap)
  let failures = 0
  while (!input.signal.aborted) {
    try {
      await preflightPolydeskMarketContext(polydeskEndpoint, polydeskToken)
      break
    } catch {
      failures += 1
      const retryAfterMs = Math.min(60_000, 1_000 * 2 ** Math.min(6, failures - 1))
      const unavailable = state('preflight_unavailable', config.dailyPostCap, {
        sources: sources.sources.length, entities: sources.entities.length,
      })
      input.onState?.(unavailable)
      console.error(JSON.stringify({ component: 'x_intelligence', ...unavailable, retryAfterMs }))
      await wait(retryAfterMs, input.signal)
    }
  }
  if (input.signal.aborted) return
  const enabled = state('enabled', config.dailyPostCap, {
    sources: sources.sources.length, entities: sources.entities.length,
  })
  input.onState?.(enabled)
  console.log(JSON.stringify({ component: 'x_intelligence', ...enabled }))
  await runContinuousXIntelligenceWorker({
    registry: sources,
    bearerToken,
    store: new LolahDurableStateStore(config.statePath),
    signal: input.signal,
    usageBudget,
    scan: request => runLiveReadOnlyScan(request, {
      polydeskEndpoint,
      polydeskBearerToken: polydeskToken,
    }),
    onCycle: result => {
      if (result.postsFetched || result.eventsAccepted || result.contextCompleted || result.queriesBudgetExhausted) {
        console.log(JSON.stringify(result))
      }
    },
    onError: failure => console.error(JSON.stringify(failure)),
  })
  input.onState?.(state('stopped', config.dailyPostCap, {
    sources: sources.sources.length, entities: sources.entities.length,
  }))
}
