import assert from 'node:assert/strict'
import test from 'node:test'
import { checkOkxMessageEligibility, type OkxMessageEligibilityInput } from '../src/okx-message-eligibility.js'

const input: OkxMessageEligibilityInput = {
  clientAgentId: 'client_1',
  providerAgentId: 'provider_1',
  jobId: 'task_001',
  groupId: 'group_001',
  direction: 'provider_to_client',
  providerSecurityRate: '0.95',
  clientCommunicationAddress: '0x1111111111111111111111111111111111111111',
  providerCommunicationAddress: '0x2222222222222222222222222222222222222222',
  isOfflineReplay: true,
}

test('passes the exact documented task-message eligibility fields to an injected fixture checker', async () => {
  let received: OkxMessageEligibilityInput | undefined
  const result = await checkOkxMessageEligibility(input, async value => {
    received = value
    return { eligible: true }
  })
  assert.deepEqual(received, input)
  assert.deepEqual(result, { eligible: true, checkedOfflineReplay: true })
})

test('fails closed on malformed addresses, security rates, or checker output', async () => {
  await assert.rejects(() => checkOkxMessageEligibility({
    ...input, clientCommunicationAddress: 'not-an-address',
  }, async () => ({ eligible: true })), /input is invalid/)
  await assert.rejects(() => checkOkxMessageEligibility({
    ...input, providerSecurityRate: '1.5',
  }, async () => ({ eligible: true })), /input is invalid/)
  await assert.rejects(() => checkOkxMessageEligibility(input, async () => ({ allowed: true })), /check failed/)
})

test('does not leak checker failure details', async () => {
  await assert.rejects(() => checkOkxMessageEligibility(input, async () => {
    throw new Error('private backend detail')
  }), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'OKX message eligibility check failed.')
    return true
  })
})
