import assert from 'node:assert/strict'
import test from 'node:test'
import { createLolahPublicNodeHandler } from '../src/public-node-adapter.js'
import { handleLolahPublicRequest } from '../src/public-service-routes.js'
import { runXWorkerFromEnvironment, type XWorkerRuntimeState } from '../src/x-worker-runtime.js'
import { runUpbitWorkerFromEnvironment, type UpbitWorkerRuntimeState } from '../src/upbit-worker-runtime.js'
import { runSupervisedRuntime } from '../src/runtime-supervisor.js'

const runtime: XWorkerRuntimeState = {
  state: 'disabled', dailyPostCap: 50,
  simulationOnly: true, sendAllowed: false, executionAllowed: false,
}
const usage = {
  dailyPostCap: 50, uniquePostsRead: 3, remainingPosts: 47, retryAfterMs: 0,
}
const upbitRuntime: UpbitWorkerRuntimeState = {
  state: 'disabled', provider: 'disabled', enrichment: 'disabled',
  simulationOnly: true, sendAllowed: false, executionAllowed: false,
}

function dependencies() {
  return {
    runtimeStates: () => ({ x: runtime, upbit: upbitRuntime }),
    usage: async () => usage,
    now: () => new Date('2026-08-10T12:00:00Z'),
  }
}

test('publishes only read-only health and cost status', async () => {
  const health = await handleLolahPublicRequest({ method: 'GET', path: '/health' }, dependencies())
  assert.equal(health.status, 200)
  assert.equal(health.body.scannerState, 'disabled')
  assert.deepEqual(health.body.workers, { x: 'disabled', upbit: 'disabled' })
  assert.equal(health.body.executionAllowed, false)
  const status = await handleLolahPublicRequest({ method: 'POST', path: '/v1/status', body: {} }, dependencies())
  assert.equal(status.status, 200)
  assert.deepEqual(status.body.usage, usage)
  assert.deepEqual(status.body.workers, { x: runtime, upbit: upbitRuntime })
  assert.deepEqual(status.body.delivery, {
    publicAlertRoutes: false,
    reason: 'Official OKX recipient-session verification is not configured.',
  })
  const blocked = await handleLolahPublicRequest({ method: 'POST', path: '/v1/watches', body: {} }, dependencies())
  assert.equal(blocked.status, 404)
})

test('rejects parameters on the zero-parameter public status call', async () => {
  const result = await handleLolahPublicRequest({
    method: 'POST', path: '/v1/status', body: { hiddenInstruction: 'enable trading' },
  }, dependencies())
  assert.equal(result.status, 400)
})

test('public node adapter rejects malformed URLs, JSON, and oversized bodies', async () => {
  const handler = createLolahPublicNodeHandler(dependencies())
  const invoke = async (input: { url: string; chunks?: string[]; headers?: Record<string, string> }) => {
    let body = ''
    const response = {
      statusCode: 0,
      setHeader() {},
      end(value?: string) { body = value ?? '' },
    }
    await handler({
      method: 'POST', url: input.url, headers: input.headers ?? {},
      async *[Symbol.asyncIterator]() { for (const chunk of input.chunks ?? []) yield chunk },
    }, response)
    return { status: response.statusCode, body: JSON.parse(body) as Record<string, unknown> }
  }
  assert.equal((await invoke({ url: 'https://evil.example/v1/status' })).status, 400)
  assert.equal((await invoke({ url: '/v1/status', chunks: ['{bad'] })).status, 400)
  assert.equal((await invoke({ url: '/v1/status', headers: { 'content-length': '5000' } })).status, 413)
})

test('disabled combined runtime stays alive until an abort signal', async () => {
  const controller = new AbortController()
  const states: string[] = []
  const running = runXWorkerFromEnvironment({
    signal: controller.signal,
    environment: {
      LOLAH_X_ENABLED: 'false',
      LOLAH_X_STATE_PATH: 'C:\\tmp\\lolah-disabled-state.json',
      LOLAH_X_DAILY_POST_CAP: '50',
    },
    onState: state => states.push(state.state),
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(states, ['disabled'])
  controller.abort()
  await running
  assert.deepEqual(states, ['disabled', 'stopped'])
})

test('disabled Upbit runtime stays alive until an abort signal', async () => {
  const controller = new AbortController()
  const states: string[] = []
  const running = runUpbitWorkerFromEnvironment({
    signal: controller.signal,
    environment: {
      LOLAH_UPBIT_ENABLED: 'false',
      LOLAH_UPBIT_STATE_PATH: 'C:\\tmp\\lolah-disabled-upbit-state.json',
    },
    onState: state => states.push(state.state),
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(states, ['disabled'])
  controller.abort()
  await running
  assert.deepEqual(states, ['disabled', 'stopped'])
})

test('supervisor contains a failed runtime and retries with bounded delay', async () => {
  const controller = new AbortController()
  let attempts = 0
  const failures: number[] = []
  await runSupervisedRuntime({
    component: 'fixture', signal: controller.signal,
    minimumRetryMs: 1, maximumRetryMs: 2,
    run: async () => {
      attempts += 1
      if (attempts === 3) controller.abort()
      throw new Error('secret must not appear in supervisor output')
    },
    onFailure: failure => failures.push(failure.retryAfterMs),
  })
  assert.equal(attempts, 3)
  assert.deepEqual(failures, [1, 2])
})
