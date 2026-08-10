import {
  UpbitListingWorkerStore,
  runContinuousUpbitEnrichmentWorker,
  runContinuousUpbitListingWorker,
} from './upbit-listing-worker.js'
import {
  COINLISTING_UPBIT_ENDPOINT,
  CoinListingUpbitSource,
  coinListingFrames,
} from './coinlisting-upbit-source.js'
import type { UpbitCoinListingSnapshot } from './upbit-listing-source.js'
import { enrichLiveUpbitListing } from './upbit-live-enrichment.js'
import { validateLiveShadowPolydeskEndpoint } from './live-shadow-runner.js'
import { preflightPolydeskMarketContext } from './polydesk-client.js'

export type UpbitWorkerRuntimeState = {
  state: 'disabled' | 'running' | 'unavailable' | 'stopped'
  provider: 'disabled' | 'connecting' | 'connected' | 'reconnecting'
  enrichment: 'disabled' | 'preflight_unavailable' | 'enabled'
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

function value(environment: NodeJS.ProcessEnv, name: string) {
  return String(environment[name] ?? '').trim()
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

function state(input: Pick<UpbitWorkerRuntimeState, 'state' | 'provider' | 'enrichment'>): UpbitWorkerRuntimeState {
  return {
    ...input,
    simulationOnly: true,
    sendAllowed: false,
    executionAllowed: false,
  }
}

export function upbitWorkerRuntimeConfig(environment: NodeJS.ProcessEnv = process.env) {
  const statePath = value(environment, 'LOLAH_UPBIT_STATE_PATH')
  if (!statePath) throw new Error('LOLAH_UPBIT_STATE_PATH is required.')
  return { statePath }
}

export async function runUpbitWorkerFromEnvironment(input: {
  signal: AbortSignal
  environment?: NodeJS.ProcessEnv
  onState?: (state: UpbitWorkerRuntimeState) => void
}) {
  const environment = input.environment ?? process.env
  const config = upbitWorkerRuntimeConfig(environment)
  if (value(environment, 'LOLAH_UPBIT_ENABLED') !== 'true') {
    const disabled = state({ state: 'disabled', provider: 'disabled', enrichment: 'disabled' })
    input.onState?.(disabled)
    console.log(JSON.stringify({ component: 'upbit_monitor', ...disabled }))
    await wait(2_147_000_000, input.signal)
    input.onState?.(state({ state: 'stopped', provider: 'disabled', enrichment: 'disabled' }))
    return
  }

  if (value(environment, 'LOLAH_UPBIT_SOURCE') !== 'coinlisting') {
    throw new Error('LOLAH_UPBIT_SOURCE must be coinlisting in deployed mode.')
  }
  const apiKey = value(environment, 'LOLAH_COINLISTING_KEY')
  const endpoint = value(environment, 'LOLAH_COINLISTING_ENDPOINT') || COINLISTING_UPBIT_ENDPOINT
  const store = new UpbitListingWorkerStore(config.statePath)
  const snapshot = await store.getMonitorSnapshot()
  let current = state({ state: 'running', provider: 'connecting', enrichment: 'disabled' })
  const publish = (next: UpbitWorkerRuntimeState) => {
    current = next
    input.onState?.(next)
  }
  publish(current)
  const frames = coinListingFrames({
    apiKey,
    endpoint,
    signal: input.signal,
    onStatus: status => {
      publish(state({
        state: 'running',
        provider: status.state,
        enrichment: current.enrichment,
      }))
      console.log(JSON.stringify({ provider: 'coinlisting', ...status }))
    },
  })
  const coinListing = new CoinListingUpbitSource(
    frames,
    snapshot?.schema === 'lolah-upbit-coinlisting-state-v1'
      ? snapshot as UpbitCoinListingSnapshot
      : undefined,
  )

  const enrichmentEnabled = value(environment, 'LOLAH_UPBIT_ENRICHMENT_ENABLED') === 'true'
  const polydeskEndpoint = enrichmentEnabled
    ? validateLiveShadowPolydeskEndpoint(
        value(environment, 'LOLAH_POLYDESK_CONTEXT_ENDPOINT'),
        'production_shadow',
      )
    : undefined
  const polydeskBearerToken = enrichmentEnabled
    ? value(environment, 'LOLAH_POLYDESK_CONTEXT_TOKEN')
    : undefined
  if (enrichmentEnabled && (!polydeskBearerToken
    || polydeskBearerToken.length < 32 || polydeskBearerToken.length > 8_192)) {
    throw new Error('LOLAH_POLYDESK_CONTEXT_TOKEN is required.')
  }

  const listingWorker = runContinuousUpbitListingWorker({
    store,
    signal: input.signal,
    source: coinListing,
    onCycle: result => {
      if (result.eventsObserved > 0 || result.alertsPrepared > 0) console.log(JSON.stringify(result))
    },
    onError: failure => console.error(JSON.stringify(failure)),
  })
  if (!enrichmentEnabled) {
    publish(state({ state: 'running', provider: current.provider, enrichment: 'disabled' }))
    console.log(JSON.stringify({ component: 'upbit_enrichment', state: 'disabled' }))
    await listingWorker
  } else {
    if (!polydeskEndpoint || !polydeskBearerToken) throw new Error('Upbit enrichment is not configured.')
    const enrichmentWorker = (async () => {
      let failures = 0
      while (!input.signal.aborted) {
        try {
          await preflightPolydeskMarketContext(polydeskEndpoint, polydeskBearerToken)
          publish(state({ state: 'running', provider: current.provider, enrichment: 'enabled' }))
          console.log(JSON.stringify({ component: 'upbit_enrichment', state: 'enabled' }))
          break
        } catch {
          failures += 1
          const retryAfterMs = Math.min(60_000, 1_000 * 2 ** Math.min(6, failures - 1))
          publish(state({ state: 'running', provider: current.provider, enrichment: 'preflight_unavailable' }))
          console.error(JSON.stringify({
            component: 'upbit_enrichment', state: 'preflight_unavailable',
            consecutiveFailures: failures, retryAfterMs,
          }))
          await wait(retryAfterMs, input.signal)
        }
      }
      if (input.signal.aborted) return
      await runContinuousUpbitEnrichmentWorker({
        store,
        signal: input.signal,
        enrich: (event, symbol) => enrichLiveUpbitListing({
          event, symbol,
          polydeskEndpoint,
          polydeskBearerToken,
        }),
        onCycle: result => console.log(JSON.stringify(result)),
        onError: failure => console.error(JSON.stringify(failure)),
      })
    })()
    await Promise.all([listingWorker, enrichmentWorker])
  }
  input.onState?.(state({ state: 'stopped', provider: current.provider, enrichment: current.enrichment }))
}
