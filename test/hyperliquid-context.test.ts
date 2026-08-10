import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchHyperliquidHistoricalReplayContext,
  fetchHyperliquidMarketContext,
} from '../src/hyperliquid-context.js'

function response(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('reads an available Hyperliquid perp and calculates current market conditions', async () => {
  const requests: unknown[] = []
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    requests.push(body)
    if (body.type === 'metaAndAssetCtxs') {
      return response([
        { universe: [{ name: 'BTC' }, { name: 'KAITO' }] },
        [
          { markPx: '100000', oraclePx: '99950', prevDayPx: '98000', funding: '0.00001', openInterest: '500' },
          { markPx: '0.50', oraclePx: '0.49', prevDayPx: '0.55', funding: '0.0002', openInterest: '900000' },
        ],
      ])
    }
    return response({
      coin: 'KAITO',
      levels: [
        [{ px: '0.499', sz: '5000', n: 2 }],
        [{ px: '0.501', sz: '4000', n: 3 }],
      ],
    })
  }
  const result = await fetchHyperliquidMarketContext('kaito', fetcher, new Date('2026-08-09T14:32:00Z'))
  assert.equal(result.marketStatus, 'available')
  assert.equal(result.markPrice, 0.5)
  assert.equal(result.dayChangeFraction, -0.090909)
  assert.equal(result.bestBid, 0.499)
  assert.equal(result.bestAsk, 0.501)
  assert.equal(result.bestBidSizeBase, 5000)
  assert.equal(result.bestAskSizeBase, 4000)
  assert.equal(result.nearTouchLiquidityUsd, 4499)
  assert.equal(result.spreadBps, 40)
  assert.deepEqual(requests, [{ type: 'metaAndAssetCtxs' }, { type: 'l2Book', coin: 'KAITO' }])
})

test('returns not_found without querying a non-existent order book', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls += 1
    return response([{ universe: [{ name: 'BTC' }] }, [{ markPx: '100000' }]])
  }
  const result = await fetchHyperliquidMarketContext('KAITO', fetcher)
  assert.equal(result.marketStatus, 'not_found')
  assert.equal(calls, 1)
})

test('rejects malformed metadata instead of guessing market availability', async () => {
  const fetcher: typeof fetch = async () => response({ universe: [] })
  await assert.rejects(() => fetchHyperliquidMarketContext('KAITO', fetcher), /invalid market metadata/)
})

test('reconstructs historical event movement from timestamped candles without inventing liquidity', async () => {
  const eventAt = new Date('2026-07-31T05:00:08.944Z')
  const requests: unknown[] = []
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    requests.push(body)
    if (body.type === 'metaAndAssetCtxs') {
      return response([{ universe: [{ name: 'CFX' }] }, [{ markPx: '0.05' }]])
    }
    return response([
      { t: Date.parse('2026-07-31T04:55:00Z'), T: Date.parse('2026-07-31T04:59:59.999Z'), c: '0.04' },
      { t: Date.parse('2026-07-31T05:00:00Z'), T: Date.parse('2026-07-31T05:04:59.999Z'), c: '0.046' },
    ])
  }
  const result = await fetchHyperliquidHistoricalReplayContext('CFX', eventAt, fetcher)
  assert.equal(result.contextMode, 'historical_replay')
  assert.equal(result.eventReferencePrice, 0.04)
  assert.equal(result.markPrice, 0.046)
  assert.equal(result.eventMoveFraction, 0.15)
  assert.equal(result.replayWindowMinutes, 5)
  assert.equal(result.historicalLiquidityAvailable, false)
  assert.equal(result.nearTouchLiquidityUsd, undefined)
  assert.deepEqual(requests, [
    { type: 'metaAndAssetCtxs' },
    { type: 'candleSnapshot', req: {
      coin: 'CFX', interval: '5m',
      startTime: eventAt.getTime() - 24 * 60 * 60_000,
      endTime: eventAt.getTime() + 10 * 60_000,
    } },
  ])
})
