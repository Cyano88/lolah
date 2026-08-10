import assert from 'node:assert/strict'
import test from 'node:test'
import { createOkxFixtureSessionVerifier } from '../src/okx-session-verifier.js'

const token = 'fixture-okx-jwt-token-1234567890'

test('maps validated OKX introspection fixtures into a Lolah recipient session', async () => {
  const verifier = createOkxFixtureSessionVerifier(async received => {
    assert.equal(received, token)
    return {
      active: true,
      agentId: '123',
      sessionId: 'session_abc',
      audience: ['lolah', 'okx-ai'],
      issuedAt: 1_786_268_400,
      expiresAt: 1_786_272_000,
    }
  })
  const principal = await verifier(token)
  assert.deepEqual(principal, {
    issuer: 'okx-ai:fixture-introspection',
    subjectId: 'okx-agent:123',
    sessionId: 'okx-session:session_abc',
    audience: 'lolah',
    authenticatedAt: '2026-08-09T09:40:00.000Z',
    expiresAt: '2026-08-09T10:40:00.000Z',
  })
})

test('rejects inactive, wrong-audience, and malformed introspection fixtures', async () => {
  const base = {
    active: true, agentId: '123', sessionId: 'session_abc', audience: 'lolah',
    issuedAt: 1_786_268_400, expiresAt: 1_786_272_000,
  }
  await assert.rejects(() => createOkxFixtureSessionVerifier(async () => ({ ...base, active: false }))(token), /introspection failed/)
  await assert.rejects(() => createOkxFixtureSessionVerifier(async () => ({ ...base, audience: 'another-service' }))(token), /introspection failed/)
  await assert.rejects(() => createOkxFixtureSessionVerifier(async () => ({ ...base, agentId: '../unsafe' }))(token), /introspection failed/)
})
