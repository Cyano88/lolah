import assert from 'node:assert/strict'
import test from 'node:test'
import { enrichLiveUpbitListing } from '../src/upbit-live-enrichment.js'
import type { UpbitListingEvent } from '../src/upbit-listing-monitor.js'

const event: UpbitListingEvent = {
  schema: 'lolah-upbit-listing-v1', eventId: 'upbit_363926148',
  revisionId: '029c19b4dfcf95c72f213c2c2bdc3a07ba8f2db6', noticeId: 363926148,
  status: 'new_listing', sourceAuthority: 'upbit_official_website',
  sourceUrl: 'https://www.upbit.com/service_center/notice?id=363926148',
  title: '[거래] 콘플럭스(CFX) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
  symbols: ['CFX'], quoteMarkets: ['KRW', 'BTC', 'USDT'],
  firstPublishedAt: '2026-08-10T02:55:18.416Z', revisedAt: '2026-08-10T02:55:18.416Z',
  detectedAt: '2026-08-10T02:55:18.666Z', detectionLatencyMs: 250,
  providerSentAt: '2026-08-10T02:55:18.416Z', transportLatencyMs: 250,
  freshness: 'fresh', executionAllowed: false,
}

function response(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

test('enriches a live Upbit event through PolyDesk and Hyperliquid without enabling action', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (url.includes('polydesk')) {
      calls.push('polydesk')
      return response({
        ok: true,
        data: {
          schema: 'polydesk-market-context-v1', provider: 'polydesk',
          eventId: 'evt_upbit_363926148_cfx', matchStatus: 'no_relevant_market',
          searchedAt: '2026-08-10T02:55:19.666Z', candidates: [],
        },
      })
    }
    if (body.type === 'metaAndAssetCtxs') {
      calls.push('hyperliquid-meta')
      return response([{ universe: [{ name: 'CFX' }] }, [{ markPx: '0.0458', prevDayPx: '0.0403' }]])
    }
    if (body.type === 'l2Book') {
      calls.push('hyperliquid-book')
      return response({ levels: [
        [{ px: '0.0457', sz: '500000' }],
        [{ px: '0.0459', sz: '500000' }],
      ] })
    }
    throw new Error('Unexpected request')
  }
  const result = await enrichLiveUpbitListing({
    event,
    symbol: 'CFX',
    polydeskEndpoint: 'https://polydesk.trade/api/agent/polymarket-context',
    fetcher,
    now: () => new Date('2026-08-10T02:55:19.666Z'),
  })
  assert.equal(result.marketPosture, 'chasing_risk')
  assert.equal(result.liquidityAssessment, 'adequate')
  assert.equal(result.executionAllowed, false)
  assert.equal(result.sendAllowed, false)
  assert.deepEqual(calls.sort(), ['hyperliquid-book', 'hyperliquid-meta', 'polydesk'])
})
