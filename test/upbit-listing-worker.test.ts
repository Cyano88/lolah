import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { UpbitMarketAssessment } from '../src/upbit-shadow-replay.js'
import {
  UpbitListingWorkerStore,
  runUpbitEnrichmentCycle,
  runUpbitListingWorkerCycle,
  upbitEnrichmentRetryDelayMs,
  upbitRetryDelayMs,
} from '../src/upbit-listing-worker.js'

const announcement = {
  success: true,
  data: {
    notices: [{
      id: 6458,
      title: 'BTC, USDT 마켓 신규 거래지원 안내 (CYS, ICNT)',
      category: '거래',
      listed_at: '2026-08-10T11:05:54+09:00',
      first_listed_at: '2026-08-10T11:05:54+09:00',
      need_update_badge: false,
    }],
  },
}

function fetcher(input: string | URL | Request, init?: RequestInit) {
  const url = String(input)
  if (url.includes('/announcements?')) {
    if (init?.headers && (init.headers as Record<string, string>)['If-None-Match']) {
      return Promise.resolve(new Response(null, { status: 304 }))
    }
    return Promise.resolve(new Response(JSON.stringify(announcement), {
      status: 200,
      headers: { etag: '"first"' },
    }))
  }
  return Promise.resolve(new Response(JSON.stringify({
    success: true,
    data: { body: '거래지원 개시 시점 : 2026-08-10 14:00 KST' },
  }), { status: 200 }))
}

function assessment(symbol: string): UpbitMarketAssessment {
  return {
    symbol, targetMarket: symbol, state: 'context_ready',
    marketPosture: 'positive_catalyst_watch', liquidityAssessment: 'adequate',
    reason: 'Verified live fixture context is ready.',
    simulationOnly: true, sendAllowed: false, executionAllowed: false,
  }
}

test('atomically persists a fresh alert and monitor revision across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-upbit-worker-'))
  try {
    const path = join(directory, 'state.json')
    const firstStore = new UpbitListingWorkerStore(path)
    const first = await runUpbitListingWorkerCycle({
      store: firstStore,
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-08-10T02:06:04Z'),
    })
    assert.equal(first.alertsPrepared, 1)
    assert.equal((await firstStore.listPreparedAlerts()).length, 1)
    assert.equal((await firstStore.listPreparedAlerts())[0].enrichmentStatus, 'pending')

    const restartedStore = new UpbitListingWorkerStore(path)
    const replay = await runUpbitListingWorkerCycle({
      store: restartedStore,
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-08-10T02:06:05Z'),
    })
    assert.equal(replay.polling, 'unchanged')
    assert.equal(replay.alertsPrepared, 0)
    assert.equal((await restartedStore.listPreparedAlerts()).length, 1)
    assert.equal((await readFile(path, 'utf8')).includes('sendAllowed'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('migrates deployed v2 alerts as completed legacy records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-upbit-worker-'))
  try {
    const path = join(directory, 'state.json')
    const store = new UpbitListingWorkerStore(path)
    await runUpbitListingWorkerCycle({
      store,
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-08-10T02:06:04Z'),
    })
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    legacy.schema = 'lolah-upbit-worker-state-v2'
    delete legacy.enrichmentJobs
    for (const alert of legacy.alerts) {
      delete alert.enrichmentStatus
      delete alert.assessments
    }
    await writeFile(path, JSON.stringify(legacy))
    const migrated = (await new UpbitListingWorkerStore(path).listPreparedAlerts())[0]
    assert.equal(migrated.enrichmentStatus, 'complete')
    assert.deepEqual(migrated.assessments, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('uses bounded exponential backoff for upstream failures', () => {
  assert.equal(upbitRetryDelayMs(1), 1_000)
  assert.equal(upbitRetryDelayMs(2), 2_000)
  assert.equal(upbitRetryDelayMs(10), 300_000)
  assert.equal(upbitRetryDelayMs(100), 300_000)
  assert.equal(upbitEnrichmentRetryDelayMs(1), 1_000)
  assert.equal(upbitEnrichmentRetryDelayMs(5), 16_000)
})

test('records but does not prepare a delayed listing alert', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-upbit-worker-'))
  try {
    const store = new UpbitListingWorkerStore(join(directory, 'state.json'))
    const result = await runUpbitListingWorkerCycle({
      store,
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-08-10T02:07:00Z'),
    })
    assert.equal(result.alertsPrepared, 0)
    assert.equal(result.lateEventsSuppressed, 1)
    assert.equal((await store.listPreparedAlerts()).length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('fans a fresh listing out only to matching recipient-bound watches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-upbit-worker-'))
  try {
    const store = new UpbitListingWorkerStore(join(directory, 'state.json'))
    const expiry = new Date('2026-08-10T03:00:00Z')
    await store.createWatch({ recipientId: 'okx-agent:all', symbols: ['*'], expiresAt: expiry },
      new Date('2026-08-10T02:00:00Z'), 'watch-all-listings')
    await store.createWatch({ recipientId: 'okx-agent:cys', symbols: ['CYS'], expiresAt: expiry },
      new Date('2026-08-10T02:00:00Z'), 'watch-cys-listing')
    await store.createWatch({ recipientId: 'okx-agent:btc', symbols: ['BTC'], expiresAt: expiry },
      new Date('2026-08-10T02:00:00Z'), 'watch-btc-listing')
    await runUpbitListingWorkerCycle({
      store,
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-08-10T02:06:04Z'),
    })
    assert.equal((await store.leaseRecipientAlerts('okx-agent:all', 'okx-session:all',
      new Date('2026-08-10T02:06:04.500Z'), 20, 10_000)).length, 0)
    const enriched = await runUpbitEnrichmentCycle({
      store,
      enrich: async (_event, symbol) => assessment(symbol),
      now: () => new Date('2026-08-10T02:06:04.600Z'),
    })
    assert.equal(enriched.completed, 2)
    const all = await store.leaseRecipientAlerts('okx-agent:all', 'okx-session:all',
      new Date('2026-08-10T02:06:05Z'), 20, 10_000)
    const cys = await store.leaseRecipientAlerts('okx-agent:cys', 'okx-session:cys',
      new Date('2026-08-10T02:06:05Z'), 20, 10_000)
    const unrelated = await store.leaseRecipientAlerts('okx-agent:btc', 'okx-session:btc',
      new Date('2026-08-10T02:06:05Z'), 20, 10_000)
    assert.equal(all.length, 1)
    assert.equal(cys.length, 1)
    assert.equal(unrelated.length, 0)
    await assert.rejects(() => store.acknowledgeRecipientAlert(
      all[0].delivery.deliveryId,
      'okx-agent:cys',
      'okx-session:cys',
      new Date('2026-08-10T02:06:06Z'),
    ), /unavailable/)
    const acknowledged = await store.acknowledgeRecipientAlert(
      all[0].delivery.deliveryId,
      'okx-agent:all',
      'okx-session:all',
      new Date('2026-08-10T02:06:06Z'),
    )
    assert.equal(acknowledged.status, 'acknowledged_simulated')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('retries context independently and finalizes a safe unavailable assessment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-upbit-worker-'))
  try {
    const store = new UpbitListingWorkerStore(join(directory, 'state.json'))
    await runUpbitListingWorkerCycle({
      store,
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-08-10T02:06:04Z'),
    })
    const attempts = [0, 1, 3, 7, 15]
    for (const seconds of attempts) {
      await runUpbitEnrichmentCycle({
        store,
        enrich: async () => { throw new Error('private provider failure') },
        now: () => new Date(Date.parse('2026-08-10T02:06:04Z') + seconds * 1_000),
      })
    }
    const alert = (await store.listPreparedAlerts())[0]
    assert.equal(alert.enrichmentStatus, 'complete')
    assert.equal(alert.assessments.length, 2)
    assert.equal(alert.assessments.every(item => item.state === 'provider_unavailable'), true)
    assert.equal(JSON.stringify(alert).includes('private provider failure'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('finalizes a fifth-attempt enrichment lease that expires after a worker crash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-upbit-worker-'))
  try {
    const store = new UpbitListingWorkerStore(join(directory, 'state.json'))
    const base = Date.parse('2026-08-10T02:06:04Z')
    await runUpbitListingWorkerCycle({
      store, fetcher: fetcher as typeof fetch, now: () => new Date(base),
    })
    for (const seconds of [0, 1, 3, 7]) {
      await runUpbitEnrichmentCycle({
        store, enrich: async () => { throw new Error('failure') },
        now: () => new Date(base + seconds * 1_000),
      })
    }
    const fifth = await store.claimEnrichmentJobs(new Date(base + 15_000), 5, 10_000)
    assert.equal(fifth.length, 2)
    assert.equal(fifth.every(job => job.attemptCount === 5), true)
    assert.equal((await store.claimEnrichmentJobs(new Date(base + 26_000), 5, 10_000)).length, 0)
    const alert = (await store.listPreparedAlerts())[0]
    assert.equal(alert.enrichmentStatus, 'complete')
    assert.equal(alert.assessments.every(item => item.state === 'provider_unavailable'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
