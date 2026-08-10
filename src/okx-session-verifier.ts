import type { RecipientSessionVerifier, VerifiedRecipientSession } from './authenticated-outbox.js'

export type OkxSessionIntrospection = {
  active: boolean
  agentId: string
  sessionId: string
  audience: string | string[]
  issuedAt: number
  expiresAt: number
}

export type OkxSessionIntrospector = (accessToken: string) => Promise<unknown>

const OKX_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/

export function createOkxFixtureSessionVerifier(
  introspect: OkxSessionIntrospector,
  expectedAudience = 'lolah',
): RecipientSessionVerifier {
  return async accessToken => {
    const value = await introspect(accessToken)
    if (!value || typeof value !== 'object') throw new Error('OKX session introspection failed.')
    const result = value as Partial<OkxSessionIntrospection>
    const audiences = Array.isArray(result.audience) ? result.audience : [result.audience]
    if (result.active !== true
      || !OKX_ID.test(String(result.agentId ?? ''))
      || !OKX_ID.test(String(result.sessionId ?? ''))
      || !audiences.includes(expectedAudience)
      || !Number.isInteger(result.issuedAt)
      || !Number.isInteger(result.expiresAt)
      || Number(result.expiresAt) <= Number(result.issuedAt)) {
      throw new Error('OKX session introspection failed.')
    }
    const principal: VerifiedRecipientSession = {
      issuer: 'okx-ai:fixture-introspection',
      subjectId: 'okx-agent:' + result.agentId,
      sessionId: 'okx-session:' + result.sessionId,
      audience: 'lolah',
      authenticatedAt: new Date(Number(result.issuedAt) * 1_000).toISOString(),
      expiresAt: new Date(Number(result.expiresAt) * 1_000).toISOString(),
    }
    return principal
  }
}
