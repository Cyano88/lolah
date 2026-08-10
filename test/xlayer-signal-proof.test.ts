import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDeliveryProofRoot,
  createSignalProofBatch,
} from '../src/xlayer-signal-proof.js'
import type { LolahSubscriptionSignal } from '../src/subscription-push.js'

const first: LolahSubscriptionSignal = {
  schema: 'lolah-subscription-signal-v1',
  signalId: 'signal_upbit_abc',
  source: 'upbit',
  occurredAt: '2026-08-10T12:00:00.000Z',
  expiresAt: '2026-08-10T12:30:00.000Z',
  message: 'Official Upbit listing intelligence.',
  sourceUrls: ['https://upbit.com/service_center/notice?id=123'],
  executionAllowed: false,
}
const second: LolahSubscriptionSignal = {
  ...first,
  signalId: 'signal_x_def',
  source: 'x',
  occurredAt: '2026-08-10T12:05:00.000Z',
  message: 'Verified source with PolyDesk and Hyperliquid context.',
  sourceUrls: ['https://x.com/example/status/123'],
}

test('creates an order-independent signal root with no raw message or recipient data', () => {
  const forward = createSignalProofBatch([first, second], '076b66d')
  const reverse = createSignalProofBatch([second, first], '076b66d')
  assert.equal(forward.root, reverse.root)
  assert.equal(forward.signalCount, 2)
  assert.equal(forward.windowStart, 1786363200)
  assert.equal(forward.windowEnd, 1786363500)
  assert.equal(forward.privacy, 'no_recipient_or_message_content')
  const serialized = JSON.stringify(forward)
  assert.equal(serialized.includes(first.message), false)
  assert.equal(serialized.includes(first.sourceUrls[0]), false)
  assert.equal(serialized.includes('buyerAgentId'), false)
})

test('deduplicates a signal id before building its public commitment', () => {
  const batch = createSignalProofBatch([first, first], '076b66d')
  assert.equal(batch.signalCount, 1)
  assert.equal(batch.leaves.length, 1)
})

test('delivery commitments hash message ids and never require subscriber ids', () => {
  const proof = createDeliveryProofRoot([{
    signalId: first.signalId,
    deliveryId: 'sub_delivery_123',
    messageId: 'private_message_id',
    deliveredAt: '2026-08-10T12:01:00.000Z',
  }])
  assert.match(proof.root, /^0x[a-f0-9]{64}$/)
  assert.equal(proof.deliveryCount, 1)
  assert.equal(JSON.stringify(proof).includes('private_message_id'), false)
})
