import { LolahDurableStateStore } from './durable-state.js'

export type VerifiedRecipientSession = {
  issuer: string
  subjectId: string
  sessionId: string
  audience: 'lolah'
  authenticatedAt: string
  expiresAt: string
}

export type RecipientSessionVerifier = (accessToken: string) => Promise<unknown>

export type SimulatedAlertDelivery = {
  schema: 'lolah-simulated-alert-v1'
  outboxId: string
  draftId: string
  eventId: string
  targetMarket: string
  alertClass: 'context_ready' | 'risk_blocked'
  scanState: 'context_ready' | 'no_trade'
  reason: string
  leaseUntil: string
  simulationOnly: true
  sendAllowed: false
}

const PRINCIPAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{2,127}$/
const MAX_SESSION_MS = 24 * 60 * 60_000

function validatePrincipal(value: unknown, now: Date): VerifiedRecipientSession {
  if (!value || typeof value !== 'object') throw new Error('Authentication failed.')
  const principal = value as Partial<VerifiedRecipientSession>
  const authenticatedAt = Date.parse(String(principal.authenticatedAt ?? ''))
  const expiresAt = Date.parse(String(principal.expiresAt ?? ''))
  if (!PRINCIPAL_ID.test(String(principal.issuer ?? ''))
    || !PRINCIPAL_ID.test(String(principal.subjectId ?? ''))
    || !PRINCIPAL_ID.test(String(principal.sessionId ?? ''))
    || principal.audience !== 'lolah'
    || !Number.isFinite(authenticatedAt)
    || !Number.isFinite(expiresAt)
    || authenticatedAt > now.getTime() + 60_000
    || expiresAt <= now.getTime()
    || expiresAt - authenticatedAt > MAX_SESSION_MS) {
    throw new Error('Authentication failed.')
  }
  return {
    issuer: String(principal.issuer),
    subjectId: String(principal.subjectId),
    sessionId: String(principal.sessionId),
    audience: 'lolah',
    authenticatedAt: new Date(authenticatedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

export async function authenticateRecipientSession(
  accessToken: string,
  verifier: RecipientSessionVerifier,
  now: Date,
): Promise<VerifiedRecipientSession> {
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8_192) {
    throw new Error('Authentication failed.')
  }
  try {
    return validatePrincipal(await verifier(accessToken), now)
  } catch {
    throw new Error('Authentication failed.')
  }
}

export async function pullSimulatedAlerts(input: {
  accessToken: string
  verifier: RecipientSessionVerifier
  store: LolahDurableStateStore
  now?: Date
  limit?: number
  leaseMs?: number
}): Promise<SimulatedAlertDelivery[]> {
  const now = input.now ?? new Date()
  const principal = await authenticateRecipientSession(input.accessToken, input.verifier, now)
  await input.store.stageAlertDraftsToOutbox(now)
  const leased = await input.store.leaseRecipientOutbox(
    principal.subjectId,
    principal.sessionId,
    now,
    input.limit,
    input.leaseMs,
  )
  return leased.map(({ item, draft }) => ({
    schema: 'lolah-simulated-alert-v1',
    outboxId: item.outboxId,
    draftId: draft.draftId,
    eventId: draft.eventId,
    targetMarket: draft.targetMarket,
    alertClass: draft.alertClass,
    scanState: draft.scanState,
    reason: draft.reason,
    leaseUntil: item.leaseUntil!,
    simulationOnly: true,
    sendAllowed: false,
  }))
}

export async function acknowledgeSimulatedAlert(input: {
  accessToken: string
  verifier: RecipientSessionVerifier
  store: LolahDurableStateStore
  outboxId: string
  now?: Date
}) {
  const now = input.now ?? new Date()
  const principal = await authenticateRecipientSession(input.accessToken, input.verifier, now)
  const item = await input.store.acknowledgeSimulatedOutbox(
    input.outboxId,
    principal.subjectId,
    principal.sessionId,
    now,
  )
  return {
    schema: 'lolah-simulated-ack-v1' as const,
    outboxId: item.outboxId,
    status: item.status,
    acknowledgedAt: item.updatedAt,
    simulationOnly: true as const,
  }
}
