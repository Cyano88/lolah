import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { LolahEventScan } from '../src/contracts.js'
import { LolahDurableStateStore } from '../src/durable-state.js'
import { handleLolahLocalRequest } from '../src/local-service-routes.js'
import { LolahNewsScout } from '../src/news-scout.js'
import { createOkxFixtureSessionVerifier } from '../src/okx-session-verifier.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'
import type { RawXPost } from '../src/x-recent-search.js'
import type { UpbitMarketAssessment } from '../src/upbit-shadow-replay.js'
import {
  UpbitListingWorkerStore,
  runUpbitEnrichmentCycle,
  runUpbitListingWorkerCycle,
} from '../src/upbit-listing-worker.js'

const registry: LolahSourceRegistry = {
  entities: [{ id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'], hyperliquidMarkets: ['KAITO'] }],
  sources: [{ platform: 'x', authorId: '100', username: 'kaito_official', tier: 'official_project', entityIds: ['kaito'] }],
}
const now = new Date('2026-08-09T10:10:00Z')
const sourcePost: RawXPost = {
  platform: 'x', postId: '8001', authorId: '100', username: 'kaito_official',
  text: 'Kaito will shut down operations.', createdAt: '2026-08-09T10:09:00Z',
  sourceUrl: 'https://x.com/kaito_official/status/8001',
}

function scan(eventId: string): LolahEventScan {
  return {
    schema: 'lolah-event-scan-v1', eventId, state: 'context_ready',
    reason: 'Verified fixture context.', confidenceAdjustment: 'reduced', executionAllowed: false,
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

async function routeFixture(path: string) {
  const store = new LolahDurableStateStore(path)
  await store.createWatch({
    recipientId: 'okx-agent:123', entityIds: ['kaito'], targetMarkets: ['KAITO'],
    expiresAt: new Date(now.getTime() + 60 * 60_000),
  }, now)
  const scout = new LolahNewsScout(registry)
  const event = scout.ingest(sourcePost, now)
  assert.ok('event' in event)
  if (!('event' in event)) throw new Error('Fixture event was not classified.')
  await store.commitPostScoutAndContextJobs(sourcePost, 'accepted', scout.snapshot(), [{
    event: event.event, entityIds: event.entityIds, targetMarket: 'KAITO',
  }], now)
  const job = (await store.claimContextJobs(now, 1, 60_000))[0]
  await store.completeContextJob(job.jobId, scan(event.event.eventId), now)
  await store.prepareAlertDrafts(now)
  const introspection = {
    active: true, agentId: '123', sessionId: 'route_session', audience: ['lolah'],
    issuedAt: Math.floor(now.getTime() / 1_000), expiresAt: Math.floor(now.getTime() / 1_000) + 3_600,
  }
  return {
    store,
    verifier: createOkxFixtureSessionVerifier(async () => introspection),
  }
}

test('serves health without authentication and marks the service simulation-only', async () => {
  const response = await handleLolahLocalRequest({ method: 'GET', path: '/health' }, {
    store: new LolahDurableStateStore(join(tmpdir(), 'unused-lolah-health-state.json')),
    verifier: async () => { throw new Error('not used') },
    now: () => now,
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.deliveryMode, 'simulation_only')
  assert.equal(response.body.sendAllowed, false)
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('pulls and acknowledges through fixture-backed OKX session routes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-routes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.json')
  const fixture = await routeFixture(path)
  const token = 'fixture-okx-route-token-1234567890'
  const pull = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/alerts/pull',
    headers: { Authorization: 'Bearer ' + token },
    body: { limit: 5, leaseMs: 10_000 },
  }, { ...fixture, now: () => now })
  assert.equal(pull.status, 200)
  assert.equal(pull.body.sendAllowed, false)
  const deliveries = pull.body.deliveries as Array<{ outboxId: string; simulationOnly: boolean; sendAllowed: boolean }>
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].simulationOnly, true)
  assert.equal(deliveries[0].sendAllowed, false)
  assert.equal((await readFile(path, 'utf8')).includes(token), false)

  const ack = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/alerts/' + deliveries[0].outboxId + '/ack',
    headers: { authorization: 'Bearer ' + token },
    body: {},
  }, { ...fixture, now: () => now })
  assert.equal(ack.status, 200)
  assert.equal((ack.body.receipt as { status: string }).status, 'acknowledged_simulated')
})

test('returns generic errors for missing auth, invalid bodies, and unavailable acknowledgements', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-routes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = await routeFixture(join(directory, 'state.json'))
  const noAuth = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/alerts/pull',
  }, { ...fixture, now: () => now })
  assert.deepEqual([noAuth.status, noAuth.body.error], [401, 'Authentication failed.'])
  const badBody = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/alerts/pull',
    headers: { authorization: 'Bearer fixture-okx-route-token-1234567890' },
    body: { limit: 1_000 },
  }, { ...fixture, now: () => now })
  assert.deepEqual([badBody.status, badBody.body.error], [400, 'Request body is invalid.'])
  const missingAck = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/alerts/outbox_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ack',
    headers: { authorization: 'Bearer fixture-okx-route-token-1234567890' },
    body: {},
  }, { ...fixture, now: () => now })
  assert.deepEqual([missingAck.status, missingAck.body.error], [404, 'Alert acknowledgement is unavailable.'])
})

test('does not leak introspector failures through a route response', async () => {
  const response = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/alerts/pull',
    headers: { authorization: 'Bearer fixture-okx-route-token-1234567890' },
  }, {
    store: new LolahDurableStateStore(join(tmpdir(), 'unused-lolah-auth-state.json')),
    verifier: createOkxFixtureSessionVerifier(async () => { throw new Error('internal verifier detail') }),
    now: () => now,
  })
  assert.equal(response.status, 401)
  assert.equal(JSON.stringify(response.body).includes('internal verifier detail'), false)
})

test('creates, lists, and cancels an idempotent watch for the authenticated OKX agent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-routes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.json')
  const store = new LolahDurableStateStore(path)
  const verifier = createOkxFixtureSessionVerifier(async () => ({
    active: true, agentId: '123', sessionId: 'watch_session', audience: 'lolah',
    issuedAt: Math.floor(now.getTime() / 1_000), expiresAt: Math.floor(now.getTime() / 1_000) + 3_600,
  }))
  const token = 'fixture-okx-watch-token-123456789'
  const request = {
    method: 'POST',
    path: '/v1/watches',
    headers: { authorization: 'Bearer ' + token, 'idempotency-key': 'watch-request-001' },
    body: {
      entityIds: ['kaito'],
      targetMarkets: ['KAITO'],
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
  }
  const first = await handleLolahLocalRequest(request, { store, verifier, now: () => now })
  const replay = await handleLolahLocalRequest(request, { store, verifier, now: () => now })
  assert.equal(first.status, 201)
  assert.equal(replay.status, 201)
  const watch = first.body.watch as { watchId: string; recipientId: string }
  assert.equal(watch.watchId, (replay.body.watch as { watchId: string }).watchId)
  assert.equal(watch.recipientId, 'okx-agent:123')
  const persisted = await readFile(path, 'utf8')
  assert.equal(persisted.includes('watch-request-001'), false)
  assert.equal(persisted.includes(token), false)

  const list = await handleLolahLocalRequest({
    method: 'GET', path: '/v1/watches', headers: { authorization: 'Bearer ' + token },
  }, { store, verifier, now: () => now })
  assert.equal((list.body.watches as unknown[]).length, 1)
  assert.equal(JSON.stringify(list.body).includes('idempotencyKeyHash'), false)

  const cancel = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/watches/' + watch.watchId + '/cancel',
    headers: { authorization: 'Bearer ' + token }, body: {},
  }, { store, verifier, now: () => now })
  assert.equal(cancel.status, 200)
  assert.equal((cancel.body.watch as { status: string }).status, 'cancelled')
})

test('rejects idempotency conflicts and cross-recipient watch cancellation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-routes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(join(directory, 'state.json'))
  const claims = (agentId: string) => createOkxFixtureSessionVerifier(async () => ({
    active: true, agentId, sessionId: 'watch_session', audience: 'lolah',
    issuedAt: Math.floor(now.getTime() / 1_000), expiresAt: Math.floor(now.getTime() / 1_000) + 3_600,
  }))
  const token = 'fixture-okx-watch-token-123456789'
  const create = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/watches',
    headers: { authorization: 'Bearer ' + token, 'idempotency-key': 'watch-request-002' },
    body: { entityIds: ['kaito'], targetMarkets: ['KAITO'], expiresAt: new Date(now.getTime() + 60_000).toISOString() },
  }, { store, verifier: claims('123'), now: () => now })
  const watchId = (create.body.watch as { watchId: string }).watchId
  const conflict = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/watches',
    headers: { authorization: 'Bearer ' + token, 'idempotency-key': 'watch-request-002' },
    body: { entityIds: ['bitcoin'], targetMarkets: ['BTC'], expiresAt: new Date(now.getTime() + 60_000).toISOString() },
  }, { store, verifier: claims('123'), now: () => now })
  assert.equal(conflict.status, 409)
  const crossRecipient = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/watches/' + watchId + '/cancel',
    headers: { authorization: 'Bearer ' + token }, body: {},
  }, { store, verifier: claims('999'), now: () => now })
  assert.equal(crossRecipient.status, 404)
})

test('creates and pulls recipient-bound Upbit alerts without cross-agent access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-upbit-routes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new LolahDurableStateStore(join(directory, 'state.json'))
  const upbitStore = new UpbitListingWorkerStore(join(directory, 'upbit-state.json'))
  const claims = (agentId: string) => createOkxFixtureSessionVerifier(async () => ({
    active: true, agentId, sessionId: 'upbit_session_' + agentId, audience: 'lolah',
    issuedAt: Math.floor(now.getTime() / 1_000), expiresAt: Math.floor(now.getTime() / 1_000) + 3_600,
  }))
  const token = 'fixture-okx-upbit-token-123456789'
  const created = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/upbit/watches',
    headers: { authorization: 'Bearer ' + token, 'idempotency-key': 'upbit-watch-all-001' },
    body: { symbols: ['*'], expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString() },
  }, { store, upbitStore, verifier: claims('123'), now: () => now })
  assert.equal(created.status, 201)
  assert.equal((created.body.watch as { recipientId: string }).recipientId, 'okx-agent:123')

  const feed = {
    success: true,
    data: { notices: [{
      id: 6458,
      title: 'BTC, USDT 마켓 신규 거래지원 안내 (CYS, ICNT)',
      category: '거래',
      listed_at: '2026-08-09T19:09:55+09:00',
      first_listed_at: '2026-08-09T19:09:55+09:00',
      need_update_badge: false,
    }] },
  }
  const upbitFetcher = async (input: string | URL | Request) => String(input).includes('/announcements?')
    ? new Response(JSON.stringify(feed), { status: 200, headers: { etag: 'route' } })
    : new Response(JSON.stringify({ success: true, data: { body: '거래지원 개시 시점 : 2026-08-10 14:00 KST' } }), { status: 200 })
  await runUpbitListingWorkerCycle({
    store: upbitStore,
    fetcher: upbitFetcher as typeof fetch,
    now: () => now,
  })
  await runUpbitEnrichmentCycle({
    store: upbitStore,
    enrich: async (_event, symbol): Promise<UpbitMarketAssessment> => ({
      symbol, targetMarket: symbol, state: 'context_ready',
      marketPosture: 'positive_catalyst_watch', liquidityAssessment: 'adequate',
      reason: 'Verified route fixture context is ready.',
      simulationOnly: true, sendAllowed: false, executionAllowed: false,
    }),
    now: () => now,
  })

  const pull = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/upbit/alerts/pull',
    headers: { authorization: 'Bearer ' + token }, body: { leaseMs: 10_000 },
  }, { store, upbitStore, verifier: claims('123'), now: () => now })
  assert.equal(pull.status, 200)
  const deliveries = pull.body.deliveries as Array<{
    outboxId: string
    event: { symbols: string[] }
    enrichmentStatus: string
    assessments: UpbitMarketAssessment[]
    executionAllowed: boolean
  }>
  assert.equal(deliveries.length, 1)
  assert.deepEqual(deliveries[0].event.symbols, ['CYS', 'ICNT'])
  assert.equal(deliveries[0].enrichmentStatus, 'complete')
  assert.equal(deliveries[0].assessments.length, 2)
  assert.equal(deliveries[0].executionAllowed, false)

  const crossAgent = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/upbit/alerts/' + deliveries[0].outboxId + '/ack',
    headers: { authorization: 'Bearer ' + token }, body: {},
  }, { store, upbitStore, verifier: claims('999'), now: () => now })
  assert.equal(crossAgent.status, 404)
  const ownAck = await handleLolahLocalRequest({
    method: 'POST', path: '/v1/upbit/alerts/' + deliveries[0].outboxId + '/ack',
    headers: { authorization: 'Bearer ' + token }, body: {},
  }, { store, upbitStore, verifier: claims('123'), now: () => now })
  assert.equal(ownAck.status, 200)
  const persisted = await readFile(join(directory, 'upbit-state.json'), 'utf8')
  assert.equal(persisted.includes(token), false)
})
