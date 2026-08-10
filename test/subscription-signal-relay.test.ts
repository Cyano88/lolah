import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizeRelayRequest,
  fetchRelayedSubscriptionSignals,
  LOLAH_SUBSCRIPTION_FEED_URL,
  validateSubscriptionFeedUrl,
} from '../src/subscription-signal-relay.js'

const token = 'r'.repeat(48)
const signal = {
  schema: 'lolah-subscription-signal-v1' as const,
  signalId: 'signal_upbit_relay_test',
  source: 'upbit' as const,
  occurredAt: '2026-08-11T00:00:00.000Z',
  expiresAt: '2026-08-11T00:30:00.000Z',
  message: 'Verified intelligence only.',
  sourceUrls: ['https://upbit.com/service_center/notice?id=123'],
  executionAllowed: false as const,
}

test('authenticates the private feed without accepting malformed bearer values', () => {
  assert.equal(authorizeRelayRequest('Bearer ' + token, token), true)
  assert.equal(authorizeRelayRequest('Bearer ' + 'x'.repeat(48), token), false)
  assert.equal(authorizeRelayRequest(undefined, token), false)
})

test('pins the relay token to the canonical Lolah HTTPS feed', () => {
  assert.equal(validateSubscriptionFeedUrl(LOLAH_SUBSCRIPTION_FEED_URL), LOLAH_SUBSCRIPTION_FEED_URL)
  assert.throws(() => validateSubscriptionFeedUrl('https://example.com/internal/v1/subscription-signals'), /canonical/)
})

test('fetches and validates only non-executable subscription signals', async () => {
  let authorization = ''
  const signals = await fetchRelayedSubscriptionSignals({
    url: LOLAH_SUBSCRIPTION_FEED_URL,
    token,
    fetcher: async (_url, init) => {
      authorization = String((init?.headers as Record<string, string>).authorization)
      return new Response(JSON.stringify({
        ok: true, schema: 'lolah-subscription-feed-v1', signals: [signal], executionAllowed: false,
      }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal(authorization, 'Bearer ' + token)
  assert.deepEqual(signals, [signal])
})

test('fails closed on malformed or executable relay payloads', async () => {
  await assert.rejects(() => fetchRelayedSubscriptionSignals({
    url: LOLAH_SUBSCRIPTION_FEED_URL,
    token,
    fetcher: async () => new Response(JSON.stringify({
      ok: true, schema: 'lolah-subscription-feed-v1', executionAllowed: false,
      signals: [{ ...signal, executionAllowed: true }],
    }), { status: 200 }),
  }), /invalid/)
})
