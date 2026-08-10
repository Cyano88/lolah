import assert from 'node:assert/strict'
import test from 'node:test'
import type { LolahEventScan } from '../src/contracts.js'
import {
  fetchLatestCoinListingUpbitListing,
  runUpbitHistoricalShadowReplay,
  type CoinListingHistoryItem,
} from '../src/upbit-shadow-replay.js'

const listing: CoinListingHistoryItem = {
  source: 'UPBIT',
  title: '[거래] 블록스트리트(BSB) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
  url: 'https://www.upbit.com/service_center/notice?id=1766002002&view=share',
  detected_at_iso: '2026-08-07T02:55:18.416029+00:00',
  sent_time: 1786071318416,
  sent_time_iso: '2026-08-07T02:55:18.416097+00:00',
  coins: ['BSB'],
}

function scan(eventMoveFraction = 0.02): LolahEventScan {
  return {
    schema: 'lolah-event-scan-v1', eventId: 'evt_upbit_1766002002_bsb',
    state: 'context_ready', reason: 'Verified context is ready.',
    confidenceAdjustment: 'reduced', executionAllowed: false,
    polydesk: {
      schema: 'polydesk-market-context-v1', provider: 'polydesk',
      eventId: 'evt_upbit_1766002002_bsb', matchStatus: 'no_relevant_market',
      searchedAt: '2026-08-07T02:55:19.416Z', candidates: [],
    },
    hyperliquid: {
      schema: 'lolah-hyperliquid-context-v1', venue: 'hyperliquid', market: 'BSB',
      marketStatus: 'available', observedAt: '2026-08-07T02:55:19.416Z',
      markPrice: 0.102, eventReferencePrice: 0.1, eventMoveFraction,
      contextMode: 'historical_replay', historicalLiquidityAvailable: false,
      bestBid: 0.101, bestAsk: 0.103, bestBidSizeBase: 100_000,
      bestAskSizeBase: 100_000, nearTouchLiquidityUsd: 20_400, spreadBps: 196,
    },
    observedAt: '2026-08-07T02:55:19.416Z',
  }
}

test('selects the latest supported real-format Upbit listing from public history', async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    count: 2,
    items: [
      { ...listing, title: '봉크(BONK) 거래지원 종료 안내 (9/7 15:00)', coins: ['BONK'] },
      listing,
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  assert.deepEqual(await fetchLatestCoinListingUpbitListing(fetcher), listing)
})

test('selects a requested symbol instead of silently replaying another listing', async () => {
  const cfx = {
    ...listing,
    title: '[거래] 콘플럭스(CFX) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
    url: 'https://www.upbit.com/service_center/notice?id=363926148&view=share',
    coins: ['CFX'],
  }
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    count: 2, items: [listing, cfx],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  assert.deepEqual(await fetchLatestCoinListingUpbitListing(fetcher, 'cfx'), cfx)
  await assert.rejects(() => fetchLatestCoinListingUpbitListing(fetcher, 'missing'), /requested symbol/)
})

test('replays provider data with explicitly simulated timing and a non-executable assessment', async () => {
  const result = await runUpbitHistoricalShadowReplay({
    item: listing, simulatedTransportDelayMs: 250,
    scan: async request => {
      assert.equal(request.event.verification.status, 'official_source')
      assert.equal(request.event.eventType, 'listing')
      assert.equal(request.targetMarket, 'BSB')
      return scan()
    },
  })
  assert.equal(result.event.transportLatencyMs, 250)
  assert.equal(result.receiptTiming.measuredLiveLatency, false)
  assert.equal(result.contextTiming.polydesk, 'current_active_markets')
  assert.equal(result.contextTiming.historicalLiquidityAvailable, false)
  assert.equal(result.assessments[0].marketPosture, 'positive_catalyst_watch')
  assert.equal(result.assessments[0].liquidityAssessment, 'thin')
  assert.equal(result.executionAllowed, false)
  assert.equal(result.sendAllowed, false)
})

test('labels a market already up 10 percent as chasing risk', async () => {
  const result = await runUpbitHistoricalShadowReplay({ item: listing, scan: async () => scan(0.12) })
  assert.equal(result.assessments[0].marketPosture, 'chasing_risk')
})

test('fails closed when context providers are unavailable', async () => {
  const result = await runUpbitHistoricalShadowReplay({
    item: listing, scan: async () => { throw new Error('private upstream details') },
  })
  assert.equal(result.assessments[0].state, 'provider_unavailable')
  assert.equal(JSON.stringify(result).includes('private upstream details'), false)
})
