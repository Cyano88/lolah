import { LolahDurableStateStore } from './durable-state.js'
import { runLiveReadOnlyScan } from './live-scan.js'
import { validateLiveShadowPolydeskEndpoint } from './live-shadow-runner.js'
import { runReadOnlyPollingBatch, type ReadOnlyPollingBatchResult } from './polling-batch.js'
import {
  validateSourceRegistry,
  type LolahSourceRegistry,
} from './source-registry.js'

export type LolahLivePipelineInput = {
  registry: LolahSourceRegistry
  store: LolahDurableStateStore
  sourceKey: string
  query: string
  xBearerToken: string
  polydeskEndpoint: string
  mode: 'production_shadow' | 'local_staging'
  watch: {
    recipientId: string
    entityIds: string[]
    targetMarkets: string[]
    expiresAt: Date
    idempotencyKey: string
  }
  fetcher?: typeof fetch
  now?: () => Date
}

export type LolahLivePipelineResult = {
  schema: 'lolah-live-pipeline-v1'
  watchId: string
  polling: ReadOnlyPollingBatchResult
  simulatedOutboxCount: number
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

function validateWatchScope(
  registry: LolahSourceRegistry,
  entityIds: string[],
  targetMarkets: string[],
) {
  const knownEntities = new Set(registry.entities.map(entity => entity.id))
  const knownMarkets = new Set(registry.entities.flatMap(entity => entity.hyperliquidMarkets)
    .map(market => market.toLowerCase()))
  if (!entityIds.length || entityIds.some(entityId => !knownEntities.has(entityId.toLowerCase()))
    || !targetMarkets.length || targetMarkets.some(market => !knownMarkets.has(market.toLowerCase()))) {
    throw new Error('Live pipeline watch scope is outside the curated registry.')
  }
}

export async function runLolahLivePipeline(
  input: LolahLivePipelineInput,
): Promise<LolahLivePipelineResult> {
  if (typeof input.xBearerToken !== 'string'
    || input.xBearerToken.length < 20
    || input.xBearerToken.length > 8_192) {
    throw new Error('Live pipeline X access is not configured.')
  }
  const registry = validateSourceRegistry(input.registry)
  validateWatchScope(registry, input.watch.entityIds, input.watch.targetMarkets)
  const polydeskEndpoint = validateLiveShadowPolydeskEndpoint(
    input.polydeskEndpoint,
    input.mode,
  )
  const now = input.now ?? (() => new Date())
  const fetcher = input.fetcher ?? fetch
  const watch = await input.store.createWatch({
    recipientId: input.watch.recipientId,
    entityIds: input.watch.entityIds,
    targetMarkets: input.watch.targetMarkets,
    expiresAt: input.watch.expiresAt,
  }, now(), input.watch.idempotencyKey)

  const polling = await runReadOnlyPollingBatch({
    sourceKey: input.sourceKey,
    query: input.query,
    bearerToken: input.xBearerToken,
    registry,
    store: input.store,
    fetcher,
    now,
    scan: request => runLiveReadOnlyScan(request, {
      polydeskEndpoint,
      fetcher,
      now,
    }),
  })
  const outbox = await input.store.listRecipientOutbox(input.watch.recipientId)
  return {
    schema: 'lolah-live-pipeline-v1',
    watchId: watch.watchId,
    polling,
    simulatedOutboxCount: outbox.length,
    simulationOnly: true,
    sendAllowed: false,
    executionAllowed: false,
  }
}
