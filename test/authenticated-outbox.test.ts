import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acknowledgeSimulatedAlert,
  pullSimulatedAlerts,
  type RecipientSessionVerifier,
} from '../src/authenticated-outbox.js'
import type { LolahEventScan } from '../src/contracts.js'
import { LolahDurableStateStore } from '../src/durable-state.js'
import { LolahNewsScout } from '../src/news-scout.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'
import type { RawXPost } from '../src/x-recent-search.js'

const registry: LolahSourceRegistry = {
  entities: [{ id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'], hyperliquidMarkets: ['KAITO'] }],
  sources: [{ platform: 'x', authorId: '100', username: 'kaito_official', tier: 'official_project', entityIds: ['kaito'] }],
}
const now = new Date('2026-08-09T10:01:00Z')
const sourcePost: RawXPost = {
  platform: 'x', postId: '7001', authorId: '100', username: 'kaito_official',
  text: 'Kaito will shut down operations.', createdAt: '2026-08-09T10:00:00Z',
  sourceUrl: 'https://x.com/kaito_official/status/7001',
}

function scan(eventId: string): LolahEventScan {
  return {
    schema: 'lolah-event-scan-v1', eventId, state: 'context_ready',
    reason: 'Verified read-only context is ready.', confidenceAdjustment: 'reduced', executionAllowed: false,
    polydesk: {
      schema: 'polydesk-market-context-v1', provider: 'polydesk', eventId,
      matchStatus: 'no_relevant_market', searchedAt: now.toISOString(), candidates: [],
    },
    hyperliquid: {
      schema: 'lolah-hyperliquid-context-v1', venue: 'hyperliquid', market: 'KAITO',
      marketStatus: 'available', observedAt: now.toISOString(),
    },
    observedAt: now.toISOString(),
  }
}

async function preparedStore(path: string) {
  const store = new LolahDurableStateStore(path)
  await store.createWatch({
    recipientId: 'agent:buyer-123', entityIds: ['kaito'], targetMarkets: ['KAITO'],
    expiresAt: new Date(now.getTime() + 60 * 60_000),
  }, now)
  const scout = new LolahNewsScout(registry)
  const result = scout.ingest(sourcePost, now)
  assert.ok('event' in result)
  if (!('event' in result)) throw new Error('Fixture event was not classified.')
  await store.commitPostScoutAndContextJobs(sourcePost, 'accepted', scout.snapshot(), [{
    event: result.event, entityIds: result.entityIds, targetMarket: 'KAITO',
  }], now)
  const job = (await store.claimContextJobs(now, 1, 60_000))[0]
  await store.completeContextJob(job.jobId, scan(result.event.eventId), now)
  await store.prepareAlertDrafts(now)
  return store
}

function verifier(subjectId: string, sessionId: string, at = now): RecipientSessionVerifier {
  return async () => ({
    issuer: 'okx:test-issuer',
    subjectId,
    sessionId,
    audience: 'lolah',
    authenticatedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + 60 * 60_000).toISOString(),
  })
}

test('leases only the authenticated recipient draft and persists no access token', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.json')
  const store = await preparedStore(path)
  const accessToken = 'transient-access-token-never-persist'
  const other = await pullSimulatedAlerts({
    accessToken, verifier: verifier('agent:other-999', 'session:other-001'), store, now,
  })
  assert.deepEqual(other, [])
  const deliveries = await pullSimulatedAlerts({
    accessToken, verifier: verifier('agent:buyer-123', 'session:buyer-001'), store, now,
    leaseMs: 10_000,
  })
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].simulationOnly, true)
  assert.equal(deliveries[0].sendAllowed, false)
  assert.equal((await readFile(path, 'utf8')).includes(accessToken), false)
})

test('allows acknowledgement only from the same authenticated recipient and session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await preparedStore(join(directory, 'state.json'))
  const token = 'transient-access-token-for-ack'
  const delivery = (await pullSimulatedAlerts({
    accessToken: token, verifier: verifier('agent:buyer-123', 'session:buyer-001'), store, now,
    leaseMs: 10_000,
  }))[0]
  await assert.rejects(() => acknowledgeSimulatedAlert({
    accessToken: token, verifier: verifier('agent:buyer-123', 'session:buyer-002'),
    store, outboxId: delivery.outboxId, now,
  }), /unavailable/)
  await assert.rejects(() => acknowledgeSimulatedAlert({
    accessToken: token, verifier: verifier('agent:other-999', 'session:buyer-001'),
    store, outboxId: delivery.outboxId, now,
  }), /unavailable/)
  const receipt = await acknowledgeSimulatedAlert({
    accessToken: token, verifier: verifier('agent:buyer-123', 'session:buyer-001'),
    store, outboxId: delivery.outboxId, now,
  })
  assert.equal(receipt.status, 'acknowledged_simulated')
  assert.equal(receipt.simulationOnly, true)
})

test('reclaims an unacknowledged offline lease for a new session after expiry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await preparedStore(join(directory, 'state.json'))
  const token = 'transient-access-token-offline-replay'
  const first = (await pullSimulatedAlerts({
    accessToken: token, verifier: verifier('agent:buyer-123', 'session:buyer-001'), store, now,
    leaseMs: 10_000,
  }))[0]
  const replayTime = new Date(now.getTime() + 10_000)
  const replay = (await pullSimulatedAlerts({
    accessToken: token, verifier: verifier('agent:buyer-123', 'session:buyer-002', replayTime),
    store, now: replayTime, leaseMs: 10_000,
  }))[0]
  assert.equal(replay.outboxId, first.outboxId)
  assert.equal((await store.listRecipientOutbox('agent:buyer-123'))[0].attempts, 2)
  await assert.rejects(() => acknowledgeSimulatedAlert({
    accessToken: token, verifier: verifier('agent:buyer-123', 'session:buyer-001', replayTime),
    store, outboxId: replay.outboxId, now: replayTime,
  }), /unavailable/)
  await acknowledgeSimulatedAlert({
    accessToken: token, verifier: verifier('agent:buyer-123', 'session:buyer-002', replayTime),
    store, outboxId: replay.outboxId, now: replayTime,
  })
})

test('rejects expired or invalid principals with a generic authentication error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await preparedStore(join(directory, 'state.json'))
  const expired: RecipientSessionVerifier = async () => ({
    issuer: 'okx:test-issuer', subjectId: 'agent:buyer-123', sessionId: 'session:buyer-001',
    audience: 'lolah', authenticatedAt: '2026-08-09T08:00:00Z', expiresAt: '2026-08-09T09:00:00Z',
  })
  await assert.rejects(() => pullSimulatedAlerts({
    accessToken: 'transient-access-token-expired', verifier: expired, store, now,
  }), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Authentication failed.')
    return true
  })
})
