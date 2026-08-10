import type { LolahEventScan } from './contracts.js'
import { LolahDurableStateStore } from './durable-state.js'
import type { LolahScanRequest } from './event-scan.js'
import { runReadOnlyPollingBatch, type ReadOnlyPollingBatchResult } from './polling-batch.js'
import type { LolahSourceRegistry } from './source-registry.js'
import { buildXIntelligencePlan, type XIntelligenceQuery } from './x-intelligence-plan.js'
import { XDailyUsageBudget } from './x-usage-budget.js'

export type XIntelligenceCycleResult = {
  schema: 'lolah-x-intelligence-cycle-v1'
  queriesAttempted: number
  queriesCompleted: number
  queriesRateLimited: number
  queriesBudgetExhausted: number
  budgetRetryAfterMs: number
  postsFetched: number
  eventsAccepted: number
  contextCompleted: number
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

export async function runXIntelligenceCycle(input: {
  registry: LolahSourceRegistry
  bearerToken: string
  store: LolahDurableStateStore
  scan: (request: LolahScanRequest) => Promise<LolahEventScan>
  plan?: XIntelligenceQuery[]
  fetcher?: typeof fetch
  now?: () => Date
  usageBudget?: XDailyUsageBudget
}): Promise<XIntelligenceCycleResult> {
  const plan = input.plan ?? buildXIntelligencePlan(input.registry)
  const results: ReadOnlyPollingBatchResult[] = []
  for (const query of plan) {
    results.push(await runReadOnlyPollingBatch({
      sourceKey: query.sourceKey,
      query: query.query,
      bearerToken: input.bearerToken,
      registry: input.registry,
      store: input.store,
      scan: input.scan,
      fetcher: input.fetcher,
      minimumIntervalMs: query.minimumIntervalMs,
      now: input.now,
      usageBudget: input.usageBudget,
    }))
  }
  return {
    schema: 'lolah-x-intelligence-cycle-v1',
    queriesAttempted: plan.length,
    queriesCompleted: results.filter(result => result.status === 'processed').length,
    queriesRateLimited: results.filter(result => result.status === 'rate_limited').length,
    queriesBudgetExhausted: results.filter(result => result.status === 'budget_exhausted').length,
    budgetRetryAfterMs: Math.max(0, ...results.filter(result => result.status === 'budget_exhausted')
      .map(result => result.retryAfterMs)),
    postsFetched: results.reduce((total, result) => total + (result.status === 'processed' ? result.fetched : 0), 0),
    eventsAccepted: results.reduce((total, result) => total + result.posts.filter(post =>
      post.status === 'new_event' || post.status === 'updated_event').length, 0),
    contextCompleted: results.reduce((total, result) => total + result.contextQueue.completed, 0),
    simulationOnly: true,
    sendAllowed: false,
    executionAllowed: false,
  }
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener('abort', done, { once: true })
  })
}

export async function runContinuousXIntelligenceWorker(input: {
  registry: LolahSourceRegistry
  bearerToken: string
  store: LolahDurableStateStore
  scan: (request: LolahScanRequest) => Promise<LolahEventScan>
  signal: AbortSignal
  intervalMs?: number
  fetcher?: typeof fetch
  onCycle?: (result: XIntelligenceCycleResult) => void
  onError?: (failure: {
    category: 'x_intelligence_unavailable'
    consecutiveFailures: number
    retryAfterMs: number
  }) => void
  usageBudget?: XDailyUsageBudget
}) {
  const intervalMs = input.intervalMs ?? 15_000
  if (!Number.isInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 5 * 60_000) {
    throw new Error('X intelligence worker interval is invalid.')
  }
  const plan = buildXIntelligencePlan(input.registry)
  let consecutiveFailures = 0
  while (!input.signal.aborted) {
    let retryAfterMs = intervalMs
    try {
      const result = await runXIntelligenceCycle({ ...input, plan })
      consecutiveFailures = 0
      input.onCycle?.(result)
      if (result.queriesBudgetExhausted === plan.length) retryAfterMs = result.budgetRetryAfterMs
    } catch {
      consecutiveFailures += 1
      retryAfterMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(6, consecutiveFailures - 1))
      input.onError?.({ category: 'x_intelligence_unavailable', consecutiveFailures, retryAfterMs })
    }
    if (!input.signal.aborted) await wait(retryAfterMs, input.signal)
  }
}
