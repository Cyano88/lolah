import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { LolahEventScan, LolahNewsEvent } from '../src/contracts.js'
import { drainReadOnlyContextQueue } from '../src/context-retry-queue.js'
import { LolahDurableStateStore } from '../src/durable-state.js'
import { LolahNewsScout } from '../src/news-scout.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'
import type { RawXPost } from '../src/x-recent-search.js'

const registry: LolahSourceRegistry = {
  entities: [{ id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'], hyperliquidMarkets: ['KAITO'] }],
  sources: [{ platform: 'x', authorId: '100', username: 'kaito_official', tier: 'official_project', entityIds: ['kaito'] }],
}
const now = new Date('2026-08-09T10:01:00Z')
const post: RawXPost = {
  platform: 'x', postId: '5001', authorId: '100', username: 'kaito_official',
  text: 'Kaito will shut down operations.', createdAt: '2026-08-09T10:00:00Z',
  sourceUrl: 'https://x.com/kaito_official/status/5001',
}

function scan(event: LolahNewsEvent, market = 'KAITO', eventId = event.eventId): LolahEventScan {
  return {
    schema: 'lolah-event-scan-v1', eventId, state: 'context_ready',
    reason: 'Fixture read-only context.', confidenceAdjustment: 'reduced', executionAllowed: false,
    polydesk: {
      schema: 'polydesk-market-context-v1', provider: 'polydesk', eventId,
      matchStatus: 'no_relevant_market', searchedAt: now.toISOString(), candidates: [],
    },
    hyperliquid: {
      schema: 'lolah-hyperliquid-context-v1', venue: 'hyperliquid', market,
      marketStatus: 'available', observedAt: now.toISOString(),
    },
    observedAt: now.toISOString(),
  }
}

async function queuedStore(path: string) {
  const scout = new LolahNewsScout(registry)
  const result = scout.ingest(post, now)
  assert.ok('event' in result)
  if (!('event' in result)) throw new Error('Fixture event was not classified.')
  const store = new LolahDurableStateStore(path)
  await store.commitPostScoutAndContextJobs(
    post, 'accepted', scout.snapshot(), [{ event: result.event, entityIds: result.entityIds, targetMarket: 'KAITO' }], now,
  )
  return { store, event: result.event }
}

test('retries a failed provider read after durable backoff and completes after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-context-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.json')
  const { store, event } = await queuedStore(path)
  const failed = await drainReadOnlyContextQueue({ store, now: () => now, scan: async () => { throw new Error('provider detail') } })
  assert.equal(failed[0].status, 'retry_wait')
  assert.deepEqual(await drainReadOnlyContextQueue({
    store: new LolahDurableStateStore(path), now: () => new Date(now.getTime() + 29_999),
    scan: async request => scan(request.event),
  }), [])
  const completed = await drainReadOnlyContextQueue({
    store: new LolahDurableStateStore(path), now: () => new Date(now.getTime() + 30_000),
    scan: async request => scan(request.event),
  })
  assert.equal(completed[0].status, 'completed')
  const stored = (await store.listContextJobs())[0]
  assert.equal(stored.status, 'completed')
  assert.equal(stored.attempts, 2)
  assert.equal(stored.scan?.eventId, event.eventId)
  assert.equal(JSON.stringify(stored).includes('provider detail'), false)
})

test('reclaims an expired lease after a simulated worker crash', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-context-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { store } = await queuedStore(join(directory, 'state.json'))
  const first = await store.claimContextJobs(now, 1, 10_000)
  assert.equal(first[0].attempts, 1)
  assert.deepEqual(await store.claimContextJobs(new Date(now.getTime() + 9_999), 1, 10_000), [])
  const reclaimed = await store.claimContextJobs(new Date(now.getTime() + 10_000), 1, 10_000)
  assert.equal(reclaimed[0].attempts, 2)
})

test('dead-letters a context job after five failed leased attempts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-context-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { store } = await queuedStore(join(directory, 'state.json'))
  let attemptTime = now
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await drainReadOnlyContextQueue({
      store, now: () => attemptTime, scan: async () => { throw new Error('temporary') },
    })
    assert.equal(result[0].status, attempt === 5 ? 'dead_letter' : 'retry_wait')
    const job = (await store.listContextJobs())[0]
    attemptTime = new Date(Date.parse(job.nextAttemptAt))
  }
  const job = (await store.listContextJobs())[0]
  assert.equal(job.status, 'dead_letter')
  assert.equal(job.attempts, 5)
  assert.equal(job.failureCode, 'provider_unavailable')
})

test('rejects mismatched provider output and retains it as retryable work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-context-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { store } = await queuedStore(join(directory, 'state.json'))
  const result = await drainReadOnlyContextQueue({
    store, now: () => now, scan: async request => scan(request.event, 'BTC', 'evt_wrong'),
  })
  assert.equal(result[0].status, 'retry_wait')
  const job = (await store.listContextJobs())[0]
  assert.equal(job.scan, undefined)
})
