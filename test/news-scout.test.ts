import assert from 'node:assert/strict'
import test from 'node:test'
import { LolahNewsScout } from '../src/news-scout.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'
import type { RawXPost } from '../src/x-recent-search.js'

const registry: LolahSourceRegistry = {
  entities: [
    { id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'], hyperliquidMarkets: ['KAITO'] },
    { id: 'other', name: 'Other Protocol', aliases: ['Other Protocol'], symbols: ['OTHER'], hyperliquidMarkets: ['OTHER'] },
  ],
  sources: [
    { platform: 'x', authorId: '100', username: 'kaito_official', tier: 'official_project', entityIds: ['kaito'] },
    { platform: 'x', authorId: '200', username: 'security_one', tier: 'security_researcher', entityIds: ['kaito', 'other'] },
    { platform: 'x', authorId: '300', username: 'reporter_one', tier: 'trusted_reporter', entityIds: ['kaito', 'other'] },
  ],
}

function post(overrides: Partial<RawXPost> = {}): RawXPost {
  return {
    platform: 'x', postId: '1', authorId: '100', username: 'kaito_official',
    text: 'We will shut down Kaito operations.', createdAt: '2026-08-09T10:00:00Z',
    sourceUrl: 'https://x.com/kaito_official/status/1', ...overrides,
  }
}
const detectedAt = new Date('2026-08-09T10:01:00Z')

test('accepts an official event and maps the permitted Hyperliquid market', () => {
  const result = new LolahNewsScout(registry).ingest(post(), detectedAt)
  assert.equal(result.status, 'new_event')
  if (result.status !== 'new_event') return
  assert.equal(result.event.verification.status, 'official_source')
  assert.deepEqual(result.targetMarkets, ['KAITO'])
})

test('ignores an unknown author even when its username impersonates an official source', () => {
  const result = new LolahNewsScout(registry).ingest(post({ authorId: '999', username: 'kaito_official' }), detectedAt)
  assert.equal(result.status, 'ignored')
})

test('marks the same post ID as a duplicate', () => {
  const scout = new LolahNewsScout(registry)
  scout.ingest(post(), detectedAt)
  assert.equal(scout.ingest(post(), detectedAt).status, 'duplicate')
})

test('requires two distinct curated sources before corroborating a report', () => {
  const scout = new LolahNewsScout(registry)
  const first = scout.ingest(post({ postId: '2', authorId: '200', username: 'security_one', sourceUrl: 'https://x.com/security_one/status/2' }), detectedAt)
  assert.equal(first.status, 'new_event')
  if (first.status !== 'new_event') return
  assert.equal(first.event.verification.status, 'unverified')
  const second = scout.ingest(post({ postId: '3', authorId: '300', username: 'reporter_one', sourceUrl: 'https://x.com/reporter_one/status/3' }), detectedAt)
  assert.equal(second.status, 'updated_event')
  if (second.status !== 'updated_event') return
  assert.equal(second.event.verification.status, 'corroborated')
  assert.equal(second.event.verification.supportingSources.length, 1)
})

test('restores semantic clusters and corroborates across a process restart', () => {
  const firstScout = new LolahNewsScout(registry)
  const first = firstScout.ingest(post({ postId: '30', authorId: '200', username: 'security_one', sourceUrl: 'https://x.com/security_one/status/30' }), detectedAt)
  assert.equal(first.status, 'new_event')
  const restarted = new LolahNewsScout(registry, firstScout.snapshot())
  const second = restarted.ingest(post({ postId: '31', authorId: '300', username: 'reporter_one', sourceUrl: 'https://x.com/reporter_one/status/31' }), detectedAt)
  assert.equal(second.status, 'updated_event')
  if (second.status !== 'updated_event') return
  assert.equal(second.event.verification.status, 'corroborated')
})

test('fails closed when a restored semantic cluster is tampered with', () => {
  const scout = new LolahNewsScout(registry)
  scout.ingest(post(), detectedAt)
  const snapshot = scout.snapshot()
  snapshot.clusters[0].event.eventId = 'evt_tampered'
  assert.throws(() => new LolahNewsScout(registry, snapshot), /invalid event/)
})

test('keeps the highest-priority catalyst when one post contains multiple event types', () => {
  const result = new LolahNewsScout(registry).ingest(post({ text: 'Kaito was exploited and will shut down.' }), detectedAt)
  assert.equal(result.status, 'new_event')
  if (result.status !== 'new_event') return
  assert.equal(result.event.eventType, 'exploit')
})

test('rejects event denials rather than treating them as events', () => {
  const result = new LolahNewsScout(registry).ingest(post({ text: 'We will not shut down Kaito operations.' }), detectedAt)
  assert.equal(result.status, 'ignored')
})

test('rejects stale posts and source URLs that do not match the post identity', () => {
  const scout = new LolahNewsScout(registry)
  assert.equal(scout.ingest(post({ postId: '10', createdAt: '2026-08-09T08:00:00Z', sourceUrl: 'https://x.com/kaito_official/status/10' }), detectedAt).status, 'ignored')
  assert.equal(scout.ingest(post({ postId: '11', sourceUrl: 'https://example.com/kaito_official/status/11' }), detectedAt).status, 'ignored')
})

test('a second post from the same source cannot self-corroborate', () => {
  const scout = new LolahNewsScout(registry)
  scout.ingest(post({ postId: '20', authorId: '200', username: 'security_one', sourceUrl: 'https://x.com/security_one/status/20' }), detectedAt)
  const result = scout.ingest(post({ postId: '21', authorId: '200', username: 'security_one', sourceUrl: 'https://x.com/security_one/status/21' }), detectedAt)
  assert.equal(result.status, 'updated_event')
  if (result.status !== 'updated_event') return
  assert.equal(result.event.verification.status, 'unverified')
})

test('does not guess an entity for a multi-entity non-official source', () => {
  const result = new LolahNewsScout(registry).ingest(post({ authorId: '200', text: 'A project will shut down.', username: 'security_one' }), detectedAt)
  assert.equal(result.status, 'ignored')
})

test('matches automatically discovered markets only as case-sensitive tickers', () => {
  const dynamic: LolahSourceRegistry = {
    entities: [
      { id: 'hl_cys', name: 'CYS', aliases: ['CYS'], symbols: ['CYS'], hyperliquidMarkets: ['CYS'], matchMode: 'symbol_strict' },
      { id: 'hl_one', name: 'ONE', aliases: ['ONE'], symbols: ['ONE'], hyperliquidMarkets: ['ONE'], matchMode: 'symbol_strict' },
    ],
    sources: [{ platform: 'x', authorId: '100', username: 'kaito_official', tier: 'official_project', entityIds: ['*'] }],
  }
  const scout = new LolahNewsScout(dynamic)
  assert.equal(scout.ingest(post({ postId: '40', text: 'We will list cys tomorrow.', sourceUrl: 'https://x.com/kaito_official/status/40' }), detectedAt).status, 'ignored')
  const result = scout.ingest(post({ postId: '41', text: 'We will list CYS tomorrow.', sourceUrl: 'https://x.com/kaito_official/status/41' }), detectedAt)
  assert.equal(result.status, 'new_event')
  if (result.status !== 'new_event') return
  assert.deepEqual(result.targetMarkets, ['CYS'])
})

test('accepts an official FanVibe buyback and maps FVB for an explicit venue availability check', () => {
  const fanvibe: LolahSourceRegistry = {
    entities: [{
      id: 'fvb', name: 'FanVibe', aliases: ['FanVibe', 'FanVibe Token'], symbols: ['FVB'],
      hyperliquidMarkets: ['FVB'],
    }],
    sources: [{
      platform: 'x', authorId: '400', username: 'fanvibeonx', tier: 'official_project',
      category: 'project', entityIds: ['fvb'],
    }],
  }
  const result = new LolahNewsScout(fanvibe).ingest(post({
    postId: '50', authorId: '400', username: 'FanVibeOnX',
    text: 'FanVibe treasury buyback: we will buy back tokens and hold the purchased FVB.',
    sourceUrl: 'https://x.com/FanVibeOnX/status/50',
  }), detectedAt)
  assert.equal(result.status, 'new_event')
  if (result.status !== 'new_event') return
  assert.equal(result.event.eventType, 'buyback')
  assert.equal(result.event.verification.status, 'official_source')
  assert.deepEqual(result.entityIds, ['fvb'])
  assert.deepEqual(result.targetMarkets, ['FVB'])
})
