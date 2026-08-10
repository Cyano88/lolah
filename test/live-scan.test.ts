import assert from 'node:assert/strict'
import test from 'node:test'
import type { LolahNewsEvent } from '../src/contracts.js'
import { runLiveReadOnlyScan } from '../src/live-scan.js'

const now = new Date('2026-08-09T14:32:00Z')
const event: LolahNewsEvent = {
  schema: 'lolah-news-event-v1',
  eventId: 'evt_kaito_shutdown_2026',
  headline: 'Kaito announces an immediate shutdown of operations',
  publisher: '@KaitoAI',
  sourceUrl: 'https://x.com/KaitoAI/status/1234567890',
  publishedAt: '2026-08-09T14:30:00Z',
  detectedAt: '2026-08-09T14:30:08Z',
  entities: ['Kaito'],
  eventType: 'shutdown',
  verification: { status: 'official_source', supportingSources: [] },
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('runs the complete read-only Lolah to PolyDesk to Hyperliquid context flow', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (url.includes('/api/agent/polymarket-context')) {
      calls.push('polydesk')
      assert.equal(body.event.eventId, event.eventId)
      return json({
        ok: true,
        data: {
          schema: 'polydesk-market-context-v1',
          provider: 'polydesk',
          eventId: event.eventId,
          matchStatus: 'matched',
          searchedAt: now.toISOString(),
          match: { question: 'Will Kaito cease operations?', matchConfidence: 0.91 },
          consensus: { marketDataStatus: 'complete', probabilityNow: 0.88, probabilityBeforeNews: 0.35, observedAt: now.toISOString() },
          candidates: [],
        },
      })
    }
    if (body.type === 'metaAndAssetCtxs') {
      calls.push('hyperliquid-meta')
      return json([{ universe: [{ name: 'KAITO' }] }, [{ markPx: '0.50', oraclePx: '0.49', prevDayPx: '0.55' }]])
    }
    if (body.type === 'l2Book') {
      calls.push('hyperliquid-book')
      return json({ levels: [[{ px: '0.499', sz: '5000' }], [{ px: '0.501', sz: '4000' }]] })
    }
    throw new Error('Unexpected request')
  }
  const result = await runLiveReadOnlyScan({ event, targetMarket: 'KAITO' }, {
    polydeskEndpoint: 'http://127.0.0.1:3000/api/agent/polymarket-context',
    fetcher,
    now: () => now,
  })
  assert.equal(result.state, 'context_ready')
  assert.equal(result.executionAllowed, false)
  assert.deepEqual(calls.sort(), ['hyperliquid-book', 'hyperliquid-meta', 'polydesk'])
})
