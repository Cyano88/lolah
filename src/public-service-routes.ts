import type { XUsageSnapshot } from './x-usage-budget.js'
import type { XWorkerRuntimeState } from './x-worker-runtime.js'

export type LolahPublicResponse = {
  status: number
  headers: Record<string, string>
  body: Record<string, unknown>
}

export type LolahPublicRouteDependencies = {
  runtimeState: () => XWorkerRuntimeState
  usage: () => Promise<XUsageSnapshot>
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
  request: { method: string; path: string; body?: unknown },
  dependencies: LolahPublicRouteDependencies,
) {
  if (request.method === 'GET' && request.path === '/health') {
    const runtime = dependencies.runtimeState()
    return response(200, {
      ok: true,
      service: 'lolah',
      mode: 'read_only',
      scannerState: runtime.state,
      simulationOnly: true,
      sendAllowed: false,
      executionAllowed: false,
    })
  }
  if (request.method === 'POST' && request.path === '/v1/status') {
    if (request.body !== undefined && (
      !request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body as Record<string, unknown>).length > 0
    )) return response(400, { ok: false, error: 'Request body must be an empty JSON object.' })
    const runtime = dependencies.runtimeState()
    return response(200, {
      ok: true,
      schema: 'lolah-public-status-v1',
      service: 'lolah',
      observedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      scanner: runtime,
      usage: await dependencies.usage(),
      delivery: {
        publicAlertRoutes: false,
        reason: 'Official OKX recipient-session verification is not configured.',
      },
      simulationOnly: true,
      sendAllowed: false,
      executionAllowed: false,
    })
  }
  return response(404, { ok: false, error: 'Route not found.' })
}
