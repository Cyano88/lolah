import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { LolahEventScan } from '../src/contracts.js'
import { LolahDurableStateStore } from '../src/durable-state.js'
import { runReadOnlyPollingBatch } from '../src/polling-batch.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'

const registry: LolahSourceRegistry = {
  entities: [{ id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'], hyperliquidMarkets: ['KAITO'] }],
  sources: [
    { platform: 'x', authorId: '200', username: 'security_one', tier: 'security_researcher', entityIds: ['kaito'] },
    { platform: 'x', authorId: '300', username: 'reporter_one', tier: 'trusted_reporter', entityIds: ['kaito'] },
  ],
}

function xResponse(postId: string, authorId: string, username: string, createdAt: string) {
  return new Response(JSON.stringify({
    data: [{ id: postId, author_id: authorId, text: 'Kaito will shut down operations.', created_at: createdAt }],
    includes: { users: [{ id: authorId, username }] },
    meta: {},
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function scanResult(eventId: string, market: string, observedAt: string): LolahEventScan {
  return {
    schema: 'lolah-event-scan-v1', eventId, state: 'watch',
    reason: 'Fixture read-only scan.', confidenceAdjustment: 'blocked', executionAllowed: false,
    polydesk: {
      schema: 'polydesk-market-context-v1', provider: 'polydesk', eventId,
      matchStatus: 'no_relevant_market', searchedAt: observedAt, candidates: [],
    },
    hyperliquid: {
      schema: 'lolah-hyperliquid-context-v1', venue: 'hyperliquid', market,
      marketStatus: 'available', observedAt,
    },
    observedAt,
  }
}

test('restores clusters, rate-limits calls, and corroborates on a later polling batch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-poll-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const statePath = join(directory, 'state.json')
  const firstTime = new Date('2026-08-09T10:01:00Z')
  let fetchCount = 0
  let requestedUrl = ''
  const first = await runReadOnlyPollingBatch({
    sourceKey: 'x:crypto-news', query: 'Kaito shutdown', bearerToken: 't'.repeat(30),
    registry, store: new LolahDurableStateStore(statePath), now: () => firstTime,
    fetcher: async input => {
      fetchCount += 1
      requestedUrl = String(input)
      return xResponse('2001', '200', 'security_one', '2026-08-09T10:00:00Z')
    },
    scan: request => Promise.resolve(scanResult(request.event.eventId, request.targetMarket, firstTime.toISOString())),
  })
  assert.equal(first.status, 'processed')
  if (first.status !== 'processed') return
  assert.equal(first.posts[0].verification, 'unverified')
  const persisted = await readFile(statePath, 'utf8')
  assert.equal(persisted.includes('t'.repeat(30)), false)
  assert.equal(persisted.includes('next_token'), false)
  assert.equal(new URL(requestedUrl).searchParams.get('start_time'), '2026-08-09T09:59:00.000Z')

  const blocked = await runReadOnlyPollingBatch({
    sourceKey: 'x:crypto-news', query: 'Kaito shutdown', bearerToken: 't'.repeat(30),
    registry, store: new LolahDurableStateStore(statePath), now: () => new Date(firstTime.getTime() + 1_000),
    fetcher: async () => { fetchCount += 1; return xResponse('2002', '300', 'reporter_one', '2026-08-09T10:01:00Z') },
    scan: request => Promise.resolve(scanResult(request.event.eventId, request.targetMarket, firstTime.toISOString())),
  })
  assert.equal(blocked.status, 'rate_limited')
  assert.equal(fetchCount, 1)

  const secondTime = new Date(firstTime.getTime() + 60_001)
  const second = await runReadOnlyPollingBatch({
    sourceKey: 'x:crypto-news', query: 'Kaito shutdown', bearerToken: 't'.repeat(30),
    registry, store: new LolahDurableStateStore(statePath), now: () => secondTime,
    fetcher: async input => {
      fetchCount += 1
      requestedUrl = String(input)
      return xResponse('2002', '300', 'reporter_one', '2026-08-09T10:01:00Z')
    },
    scan: request => Promise.resolve(scanResult(request.event.eventId, request.targetMarket, secondTime.toISOString())),
  })
  assert.equal(second.status, 'processed')
  if (second.status !== 'processed') return
  assert.equal(second.posts[0].status, 'updated_event')
  assert.equal(second.posts[0].verification, 'corroborated')
  assert.equal(second.posts[0].scans.length, 1)
  assert.equal(second.contextQueue.completed, 1)
  assert.equal(new URL(requestedUrl).searchParams.get('since_id'), '2001')
  assert.equal(new URL(requestedUrl).searchParams.get('start_time'), null)
})

test('contains a context-provider failure without enabling delivery or execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-poll-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const time = new Date('2026-08-09T10:01:00Z')
  const result = await runReadOnlyPollingBatch({
    sourceKey: 'x:provider-failure', query: 'Kaito shutdown', bearerToken: 't'.repeat(30),
    registry, store: new LolahDurableStateStore(join(directory, 'state.json')), now: () => time,
    fetcher: async () => xResponse('3001', '200', 'security_one', '2026-08-09T10:00:00Z'),
    scan: async () => { throw new Error('provider secret detail') },
  })
  assert.equal(result.status, 'processed')
  if (result.status !== 'processed') return
  assert.deepEqual(result.posts[0].failedMarkets, ['KAITO'])
  assert.deepEqual(result.posts[0].scans, [])
  assert.equal(JSON.stringify(result).includes('provider secret detail'), false)
  assert.equal('sendAllowed' in result, false)
})

test('refuses a checkpoint for an incomplete paginated result window', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-poll-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const time = new Date('2026-08-09T10:01:00Z')
  let calls = 0
  const statePath = join(directory, 'state.json')
  const result = await runReadOnlyPollingBatch({
    sourceKey: 'x:paged-news', query: 'Kaito shutdown', bearerToken: 't'.repeat(30),
    registry, store: new LolahDurableStateStore(statePath), now: () => time,
    maxPages: 1,
    fetcher: async () => {
      calls += 1
      const response = xResponse('4001', '200', 'security_one', '2026-08-09T10:00:00Z')
      const body = await response.json() as Record<string, unknown>
      body.meta = { next_token: 'more-results' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    scan: request => Promise.resolve(scanResult(request.event.eventId, request.targetMarket, time.toISOString())),
  })
  assert.equal(result.status, 'processed')
  if (result.status !== 'processed') return
  assert.equal(calls, 1)
  assert.equal(result.windowComplete, false)
  assert.equal(result.checkpoint, undefined)
  assert.equal(await new LolahDurableStateStore(statePath).getCheckpoint('x:paged-news'), undefined)
})
