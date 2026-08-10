import assert from 'node:assert/strict'
import test from 'node:test'
import type { HyperliquidMarketContext, LolahNewsEvent, PolydeskMarketContext } from '../src/contracts.js'
import { scanLolahEvent } from '../src/event-scan.js'
import {
  preflightPolydeskMarketContext,
  requestPolydeskMarketContext,
} from '../src/polydesk-client.js'

const now = new Date('2026-08-09T14:32:00.000Z')
const event: LolahNewsEvent = {
  schema: 'lolah-news-event-v1',
  eventId: 'evt_kaito_shutdown_2026',
  headline: 'Kaito announces an immediate shutdown of operations',
  publisher: '@KaitoAI',
  sourceUrl: 'https://x.com/KaitoAI/status/1234567890',
  publishedAt: '2026-08-09T14:30:00.000Z',
  detectedAt: '2026-08-09T14:30:08.000Z',
  entities: ['Kaito'],
  eventType: 'shutdown',
  verification: { status: 'official_source', supportingSources: [] },
}

function polydesk(matchStatus: PolydeskMarketContext['matchStatus'] = 'matched'): PolydeskMarketContext {
  return {
    schema: 'polydesk-market-context-v1',
    provider: 'polydesk',
    eventId: event.eventId,
    matchStatus,
    searchedAt: now.toISOString(),
    match: matchStatus === 'matched' ? { question: 'Will Kaito cease operations?', matchConfidence: 0.91 } : undefined,
    consensus: matchStatus === 'matched' ? { marketDataStatus: 'complete', probabilityNow: 0.88, probabilityBeforeNews: 0.35, observedAt: now.toISOString() } : undefined,
    candidates: [],
  }
}

function hyperliquid(status: HyperliquidMarketContext['marketStatus'] = 'available'): HyperliquidMarketContext {
  return {
    schema: 'lolah-hyperliquid-context-v1',
    venue: 'hyperliquid',
    market: 'KAITO',
    marketStatus: status,
    observedAt: now.toISOString(),
    markPrice: status === 'available' ? 0.5 : undefined,
  }
}

test('consumes a valid PolyDesk endpoint response and pins it to the requested event', async () => {
  let body = ''
  let authorization = ''
  const fetcher: typeof fetch = async (_input, init) => {
    body = String(init?.body ?? '')
    authorization = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    return new Response(JSON.stringify({ ok: true, data: polydesk() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const token = 'p'.repeat(40)
  const result = await requestPolydeskMarketContext(
    'https://polydesk.trade/api/agent/polymarket-context',
    event,
    fetcher,
    token,
  )
  assert.equal(result.matchStatus, 'matched')
  assert.equal(JSON.parse(body).event.eventId, event.eventId)
  assert.equal(authorization, `Bearer ${token}`)
})

test('never sends a context token to a noncanonical endpoint', async () => {
  let calls = 0
  await assert.rejects(() => requestPolydeskMarketContext(
    'https://polydesk.trade.evil.example/api/agent/polymarket-context',
    event,
    async () => {
      calls += 1
      throw new Error('must not run')
    },
    'p'.repeat(40),
  ), /not allowlisted/)
  assert.equal(calls, 0)
})

test('preflights the authenticated read-only bridge without sending an event', async () => {
  const token = 'p'.repeat(40)
  let url = ''
  let method = ''
  let authorization = ''
  let body: unknown = 'not-observed'
  const result = await preflightPolydeskMarketContext(
    'https://polydesk.trade/api/agent/polymarket-context',
    token,
    async (input, init) => {
      url = String(input)
      method = String(init?.method)
      authorization = String((init?.headers as Record<string, string>).Authorization)
      body = init?.body
      return new Response(JSON.stringify({
        ok: true,
        data: {
          schema: 'polydesk-market-context-health-v1',
          service: 'polydesk',
          readOnly: true,
          executionAllowed: false,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  )
  assert.equal(url, 'https://polydesk.trade/api/agent/polymarket-context/health')
  assert.equal(method, 'GET')
  assert.equal(authorization, `Bearer ${token}`)
  assert.equal(body, undefined)
  assert.equal(result.executionAllowed, false)
})

test('returns context_ready without creating a trade command', async () => {
  const result = await scanLolahEvent({ event, targetMarket: 'KAITO' }, {
    getPolydeskContext: async () => polydesk(),
    getHyperliquidContext: async () => hyperliquid(),
    now: () => now,
  })
  assert.equal(result.state, 'context_ready')
  assert.equal(result.confidenceAdjustment, 'normal')
  assert.equal(result.executionAllowed, false)
  assert.equal('side' in result, false)
})

test('keeps no-market news usable with reduced confidence', async () => {
  const result = await scanLolahEvent({ event, targetMarket: 'KAITO' }, {
    getPolydeskContext: async () => polydesk('no_relevant_market'),
    getHyperliquidContext: async () => hyperliquid(),
    now: () => now,
  })
  assert.equal(result.state, 'context_ready')
  assert.equal(result.confidenceAdjustment, 'reduced')
})

test('blocks ambiguous markets, unverified news, unavailable perps, and stale events', async () => {
  const base = {
    getPolydeskContext: async () => polydesk(),
    getHyperliquidContext: async () => hyperliquid(),
    now: () => now,
  }
  const ambiguous = await scanLolahEvent({ event, targetMarket: 'KAITO' }, { ...base, getPolydeskContext: async () => polydesk('ambiguous') })
  const unverified = await scanLolahEvent({ event: { ...event, verification: { status: 'unverified', supportingSources: [] } }, targetMarket: 'KAITO' }, base)
  const missing = await scanLolahEvent({ event, targetMarket: 'KAITO' }, { ...base, getHyperliquidContext: async () => hyperliquid('not_found') })
  const stale = await scanLolahEvent({ event: { ...event, detectedAt: '2026-08-09T13:00:00Z' }, targetMarket: 'KAITO' }, base)
  assert.deepEqual([ambiguous.state, unverified.state, missing.state, stale.state], ['no_trade', 'watch', 'no_trade', 'no_trade'])
  assert.deepEqual([ambiguous.executionAllowed, unverified.executionAllowed, missing.executionAllowed, stale.executionAllowed], [false, false, false, false])
})
