import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LolahDurableStateStore } from '../src/durable-state.js'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-state-'))
  return { directory, path: join(directory, 'state.json') }
}

const now = new Date('2026-08-09T10:00:00Z')
const later = (milliseconds: number) => new Date(now.getTime() + milliseconds)

test('persists watches and retrieves them after a store restart', async t => {
  const item = await fixture()
  t.after(() => rm(item.directory, { recursive: true, force: true }))
  const watch = await new LolahDurableStateStore(item.path).createWatch({
    recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'], expiresAt: later(60_000),
  }, now)
  const restarted = new LolahDurableStateStore(item.path)
  const active = await restarted.activeWatches({ entityIds: ['kaito'], targetMarkets: ['KAITO'] }, later(30_000))
  assert.equal(active[0].watchId, watch.watchId)
  assert.equal(active[0].recipientId, 'agent:buyer-123')
})

test('serializes concurrent writers that target the same state path', async t => {
  const item = await fixture()
  t.after(() => rm(item.directory, { recursive: true, force: true }))
  const first = new LolahDurableStateStore(item.path)
  const second = new LolahDurableStateStore(item.path)
  await Promise.all([
    first.createWatch({ recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'], expiresAt: later(60_000) }, now),
    second.createWatch({ recipientId: 'agent:buyer-456', entityIds: ['bitcoin'], targetMarkets: ['BTC'], expiresAt: later(60_000) }, now),
  ])
  const state = JSON.parse(await readFile(item.path, 'utf8')) as { watches: unknown[] }
  assert.equal(state.watches.length, 2)
})

test('expires watches independently of the chat session', async t => {
  const item = await fixture()
  t.after(() => rm(item.directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(item.path)
  await store.createWatch({ recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'], expiresAt: later(60_000) }, now)
  assert.deepEqual(await store.activeWatches({ entityIds: ['kaito'], targetMarkets: ['KAITO'] }, later(60_001)), [])
})

test('prevents cancellation and delivery preparation for the wrong recipient', async t => {
  const item = await fixture()
  t.after(() => rm(item.directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(item.path)
  const watch = await store.createWatch({ recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'], expiresAt: later(60_000) }, now)
  await assert.rejects(() => store.cancelWatch(watch.watchId, 'agent:attacker-999'), /unavailable/)
  await assert.rejects(() => store.prepareDelivery(watch.watchId, 'agent:attacker-999', {
    eventId: 'evt_123', entityIds: ['kaito'], targetMarkets: ['KAITO'],
  }, later(1_000)), /unavailable/)
})

test('prepares a recipient-bound non-sending envelope and deduplicates it', async t => {
  const item = await fixture()
  t.after(() => rm(item.directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(item.path)
  const watch = await store.createWatch({ recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'], expiresAt: later(60_000) }, now)
  const candidate = { eventId: 'evt_123', entityIds: ['kaito'], targetMarkets: ['KAITO'] }
  const first = await store.prepareDelivery(watch.watchId, watch.recipientId, candidate, later(1_000))
  const second = await new LolahDurableStateStore(item.path).prepareDelivery(watch.watchId, watch.recipientId, candidate, later(2_000))
  assert.deepEqual(second, first)
  assert.equal(first.sendAllowed, false)
})

test('records exact post replays but rejects changed content under the same post ID', async t => {
  const item = await fixture()
  t.after(() => rm(item.directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(item.path)
  const post = { postId: '123', authorId: '100', text: 'Kaito will shut down.', createdAt: now.toISOString(), sourceUrl: 'https://x.com/kaito/status/123' }
  assert.equal(await store.recordPost(post, 'accepted', now), 'recorded')
  assert.equal(await new LolahDurableStateStore(item.path).recordPost(post, 'accepted', later(1_000)), 'duplicate')
  await assert.rejects(() => store.recordPost({ ...post, text: 'Altered replay' }, 'accepted', later(2_000)), /conflicts/)
})

test('persists monotonic polling checkpoints without storing API cursors', async t => {
  const item = await fixture()
  t.after(() => rm(item.directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(item.path)
  await store.putCheckpoint({ sourceKey: 'x:kaito', newestPostId: '123', newestCreatedAt: now.toISOString() }, now)
  const checkpoint = await new LolahDurableStateStore(item.path).getCheckpoint('x:kaito')
  assert.equal(checkpoint?.newestPostId, '123')
  assert.equal((await readFile(item.path, 'utf8')).includes('next_token'), false)
  await assert.rejects(() => store.putCheckpoint({
    sourceKey: 'x:kaito', newestPostId: '122', newestCreatedAt: new Date(now.getTime() - 1).toISOString(),
  }, later(1_000)), /backwards/)
})

test('fails closed when durable state is corrupt', async t => {
  const item = await fixture()
  t.after(() => rm(item.directory, { recursive: true, force: true }))
  await writeFile(item.path, '{not-json', 'utf8')
  await assert.rejects(() => new LolahDurableStateStore(item.path).getCheckpoint('x:kaito'), /invalid JSON/)
})
