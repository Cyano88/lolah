import assert from 'node:assert/strict'
import test from 'node:test'
import type { LolahNewsEvent } from '../src/contracts.js'
import { runLolahLiveShadow } from '../src/live-shadow-runner.js'

const now = new Date('2026-08-10T12:00:00Z')
const event: LolahNewsEvent = {
  schema: 'lolah-news-event-v1',
  eventId: 'evt_shadow_test_001',
  headline: 'Kaito will shut down operations.',
  publisher: 'kaito_official',
  sourceUrl: 'https://x.com/kaito_official/status/99001',
  publishedAt: '2026-08-10T11:59:00Z',
  detectedAt: '2026-08-10T11:59:30Z',
  entities: ['Kaito'],
  eventType: 'shutdown',
  verification: { status: 'official_source', supportingSources: [] },
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('runs all three live-read components through injected provider fixtures', async () => {
  const urls: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    urls.push(url)
    if (url.startsWith('https://api.x.com/')) {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ' + 'x'.repeat(30))
      return json({
        data: [{
          id: '99001', author_id: '100', text: 'Kaito will shut down operations.',
          created_at: '2026-08-10T11:59:00Z',
        }],
        includes: { users: [{ id: '100', username: 'kaito_official' }] },
        meta: {},
      })
    }
    if (url === 'https://polydesk.trade/api/agent/polymarket-context') {
      const body = JSON.parse(String(init?.body))
      return json({
        ok: true,
        data: {
          schema: 'polydesk-market-context-v1',
          provider: 'polydesk',
          eventId: body.event.eventId,
          matchStatus: 'no_relevant_market',
          searchedAt: now.toISOString(),
          candidates: [],
        },
      })
    }
    const body = JSON.parse(String(init?.body))
    if (body.type === 'metaAndAssetCtxs') {
      return json([
        { universe: [{ name: 'KAITO' }] },
        [{ markPx: '0.50', oraclePx: '0.49', prevDayPx: '0.55', funding: '0.0002', openInterest: '900000' }],
      ])
    }
    return json({
      levels: [
        [{ px: '0.499', sz: '5000' }],
        [{ px: '0.501', sz: '4000' }],
      ],
    })
  }

  const result = await runLolahLiveShadow({
    event,
    targetMarket: 'KAITO',
    polydeskEndpoint: 'https://polydesk.trade/api/agent/polymarket-context',
    x: { query: 'Kaito shutdown', bearerToken: 'x'.repeat(30) },
    fetcher,
    now: () => now,
  })
  assert.equal(result.state, 'complete')
  assert.equal(result.components.x.status, 'ok')
  assert.equal(result.components.polydesk.status, 'ok')
  assert.equal(result.components.hyperliquid.status, 'ok')
  assert.equal(result.simulationOnly, true)
  assert.equal(result.sendAllowed, false)
  assert.equal(result.executionAllowed, false)
  assert.equal(JSON.stringify(result).includes('x'.repeat(30)), false)
  assert.equal(urls.length, 4)
})

test('reports unavailable providers independently without leaking their failures', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('polydesk.trade')) return json({ error: 'private upstream diagnostic' }, 503)
    const body = JSON.parse(String(init?.body))
    if (body.type === 'metaAndAssetCtxs') {
      return json([{ universe: [{ name: 'KAITO' }] }, [{ markPx: '0.50' }]])
    }
    return json({ levels: [[{ px: '0.499', sz: '10' }], [{ px: '0.501', sz: '10' }]] })
  }
  const result = await runLolahLiveShadow({
    event,
    targetMarket: 'KAITO',
    polydeskEndpoint: 'https://polydesk.trade/api/agent/polymarket-context',
    fetcher,
    now: () => now,
  })
  assert.equal(result.state, 'partial')
  assert.deepEqual(result.components.x, { status: 'not_configured', errorCode: 'not_configured' })
  assert.deepEqual(result.components.polydesk, {
    status: 'unavailable',
    errorCode: 'provider_unavailable',
  })
  assert.equal(result.components.hyperliquid.status, 'ok')
  assert.equal(JSON.stringify(result).includes('private upstream diagnostic'), false)
})

test('rejects noncanonical PolyDesk endpoints before any network request', async () => {
  const endpoints = [
    'https://polydesk.trade.evil.example/api/agent/polymarket-context',
    'https://polydesk.trade/api/agent/other',
    'https://user:pass@polydesk.trade/api/agent/polymarket-context',
    'https://polydesk.trade/api/agent/polymarket-context?redirect=evil',
    'http://polydesk.trade/api/agent/polymarket-context',
    'http://127.0.0.1:4317/api/agent/polymarket-context',
  ]
  let calls = 0
  for (const polydeskEndpoint of endpoints) {
    await assert.rejects(() => runLolahLiveShadow({
      event,
      targetMarket: 'KAITO',
      polydeskEndpoint,
      fetcher: async () => { calls += 1; return json({}) },
      now: () => now,
    }), /not allowlisted/)
  }
  assert.equal(calls, 0)
})

test('allows loopback HTTP only in explicit local staging mode', async () => {
  let polydeskCalls = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith('http://127.0.0.1:4317/')) {
      polydeskCalls += 1
      const body = JSON.parse(String(init?.body))
      return json({
        ok: true,
        data: {
          schema: 'polydesk-market-context-v1',
          provider: 'polydesk',
          eventId: body.event.eventId,
          matchStatus: 'no_relevant_market',
          searchedAt: now.toISOString(),
          candidates: [],
        },
      })
    }
    return json([{ universe: [] }, []])
  }
  const result = await runLolahLiveShadow({
    event,
    targetMarket: 'KAITO',
    polydeskEndpoint: 'http://127.0.0.1:4317/api/agent/polymarket-context',
    mode: 'local_staging',
    fetcher,
    now: () => now,
  })
  assert.equal(result.components.polydesk.status, 'ok')
  assert.equal(result.components.hyperliquid.status, 'ok')
  assert.equal(polydeskCalls, 1)

  await assert.rejects(() => runLolahLiveShadow({
    event,
    targetMarket: 'KAITO',
    polydeskEndpoint: 'https://polydesk.trade/api/agent/polymarket-context',
    mode: 'local_staging',
    fetcher,
    now: () => now,
  }), /not allowlisted/)
})

test('fails before reads for malformed event identity or time', async () => {
  let calls = 0
  await assert.rejects(() => runLolahLiveShadow({
    event: { ...event, eventId: 'wrong' },
    targetMarket: 'KAITO',
    polydeskEndpoint: 'https://polydesk.trade/api/agent/polymarket-context',
    fetcher: async () => { calls += 1; return json({}) },
    now: () => now,
  }), /event is invalid/)
  assert.equal(calls, 0)
})
