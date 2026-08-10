import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LolahDurableStateStore } from '../src/durable-state.js'
import { runLolahLivePipeline } from '../src/live-pipeline-runner.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'

const now = new Date('2026-08-10T12:00:00Z')
const token = 'x'.repeat(30)
const registry: LolahSourceRegistry = {
  entities: [{
    id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'],
    hyperliquidMarkets: ['KAITO'],
  }],
  sources: [{
    platform: 'x', authorId: '100', username: 'kaito_official',
    tier: 'official_project', entityIds: ['kaito'],
  }],
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function options(statePath: string, fetcher: typeof fetch) {
  return {
    registry,
    store: new LolahDurableStateStore(statePath),
    sourceKey: 'x:live-staging',
    query: 'Kaito shutdown',
    xBearerToken: token,
    polydeskEndpoint: 'http://127.0.0.1:4317/api/agent/polymarket-context',
    mode: 'local_staging' as const,
    watch: {
      recipientId: 'staging:lolah-shadow',
      entityIds: ['kaito'],
      targetMarkets: ['KAITO'],
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      idempotencyKey: 'live-pipeline-test',
    },
    fetcher,
    now: () => now,
  }
}

test('runs X through curated classification and both live context adapters', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-live-pipeline-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const statePath = join(directory, 'state.json')
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith('https://api.x.com/')) {
      return json({
        data: [{
          id: '99001', author_id: '100', text: 'Kaito will shut down operations.',
          created_at: '2026-08-10T11:59:00Z',
        }],
        includes: { users: [{ id: '100', username: 'kaito_official' }] },
        meta: {},
      })
    }
    if (url.startsWith('http://127.0.0.1:4317/')) {
      const body = JSON.parse(String(init?.body))
      return json({
        ok: true,
        data: {
          schema: 'polydesk-market-context-v1',
          provider: 'polydesk',
          eventId: body.event.eventId,
          matchStatus: 'no_relevant_market',
          searchedAt: now.toISOString(),
          candidates: [],
        },
      })
    }
    const body = JSON.parse(String(init?.body))
    if (body.type === 'metaAndAssetCtxs') {
      return json([
        { universe: [{ name: 'KAITO' }] },
        [{ markPx: '0.50', prevDayPx: '0.55' }],
      ])
    }
    return json({
      levels: [[{ px: '0.499', sz: '10' }], [{ px: '0.501', sz: '10' }]],
    })
  }
  const result = await runLolahLivePipeline(options(statePath, fetcher))
  assert.equal(result.polling.status, 'processed')
  if (result.polling.status !== 'processed') return
  assert.equal(result.polling.posts[0].verification, 'official_source')
  assert.equal(result.polling.contextQueue.completed, 1)
  assert.equal(result.simulatedOutboxCount, 1)
  assert.equal(result.sendAllowed, false)
  assert.equal(result.executionAllowed, false)
  assert.equal((await readFile(statePath, 'utf8')).includes(token), false)
})

test('rejects missing credentials and out-of-registry watches before any request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-live-pipeline-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let calls = 0
  const base = options(join(directory, 'state.json'), async () => {
    calls += 1
    return json({})
  })
  await assert.rejects(() => runLolahLivePipeline({
    ...base,
    xBearerToken: '',
  }), /X access is not configured/)
  await assert.rejects(() => runLolahLivePipeline({
    ...base,
    watch: { ...base.watch, entityIds: ['unknown'] },
  }), /outside the curated registry/)
  assert.equal(calls, 0)
  assert.equal((await base.store.listRecipientWatches('staging:lolah-shadow')).length, 0)
})

test('contains context-provider failure without staging an alert', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-live-pipeline-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const statePath = join(directory, 'state.json')
  const fetcher: typeof fetch = async input => {
    if (String(input).startsWith('https://api.x.com/')) {
      return json({
        data: [{
          id: '99002', author_id: '100', text: 'Kaito will shut down operations.',
          created_at: '2026-08-10T11:59:00Z',
        }],
        includes: { users: [{ id: '100', username: 'kaito_official' }] },
        meta: {},
      })
    }
    throw new Error('private provider detail')
  }
  const result = await runLolahLivePipeline(options(statePath, fetcher))
  assert.equal(result.polling.status, 'processed')
  if (result.polling.status !== 'processed') return
  assert.deepEqual(result.polling.posts[0].failedMarkets, ['KAITO'])
  assert.equal(result.simulatedOutboxCount, 0)
  assert.equal(JSON.stringify(result).includes('private provider detail'), false)
})
