import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { LolahEventScan } from '../src/contracts.js'
import { LolahDurableStateStore } from '../src/durable-state.js'
import { LolahNewsScout } from '../src/news-scout.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'
import type { RawXPost } from '../src/x-recent-search.js'

const registry: LolahSourceRegistry = {
  entities: [{ id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'], hyperliquidMarkets: ['KAITO'] }],
  sources: [
    { platform: 'x', authorId: '100', username: 'kaito_official', tier: 'official_project', entityIds: ['kaito'] },
    { platform: 'x', authorId: '200', username: 'reporter_one', tier: 'trusted_reporter', entityIds: ['kaito'] },
  ],
}
const now = new Date('2026-08-09T10:01:00Z')

function post(authorId = '100'): RawXPost {
  const username = authorId === '100' ? 'kaito_official' : 'reporter_one'
  const postId = authorId === '100' ? '6001' : '6002'
  return {
    platform: 'x', postId, authorId, username,
    text: 'Kaito will shut down operations.', createdAt: '2026-08-09T10:00:00Z',
    sourceUrl: 'https://x.com/' + username + '/status/' + postId,
  }
}

function scan(eventId: string, state: 'context_ready' | 'no_trade' = 'context_ready'): LolahEventScan {
  return {
    schema: 'lolah-event-scan-v1', eventId, state,
    reason: state === 'context_ready' ? 'Verified context is ready.' : 'Ambiguous market match blocked actionability.',
    confidenceAdjustment: state === 'context_ready' ? 'normal' : 'blocked', executionAllowed: false,
    polydesk: {
      schema: 'polydesk-market-context-v1', provider: 'polydesk', eventId,
      matchStatus: state === 'context_ready' ? 'no_relevant_market' : 'ambiguous',
      searchedAt: now.toISOString(), candidates: [],
    },
    hyperliquid: {
      schema: 'lolah-hyperliquid-context-v1', venue: 'hyperliquid', market: 'KAITO',
      marketStatus: 'available', observedAt: now.toISOString(),
    },
    observedAt: now.toISOString(),
  }
}

async function completeContext(store: LolahDurableStateStore, sourcePost = post(), scanState: 'context_ready' | 'no_trade' = 'context_ready') {
  const scout = new LolahNewsScout(registry)
  const result = scout.ingest(sourcePost, now)
  assert.ok('event' in result)
  if (!('event' in result)) throw new Error('Fixture event was not classified.')
  await store.commitPostScoutAndContextJobs(sourcePost, 'accepted', scout.snapshot(), [{
    event: result.event, entityIds: result.entityIds, targetMarket: 'KAITO',
  }], now)
  const job = (await store.claimContextJobs(now, 1, 60_000))[0]
  await store.completeContextJob(job.jobId, scan(result.event.eventId, scanState), now)
}

test('prepares one restart-safe recipient-bound draft and never exposes another recipient', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-draft-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.json')
  const store = new LolahDurableStateStore(path)
  await store.createWatch({
    recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'],
    expiresAt: new Date(now.getTime() + 60_000),
  }, now)
  await completeContext(store)
  const first = await store.prepareAlertDrafts(now)
  const second = await new LolahDurableStateStore(path).prepareAlertDrafts(new Date(now.getTime() + 1_000))
  assert.equal(first.length, 1)
  assert.deepEqual(second, [])
  assert.equal(first[0].recipientId, 'agent:buyer-123')
  assert.equal(first[0].sendAllowed, false)
  assert.equal(first[0].alertClass, 'context_ready')
  assert.equal((await store.listAlertDrafts('agent:buyer-123')).length, 1)
  assert.deepEqual(await store.listAlertDrafts('agent:other-999'), [])
})

test('suppresses drafts for expired, cancelled, and non-matching watches', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-draft-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(join(directory, 'state.json'))
  await store.createWatch({
    recipientId: 'agent:expired-123', entityIds: ['kaito'], targetMarkets: ['KAITO'],
    expiresAt: new Date(now.getTime() + 1_000),
  }, now)
  const cancelled = await store.createWatch({
    recipientId: 'agent:cancelled-123', entityIds: ['kaito'], targetMarkets: ['KAITO'],
    expiresAt: new Date(now.getTime() + 60_000),
  }, now)
  await store.cancelWatch(cancelled.watchId, cancelled.recipientId)
  await store.createWatch({
    recipientId: 'agent:wrong-123', entityIds: ['bitcoin'], targetMarkets: ['BTC'],
    expiresAt: new Date(now.getTime() + 60_000),
  }, now)
  await completeContext(store)
  assert.deepEqual(await store.prepareAlertDrafts(new Date(now.getTime() + 2_000)), [])
})

test('suppresses unverified events even when context processing completed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-draft-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(join(directory, 'state.json'))
  await store.createWatch({
    recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'],
    expiresAt: new Date(now.getTime() + 60_000),
  }, now)
  await completeContext(store, post('200'))
  assert.deepEqual(await store.prepareAlertDrafts(now), [])
})

test('labels completed no_trade context as risk-blocked without adding an action', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-draft-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(join(directory, 'state.json'))
  await store.createWatch({
    recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'],
    expiresAt: new Date(now.getTime() + 60_000),
  }, now)
  await completeContext(store, post(), 'no_trade')
  const drafts = await store.prepareAlertDrafts(now)
  assert.equal(drafts[0].alertClass, 'risk_blocked')
  assert.equal(drafts[0].scanState, 'no_trade')
  assert.equal('direction' in drafts[0], false)
  assert.equal('order' in drafts[0], false)
})

test('supersedes an older draft when stronger evidence reopens the event revision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-draft-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(join(directory, 'state.json'))
  await store.createWatch({
    recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'],
    expiresAt: new Date(now.getTime() + 60_000),
  }, now)
  const scout = new LolahNewsScout(registry)
  const official = scout.ingest(post('100'), now)
  assert.ok('event' in official)
  if (!('event' in official)) return
  await store.commitPostScoutAndContextJobs(post('100'), 'accepted', scout.snapshot(), [{
    event: official.event, entityIds: official.entityIds, targetMarket: 'KAITO',
  }], now)
  let job = (await store.claimContextJobs(now, 1, 60_000))[0]
  await store.completeContextJob(job.jobId, scan(official.event.eventId), now)
  await store.prepareAlertDrafts(now)
  await store.stageAlertDraftsToOutbox(now)

  const stronger = scout.ingest(post('200'), new Date(now.getTime() + 1_000))
  assert.ok('event' in stronger)
  if (!('event' in stronger)) return
  await store.commitPostScoutAndContextJobs(post('200'), 'accepted', scout.snapshot(), [{
    event: stronger.event, entityIds: stronger.entityIds, targetMarket: 'KAITO',
  }], new Date(now.getTime() + 1_000))
  job = (await store.claimContextJobs(new Date(now.getTime() + 1_000), 1, 60_000))[0]
  await store.completeContextJob(job.jobId, scan(stronger.event.eventId), new Date(now.getTime() + 1_000))
  await store.prepareAlertDrafts(new Date(now.getTime() + 1_000))
  const staged = await store.stageAlertDraftsToOutbox(new Date(now.getTime() + 1_000))

  const current = await store.listAlertDrafts('agent:buyer-123')
  const history = await store.listAlertDrafts('agent:buyer-123', true)
  assert.equal(current.length, 1)
  assert.equal(current[0].status, 'prepared')
  assert.deepEqual(history.map(draft => draft.status).sort(), ['prepared', 'superseded'])
  assert.deepEqual(staged, { created: 1, superseded: 1 })
  assert.deepEqual(
    (await store.listRecipientOutbox('agent:buyer-123')).map(item => item.status).sort(),
    ['pending', 'superseded'],
  )
})
