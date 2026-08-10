import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CoinListingUpbitSource,
  coinListingFrames,
  parseCoinListingFrame,
  type CoinListingFrame,
} from '../src/coinlisting-upbit-source.js'

const title = 'BTC, USDT \uB9C8\uCF13 \uC2E0\uADDC \uAC70\uB798\uC9C0\uC6D0 \uC548\uB0B4 (CYS, ICNT)'

function frame(overrides: Record<string, unknown> = {}, receivedAt = new Date('2026-08-10T02:06:04Z')): CoinListingFrame {
  return {
    receivedAt,
    text: JSON.stringify({
      source: 'UPBIT',
      title,
      url: 'https://upbit.com/service_center/notice?id=6458',
      detected_at_iso: '2026-08-10T02:05:54.250Z',
      sent_time: 1786327554500,
      ...overrides,
    }),
  }
}

async function* stream(...values: CoinListingFrame[]) {
  for (const value of values) yield value
}

test('parses a raw Upbit listing frame and measures provider-to-Lolah latency', () => {
  const event = parseCoinListingFrame(frame())
  assert.ok(event)
  assert.deepEqual(event.symbols, ['CYS', 'ICNT'])
  assert.deepEqual(event.quoteMarkets, ['BTC', 'USDT'])
  assert.equal(event.sourceUrl, 'https://www.upbit.com/service_center/notice?id=6458')
  assert.equal(event.detectionLatencyMs, 9_750)
  assert.equal(event.providerSentAt, '2026-08-10T02:05:54.500Z')
  assert.equal(event.transportLatencyMs, 9_500)
  assert.equal(event.freshness, 'fresh')
  assert.equal(event.executionAllowed, false)
})

test('ignores other exchanges and non-listing Upbit notices', () => {
  assert.equal(parseCoinListingFrame(frame({ source: 'BINANCE' })), undefined)
  assert.equal(parseCoinListingFrame(frame({ title: '\uC785\uCD9C\uAE08 \uC77C\uC2DC \uC911\uC9C0' })), undefined)
})

test('parses the alternate Upbit digital-asset-add title', () => {
  const alternate = 'KRW, USDT \uB9C8\uCF13 \uB514\uC9C0\uD138 \uC790\uC0B0 \uCD94\uAC00 (ALLO)'
  const event = parseCoinListingFrame(frame({ title: alternate }))
  assert.deepEqual(event?.symbols, ['ALLO'])
  assert.deepEqual(event?.quoteMarkets, ['KRW', 'USDT'])
})

test('rejects a provider frame that does not link to the official Upbit notice', () => {
  assert.throws(() => parseCoinListingFrame(frame({ url: 'https://example.com/service_center/notice?id=6458' })), /URL/)
})

test('persists revisions and skips an exact provider replay', async () => {
  const updated = frame({ title: title + ' (update)' }, new Date('2026-08-10T02:06:05Z'))
  const source = new CoinListingUpbitSource(stream(frame(), frame(), updated))
  const first = await source.poll()
  const second = await source.poll()
  assert.equal(first.events[0].status, 'new_listing')
  assert.equal(second.events[0].status, 'listing_update')
  assert.equal(source.snapshot().revisions.length, 1)
})

test('marks an otherwise valid provider event late at actual receipt time', () => {
  const event = parseCoinListingFrame(frame({}, new Date('2026-08-10T02:07:00Z')))
  assert.equal(event?.freshness, 'late')
})

test('rejects an invalid provider sent time', () => {
  assert.throws(() => parseCoinListingFrame(frame({ sent_time: 0 })), /sent time/)
})

test('rejects a non-allowlisted endpoint without exposing the provider key', async () => {
  const apiKey = 'provider-key-that-must-stay-private'
  const controller = new AbortController()
  const iterator = coinListingFrames({
    apiKey,
    endpoint: 'wss://example.com/feed',
    signal: controller.signal,
  })
  await assert.rejects(() => iterator.next(), error => {
    assert.equal(String(error).includes(apiKey), false)
    return /not allowed/.test(String(error))
  })
})
