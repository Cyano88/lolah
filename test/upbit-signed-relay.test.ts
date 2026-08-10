import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { UpbitSignedRelay } from '../src/upbit-signed-relay.js'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

const event = {
  schema: 'lolah-upbit-listing-v1' as const,
  eventId: 'upbit_6458',
  revisionId: 'a'.repeat(40),
  noticeId: 6458,
  status: 'new_listing' as const,
  title: 'BTC, USDT listing notice (CYS)',
  symbols: ['CYS'],
  quoteMarkets: ['BTC', 'USDT'],
  firstPublishedAt: '2026-08-10T02:05:54.000Z',
  revisedAt: '2026-08-10T02:05:54.000Z',
  detectedAt: '2026-08-10T02:05:55.000Z',
  detectionLatencyMs: 1_000,
  freshness: 'fresh' as const,
  sourceAuthority: 'upbit_official_website' as const,
  sourceUrl: 'https://www.upbit.com/service_center/notice?id=6458',
  executionAllowed: false as const,
}

function response(sequence: number, signedEvent = event) {
  const body = JSON.stringify({
    schema: 'lolah-upbit-relay-v1',
    sequence,
    generatedAt: '2026-08-10T02:06:00.000Z',
    events: [signedEvent],
  })
  return new Response(body, {
    status: 200,
    headers: { 'x-lolah-ed25519-signature': sign(null, Buffer.from(body), keys.privateKey).toString('base64') },
  })
}

test('accepts an Ed25519-signed website event and measures relay arrival latency', async () => {
  const relay = new UpbitSignedRelay('https://provider.example/upbit', publicKey, async () => response(1))
  const result = await relay.poll(new Date('2026-08-10T02:06:04.000Z'))
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].detectionLatencyMs, 10_000)
  assert.equal(result.events[0].freshness, 'fresh')
  assert.equal(relay.snapshot().lastSequence, 1)
})

test('rejects unsigned, conflicting, and backwards relay envelopes', async () => {
  const unsigned = new UpbitSignedRelay('https://provider.example/upbit', publicKey,
    async () => new Response('{}', { status: 200 }))
  await assert.rejects(() => unsigned.poll(new Date('2026-08-10T02:06:04.000Z')), /signature/)

  let next = response(2)
  const relay = new UpbitSignedRelay('https://provider.example/upbit', publicKey, async () => next)
  await relay.poll(new Date('2026-08-10T02:06:04.000Z'))
  next = response(1)
  await assert.rejects(() => relay.poll(new Date('2026-08-10T02:06:05.000Z')), /backwards/)
})

test('never trusts provider freshness when delivery arrives late', async () => {
  const relay = new UpbitSignedRelay('https://provider.example/upbit', publicKey, async () => response(1))
  const result = await relay.poll(new Date('2026-08-10T02:07:00.000Z'))
  assert.equal(result.events[0].freshness, 'late')
})
