import type { LolahEventScan } from './contracts.js'
import { LolahDurableStateStore } from './durable-state.js'
import type { LolahScanRequest } from './event-scan.js'
import { handleLolahLocalRequest } from './local-service-routes.js'
import {
  classifyOkxInboundEnvelope,
  type OkxInboundClassification,
} from './okx-inbound-envelope.js'
import {
  createOkxFixtureSessionVerifier,
  type OkxSessionIntrospection,
} from './okx-session-verifier.js'
import {
  runReadOnlyPollingBatch,
  type ReadOnlyPollingBatchResult,
} from './polling-batch.js'
import type { LolahSourceRegistry } from './source-registry.js'

type FixtureInboundSummary =
  | { kind: 'system_event'; jobId: string; requiredAction: 'canonical_next_action' }
  | {
      kind: 'agent_chat'
      jobId: string
      localRole: 'asp' | 'user'
      terminalUserRejection: boolean
      requiredAction: 'role_playbook' | 'localized_user_notification'
      contentIsUntrusted: true
    }
  | { kind: 'prefetch'; requiredAction: 'none'; contentIsUntrusted: true }
  | { kind: 'unrecognized'; requiredAction: 'none' }

export type LolahFixtureScenarioInput = {
  inboundEnvelope: unknown
  structuredWatch: {
    jobId: string
    recipientAgentId: string
    accessToken: string
    idempotencyKey: string
    entityIds: string[]
    targetMarkets: string[]
    expiresAt: string
  }
  introspection: OkxSessionIntrospection
  registry: LolahSourceRegistry
  store: LolahDurableStateStore
  polling: {
    sourceKey: string
    query: string
    xBearerToken: string
    fetcher: typeof fetch
    scan: (request: LolahScanRequest) => Promise<LolahEventScan>
    minimumIntervalMs?: number
    maxPages?: number
  }
  now?: () => Date
}

type FixtureSafety = {
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

export type LolahFixtureScenarioResult =
  | (FixtureSafety & {
      status: 'not_run'
      inbound: FixtureInboundSummary
      reason: string
    })
  | (FixtureSafety & {
      status: 'blocked'
      inbound: FixtureInboundSummary
      reason: string
    })
  | (FixtureSafety & {
      status: 'completed'
      inbound: FixtureInboundSummary
      watch: Record<string, unknown>
      polling: ReadOnlyPollingBatchResult
      deliveries: unknown[]
    })

const safety: FixtureSafety = {
  simulationOnly: true,
  sendAllowed: false,
  executionAllowed: false,
}

function summarizeInbound(classification: OkxInboundClassification): FixtureInboundSummary {
  if (classification.kind === 'system_event') {
    return {
      kind: 'system_event',
      jobId: classification.jobId,
      requiredAction: classification.requiredAction,
    }
  }
  if (classification.kind === 'agent_chat') {
    return {
      kind: 'agent_chat',
      jobId: classification.jobId,
      localRole: classification.localRole,
      terminalUserRejection: classification.terminalUserRejection,
      requiredAction: classification.requiredAction,
      contentIsUntrusted: true,
    }
  }
  if (classification.kind === 'prefetch') {
    return { kind: 'prefetch', requiredAction: 'none', contentIsUntrusted: true }
  }
  return { kind: 'unrecognized', requiredAction: 'none' }
}

function noActionReason(classification: OkxInboundClassification) {
  if (classification.kind === 'system_event') {
    return 'A system event requires the canonical live next-action flow, which this fixture runner cannot invoke.'
  }
  if (classification.kind === 'prefetch') return 'A standalone prefetch message requires no action.'
  if (classification.kind === 'unrecognized') return 'The inbound envelope is unsupported.'
  if (classification.terminalUserRejection) {
    return 'A terminal user rejection belongs to the live localized notification flow, which is disabled here.'
  }
  return 'This chat resolves Lolah to the user role and cannot authorize an ASP watch scenario.'
}

export async function runLolahEndToEndFixture(
  input: LolahFixtureScenarioInput,
): Promise<LolahFixtureScenarioResult> {
  const classification = classifyOkxInboundEnvelope(input.inboundEnvelope)
  const inbound = summarizeInbound(classification)
  if (classification.kind !== 'agent_chat'
    || classification.terminalUserRejection
    || classification.localRole !== 'asp') {
    return { ...safety, status: 'not_run', inbound, reason: noActionReason(classification) }
  }
  if (classification.jobId !== input.structuredWatch.jobId
    || input.introspection.agentId !== input.structuredWatch.recipientAgentId) {
    return {
      ...safety,
      status: 'blocked',
      inbound,
      reason: 'The structured fixture is not bound to the inbound job and authenticated recipient.',
    }
  }

  const now = input.now ?? (() => new Date())
  const verifier = createOkxFixtureSessionVerifier(async accessToken => {
    if (accessToken !== input.structuredWatch.accessToken) {
      throw new Error('Fixture access token mismatch.')
    }
    return input.introspection
  })
  const dependencies = { store: input.store, verifier, now }

  try {
    const created = await handleLolahLocalRequest({
      method: 'POST',
      path: '/v1/watches',
      headers: {
        authorization: 'Bearer ' + input.structuredWatch.accessToken,
        'idempotency-key': input.structuredWatch.idempotencyKey,
      },
      body: {
        entityIds: input.structuredWatch.entityIds,
        targetMarkets: input.structuredWatch.targetMarkets,
        expiresAt: input.structuredWatch.expiresAt,
      },
    }, dependencies)
    if (created.status !== 201 || !created.body.watch || typeof created.body.watch !== 'object') {
      throw new Error('watch_create_failed')
    }

    const polling = await runReadOnlyPollingBatch({
      sourceKey: input.polling.sourceKey,
      query: input.polling.query,
      bearerToken: input.polling.xBearerToken,
      registry: input.registry,
      store: input.store,
      fetcher: input.polling.fetcher,
      scan: input.polling.scan,
      minimumIntervalMs: input.polling.minimumIntervalMs,
      maxPages: input.polling.maxPages,
      now,
    })
    const pulled = await handleLolahLocalRequest({
      method: 'POST',
      path: '/v1/alerts/pull',
      headers: { authorization: 'Bearer ' + input.structuredWatch.accessToken },
      body: { limit: 20, leaseMs: 60_000 },
    }, dependencies)
    if (pulled.status !== 200 || !Array.isArray(pulled.body.deliveries)) {
      throw new Error('alert_pull_failed')
    }

    return {
      ...safety,
      status: 'completed',
      inbound,
      watch: created.body.watch as Record<string, unknown>,
      polling,
      deliveries: pulled.body.deliveries,
    }
  } catch {
    return {
      ...safety,
      status: 'blocked',
      inbound,
      reason: 'The fixture scenario failed closed without enabling delivery or execution.',
    }
  }
}
