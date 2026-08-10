import {
  acknowledgeSimulatedAlert,
  authenticateRecipientSession,
  pullSimulatedAlerts,
  type RecipientSessionVerifier,
} from './authenticated-outbox.js'
import { LolahDurableStateStore } from './durable-state.js'
import { UpbitListingWorkerStore, type UpbitListingWatch } from './upbit-listing-worker.js'

export type LolahLocalRequest = {
  method: string
  path: string
  headers?: Record<string, string | undefined>
  body?: unknown
}

export type LolahLocalResponse = {
  status: number
  headers: { 'content-type': 'application/json'; 'cache-control': 'no-store' }
  body: Record<string, unknown>
}

export type LolahLocalRouteDependencies = {
  store: LolahDurableStateStore
  upbitStore?: UpbitListingWorkerStore
  verifier: RecipientSessionVerifier
  now?: () => Date
}

function upbitStore(dependencies: LolahLocalRouteDependencies) {
  if (!dependencies.upbitStore) throw new Error('Upbit alert service is unavailable.')
  return dependencies.upbitStore
}

function publicUpbitWatch(watch: UpbitListingWatch) {
  return {
    watchId: watch.watchId,
    recipientId: watch.recipientId,
    symbols: watch.symbols,
    createdAt: watch.createdAt,
    expiresAt: watch.expiresAt,
    status: watch.status,
  }
}

function response(status: number, body: Record<string, unknown>): LolahLocalResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body,
  }
}

function bearer(headers: Record<string, string | undefined> = {}) {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')
  const match = entry?.[1]?.match(/^Bearer ([A-Za-z0-9._~+/-]{20,8192})$/)
  if (!match) throw new Error('Authentication failed.')
  return match[1]
}

function header(headers: Record<string, string | undefined> = {}, name: string) {
  return Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[1]
}

function bodyRecord(value: unknown) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body is invalid.')
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error('Request body is invalid.')
  }
  return Number(value)
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50
    || value.some(item => typeof item !== 'string')) {
    throw new Error('Request body is invalid.')
  }
  return value as string[]
}

function publicWatch(watch: Awaited<ReturnType<LolahDurableStateStore['createWatch']>>) {
  return {
    watchId: watch.watchId,
    recipientId: watch.recipientId,
    entityIds: watch.entityIds,
    targetMarkets: watch.targetMarkets,
    createdAt: watch.createdAt,
    expiresAt: watch.expiresAt,
    status: watch.status,
  }
}

export async function handleLolahLocalRequest(
  request: LolahLocalRequest,
  dependencies: LolahLocalRouteDependencies,
): Promise<LolahLocalResponse> {
  const now = dependencies.now ?? (() => new Date())
  if (request.method === 'GET' && request.path === '/health') {
    return response(200, {
      ok: true,
      service: 'lolah-local-fixture',
      deliveryMode: 'simulation_only',
      sendAllowed: false,
    })
  }
  try {
    const accessToken = bearer(request.headers)
    if (request.method === 'POST' && request.path === '/v1/watches') {
      const principal = await authenticateRecipientSession(accessToken, dependencies.verifier, now())
      const body = bodyRecord(request.body)
      const expiresAt = new Date(String(body.expiresAt ?? ''))
      if (!Number.isFinite(expiresAt.getTime())) throw new Error('Request body is invalid.')
      const idempotencyKey = header(request.headers, 'idempotency-key')
      if (!idempotencyKey) throw new Error('Idempotency key is required.')
      const watch = await dependencies.store.createWatch({
        recipientId: principal.subjectId,
        entityIds: stringArray(body.entityIds, 'entityIds'),
        targetMarkets: stringArray(body.targetMarkets, 'targetMarkets'),
        expiresAt,
      }, now(), idempotencyKey)
      return response(201, { ok: true, watch: publicWatch(watch) })
    }
    if (request.method === 'POST' && request.path === '/v1/upbit/watches') {
      const principal = await authenticateRecipientSession(accessToken, dependencies.verifier, now())
      const body = bodyRecord(request.body)
      const expiresAt = new Date(String(body.expiresAt ?? ''))
      if (!Number.isFinite(expiresAt.getTime())) throw new Error('Request body is invalid.')
      const idempotencyKey = header(request.headers, 'idempotency-key')
      if (!idempotencyKey) throw new Error('Idempotency key is required.')
      const watch = await upbitStore(dependencies).createWatch({
        recipientId: principal.subjectId,
        symbols: stringArray(body.symbols, 'symbols'),
        expiresAt,
      }, now(), idempotencyKey)
      return response(201, { ok: true, watch: publicUpbitWatch(watch) })
    }
    if (request.method === 'GET' && request.path === '/v1/upbit/watches') {
      const principal = await authenticateRecipientSession(accessToken, dependencies.verifier, now())
      const watches = await upbitStore(dependencies).listRecipientWatches(principal.subjectId, now())
      return response(200, { ok: true, watches: watches.map(publicUpbitWatch) })
    }
    const upbitCancellation = request.path.match(/^\/v1\/upbit\/watches\/(upbit_watch_[a-f0-9-]{36})\/cancel$/)
    if (request.method === 'POST' && upbitCancellation) {
      const principal = await authenticateRecipientSession(accessToken, dependencies.verifier, now())
      bodyRecord(request.body)
      const watch = await upbitStore(dependencies).cancelWatch(upbitCancellation[1], principal.subjectId)
      return response(200, { ok: true, watch: publicUpbitWatch(watch) })
    }
    if (request.method === 'POST' && request.path === '/v1/upbit/alerts/pull') {
      const principal = await authenticateRecipientSession(accessToken, dependencies.verifier, now())
      const body = bodyRecord(request.body)
      const leased = await upbitStore(dependencies).leaseRecipientAlerts(
        principal.subjectId,
        principal.sessionId,
        now(),
        positiveInteger(body.limit, 20, 1, 100),
        positiveInteger(body.leaseMs, 60_000, 10_000, 10 * 60_000),
      )
      return response(200, {
        ok: true,
        mode: 'simulation_only',
        sendAllowed: false,
        executionAllowed: false,
        deliveries: leased.map(({ delivery, alert }) => ({
          schema: 'lolah-upbit-simulated-alert-v1',
          outboxId: delivery.deliveryId,
          draftId: alert.draftId,
          alertClass: alert.alertClass,
          event: alert.event,
          enrichmentStatus: alert.enrichmentStatus,
          assessments: alert.assessments,
          leaseUntil: delivery.leaseUntil,
          simulationOnly: true,
          sendAllowed: false,
          executionAllowed: false,
        })),
      })
    }
    const upbitAcknowledgement = request.path.match(/^\/v1\/upbit\/alerts\/(upbit_outbox_[a-f0-9]{40})\/ack$/)
    if (request.method === 'POST' && upbitAcknowledgement) {
      const principal = await authenticateRecipientSession(accessToken, dependencies.verifier, now())
      bodyRecord(request.body)
      const item = await upbitStore(dependencies).acknowledgeRecipientAlert(
        upbitAcknowledgement[1],
        principal.subjectId,
        principal.sessionId,
        now(),
      )
      return response(200, {
        ok: true,
        receipt: {
          schema: 'lolah-upbit-simulated-ack-v1',
          outboxId: item.deliveryId,
          status: item.status,
          acknowledgedAt: item.updatedAt,
          simulationOnly: true,
        },
      })
    }
    if (request.method === 'GET' && request.path === '/v1/watches') {
      const principal = await authenticateRecipientSession(accessToken, dependencies.verifier, now())
      const watches = await dependencies.store.listRecipientWatches(principal.subjectId, now())
      return response(200, { ok: true, watches: watches.map(publicWatch) })
    }
    const cancellation = request.path.match(/^\/v1\/watches\/(watch_[a-f0-9-]{36})\/cancel$/)
    if (request.method === 'POST' && cancellation) {
      const principal = await authenticateRecipientSession(accessToken, dependencies.verifier, now())
      bodyRecord(request.body)
      const watch = await dependencies.store.cancelWatch(cancellation[1], principal.subjectId)
      return response(200, { ok: true, watch: publicWatch(watch) })
    }
    if (request.method === 'POST' && request.path === '/v1/alerts/pull') {
      const body = bodyRecord(request.body)
      const deliveries = await pullSimulatedAlerts({
        accessToken,
        verifier: dependencies.verifier,
        store: dependencies.store,
        now: now(),
        limit: positiveInteger(body.limit, 20, 1, 100),
        leaseMs: positiveInteger(body.leaseMs, 60_000, 10_000, 10 * 60_000),
      })
      return response(200, {
        ok: true,
        mode: 'simulation_only',
        sendAllowed: false,
        deliveries,
      })
    }
    const acknowledgement = request.path.match(/^\/v1\/alerts\/(outbox_[a-f0-9]{40})\/ack$/)
    if (request.method === 'POST' && acknowledgement) {
      bodyRecord(request.body)
      const receipt = await acknowledgeSimulatedAlert({
        accessToken,
        verifier: dependencies.verifier,
        store: dependencies.store,
        outboxId: acknowledgement[1],
        now: now(),
      })
      return response(200, { ok: true, receipt })
    }
    return response(404, { ok: false, error: 'Route not found.' })
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication failed.') {
      return response(401, { ok: false, error: 'Authentication failed.' })
    }
    if (error instanceof Error && error.message === 'Request body is invalid.') {
      return response(400, { ok: false, error: 'Request body is invalid.' })
    }
    if (error instanceof Error && (
      error.message === 'Idempotency key is invalid.'
      || error.message === 'Watch expiry must be in the future and no more than 30 days away.'
      || error.message.startsWith('entityIds ')
      || error.message.startsWith('targetMarkets ')
      || error.message.startsWith('Upbit watch symbols ')
      || error.message === 'Upbit watch symbols are invalid.'
      || error.message === 'Upbit watch expiry must be in the future and no more than 30 days away.'
      || error.message === 'Upbit idempotency key is invalid.'
      || error.message === 'Upbit alert lease request is invalid.'
    )) {
      return response(400, { ok: false, error: 'Request body is invalid.' })
    }
    if (error instanceof Error && error.message === 'Idempotency key is required.') {
      return response(400, { ok: false, error: 'Idempotency key is required.' })
    }
    if (error instanceof Error && error.message === 'Watch idempotency conflict.') {
      return response(409, { ok: false, error: 'Idempotency key conflicts with another watch request.' })
    }
    if (error instanceof Error && error.message === 'Upbit watch idempotency conflict.') {
      return response(409, { ok: false, error: 'Idempotency key conflicts with another watch request.' })
    }
    if (error instanceof Error && error.message === 'Watch is unavailable for this recipient.') {
      return response(404, { ok: false, error: 'Watch is unavailable.' })
    }
    if (error instanceof Error && error.message === 'Upbit watch is unavailable for this recipient.') {
      return response(404, { ok: false, error: 'Watch is unavailable.' })
    }
    if (error instanceof Error && error.message === 'Simulated outbox lease is unavailable.') {
      return response(404, { ok: false, error: 'Alert acknowledgement is unavailable.' })
    }
    if (error instanceof Error && error.message === 'Upbit alert acknowledgement is unavailable.') {
      return response(404, { ok: false, error: 'Alert acknowledgement is unavailable.' })
    }
    return response(503, { ok: false, error: 'Local simulation service is unavailable.' })
  }
}
