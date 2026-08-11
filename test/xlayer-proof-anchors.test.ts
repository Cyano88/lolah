import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProofAnchorCalls } from '../src/xlayer-proof-anchors.js'

test('encodes bounded signal and delivery anchor calls', () => {
  const calls = buildProofAnchorCalls({
    contractAddress: '0x1111111111111111111111111111111111111111',
    signalRoot: '0x' + '22'.repeat(32),
    releaseHash: '0x' + '33'.repeat(32),
    windowStart: 1_786_415_437,
    windowEnd: 1_786_415_437,
    signalCount: 1,
    deliveryRoot: '0x' + '44'.repeat(32),
    deliveryCount: 3,
  })
  assert.equal(calls.chainId, 196)
  assert.equal(calls.signal.calldata.length, 2 + 8 + 64 * 5)
  assert.equal(calls.delivery.calldata.length, 2 + 8 + 64 * 3)
  assert.equal(calls.signal.calldata.includes('22'.repeat(32)), true)
  assert.equal(calls.delivery.calldata.includes('44'.repeat(32)), true)
})

test('rejects a reversed signal window', () => {
  assert.throws(() => buildProofAnchorCalls({
    contractAddress: '0x1111111111111111111111111111111111111111',
    signalRoot: '0x' + '22'.repeat(32), releaseHash: '0x' + '33'.repeat(32),
    windowStart: 2, windowEnd: 1, signalCount: 1,
    deliveryRoot: '0x' + '44'.repeat(32), deliveryCount: 1,
  }), /window/)
})
