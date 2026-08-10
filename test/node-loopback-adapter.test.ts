import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { LolahDurableStateStore } from '../src/durable-state.js'
import {
  createLolahLoopbackNodeHandler,
  type NodeLikeRequest,
  type NodeLikeResponse,
} from '../src/node-loopback-adapter.js'

function request(input: {
  method?: string
  url?: string
  remoteAddress?: string
  headers?: Record<string, string | string[] | undefined>
  chunks?: Array<string | Uint8Array>
}): NodeLikeRequest {
  return {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
    socket: { remoteAddress: input.remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of input.chunks ?? []) yield chunk
    },
  }
}

function response() {
  const headers: Record<string, string> = {}
  let body = ''
  const target: NodeLikeResponse & { headers: Record<string, string>; body: () => string } = {
    statusCode: 0,
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value },
    end(value) { body = value ?? '' },
    body: () => body,
  }
  return target
}

function handler() {
  return createLolahLoopbackNodeHandler({
    store: new LolahDurableStateStore(join(tmpdir(), 'unused-lolah-node-adapter.json')),
    verifier: async () => { throw new Error('not configured') },
    now: () => new Date('2026-08-09T10:00:00Z'),
  })
}

test('adapts a loopback health request without starting a listener', async () => {
  const output = response()
  await handler()(request({ method: 'GET', url: '/health?probe=1', remoteAddress: '127.0.0.1' }), output)
  assert.equal(output.statusCode, 200)
  assert.equal(JSON.parse(output.body()).deliveryMode, 'simulation_only')
  assert.equal(output.headers['cache-control'], 'no-store')
})

test('rejects non-loopback clients before route or authentication handling', async () => {
  const output = response()
  await handler()(request({ method: 'GET', url: '/health', remoteAddress: '192.0.2.10' }), output)
  assert.equal(output.statusCode, 403)
  assert.equal(JSON.parse(output.body()).error, 'Loopback access only.')
})

test('rejects malformed and oversized JSON bodies', async () => {
  const malformed = response()
  await handler()(request({
    method: 'POST', url: '/v1/alerts/pull', remoteAddress: '::1',
    headers: { 'content-type': 'application/json' }, chunks: ['{bad-json'],
  }), malformed)
  assert.equal(malformed.statusCode, 400)
  const oversized = response()
  await handler()(request({
    method: 'POST', url: '/v1/alerts/pull', remoteAddress: '::ffff:127.0.0.1',
    headers: { 'content-length': '70000' },
  }), oversized)
  assert.equal(oversized.statusCode, 413)

  const invalidLength = response()
  await handler()(request({
    method: 'POST', url: '/v1/alerts/pull', remoteAddress: '127.0.0.1',
    headers: { 'Content-Length': 'not-a-number' }, chunks: ['{}'],
  }), invalidLength)
  assert.equal(invalidLength.statusCode, 400)
})

test('rejects malformed loopback addresses and absolute request URLs', async () => {
  const malformedAddress = response()
  await handler()(request({ method: 'GET', url: '/health', remoteAddress: '127.evil' }), malformedAddress)
  assert.equal(malformedAddress.statusCode, 403)

  const absoluteUrl = response()
  await handler()(request({
    method: 'GET', url: 'http://example.com/health', remoteAddress: '127.0.0.1',
  }), absoluteUrl)
  assert.equal(absoluteUrl.statusCode, 400)
})

test('passes a valid loopback request into existing authentication handling', async () => {
  const output = response()
  await handler()(request({
    method: 'POST', url: '/v1/alerts/pull', remoteAddress: '127.0.0.2',
    headers: { 'content-type': 'application/json' }, chunks: ['{}'],
  }), output)
  assert.equal(output.statusCode, 401)
  assert.equal(JSON.parse(output.body()).error, 'Authentication failed.')
})
