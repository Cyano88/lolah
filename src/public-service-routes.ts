import type { XUsageSnapshot } from './x-usage-budget.js'
import type { XWorkerRuntimeState } from './x-worker-runtime.js'
import type { UpbitWorkerRuntimeState } from './upbit-worker-runtime.js'
import type { LolahSubscriptionSignal } from './subscription-push.js'
import { authorizeRelayRequest, validRelayToken } from './subscription-signal-relay.js'

export type LolahPublicResponse = {
  status: number
  headers: Record<string, string>
  body: Record<string, unknown>
}

export type LolahPublicRouteDependencies = {
  runtimeStates: () => { x: XWorkerRuntimeState; upbit: UpbitWorkerRuntimeState }
  usage: () => Promise<XUsageSnapshot>
  subscriptionSignals?: () => Promise<LolahSubscriptionSignal[]>
  subscriptionRelayToken?: string
  now?: () => Date
}

function response(status: number, body: Record<string, unknown>): LolahPublicResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body,
  }
}

export async function handleLolahPublicRequest(
  request: { method: string; path: string; body?: unknown; authorization?: string },
  dependencies: LolahPublicRouteDependencies,
) {
  if (request.method === 'GET' && request.path === '/health') {
    const runtimes = dependencies.runtimeStates()
    return response(200, {
      ok: true,
      service: 'lolah',
      mode: 'read_only',
      scannerState: runtimes.x.state,
      workers: { x: runtimes.x.state, upbit: runtimes.upbit.state },
      simulationOnly: true,
      sendAllowed: false,
      executionAllowed: false,
    })
  }
  if (request.method === 'GET' && request.path === '/internal/v1/subscription-signals') {
    const token = String(dependencies.subscriptionRelayToken ?? '').trim()
    if (!dependencies.subscriptionSignals || !validRelayToken(token)) {
      return response(404, { ok: false, error: 'Route not found.' })
    }
    if (!authorizeRelayRequest(request.authorization, token)) {
      return response(401, { ok: false, error: 'Authentication required.' })
    }
    const signals = await dependencies.subscriptionSignals()
    return response(200, {
      ok: true,
      schema: 'lolah-subscription-feed-v1',
      observedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      signals: signals.slice(0, 500),
      executionAllowed: false,
    })
  }
  if (request.method === 'POST' && request.path === '/v1/status') {
    if (request.body !== undefined && (
      !request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body as Record<string, unknown>).length > 0
    )) return response(400, { ok: false, error: 'Request body must be an empty JSON object.' })
    const runtimes = dependencies.runtimeStates()
    return response(200, {
      ok: true,
      schema: 'lolah-public-status-v1',
      service: 'lolah',
      observedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      scanner: runtimes.x,
      workers: runtimes,
      usage: await dependencies.usage(),
      delivery: {
        publicAlertRoutes: false,
        subscriptionPush: false,
        privateSignalRelay: Boolean(
          dependencies.subscriptionSignals
          && validRelayToken(String(dependencies.subscriptionRelayToken ?? '').trim())
        ),
        subscriptionPlan: {
          serviceName: 'Lolah Market Watch',
          freeTrialHours: 72,
          interval: 'month',
          feeUsdt: '1',
        },
        reason: 'Private signal relay and VPS subscription dispatcher require coordinated deployment.',
      },
      simulationOnly: true,
      sendAllowed: false,
      executionAllowed: false,
    })
  }
  return response(404, { ok: false, error: 'Route not found.' })
}
