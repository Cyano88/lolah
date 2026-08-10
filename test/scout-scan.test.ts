import assert from 'node:assert/strict'
import test from 'node:test'
import { scanLolahEvent } from '../src/event-scan.js'
import { LolahNewsScout } from '../src/news-scout.js'
import { scoutAndScanPost } from '../src/scout-scan.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'

const registry: LolahSourceRegistry = {
  entities: [{ id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'], hyperliquidMarkets: ['KAITO'] }],
  sources: [{ platform: 'x', authorId: '100', username: 'kaito_official', tier: 'official_project', entityIds: ['kaito'] }],
}

test('connects a verified raw post to the existing read-only context scan', async () => {
  const now = new Date('2026-08-09T10:01:00Z')
  const result = await scoutAndScanPost({
    platform: 'x', postId: '1', authorId: '100', username: 'kaito_official',
    text: 'We will shut down Kaito operations.', createdAt: '2026-08-09T10:00:00Z',
    sourceUrl: 'https://x.com/kaito_official/status/1',
  }, new LolahNewsScout(registry), {
    scan: request => scanLolahEvent(request, {
      now: () => now,
      getPolydeskContext: async event => ({
        schema: 'polydesk-market-context-v1', provider: 'polydesk', eventId: event.eventId,
        matchStatus: 'no_relevant_market', searchedAt: now.toISOString(), candidates: [],
      }),
      getHyperliquidContext: async market => ({
        schema: 'lolah-hyperliquid-context-v1', venue: 'hyperliquid', market,
        marketStatus: 'available', observedAt: now.toISOString(), markPrice: 1.25,
      }),
    }),
  }, now)
  assert.equal(result.status, 'new_event')
  if (result.status !== 'new_event') return
  assert.equal(result.scans.length, 1)
  assert.equal(result.scans[0].state, 'context_ready')
  assert.equal(result.scans[0].executionAllowed, false)
  assert.equal(result.scans[0].polydesk.matchStatus, 'no_relevant_market')
})
