import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UpbitListingWorkerStore, runUpbitListingWorkerCycle, upbitRetryDelayMs } from '../src/upbit-listing-worker.js'

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

test('uses bounded exponential backoff for upstream failures', () => {
  assert.equal(upbitRetryDelayMs(1), 1_000)
  assert.equal(upbitRetryDelayMs(2), 2_000)
  assert.equal(upbitRetryDelayMs(10), 300_000)
  assert.equal(upbitRetryDelayMs(100), 300_000)
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
