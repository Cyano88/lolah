import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchRecentXPosts } from '../src/x-recent-search.js'

test('normalizes official X recent-search data and pagination', async () => {
  let authorization = ''
  const fetcher: typeof fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    return new Response(JSON.stringify({
      data: [{ id: '123', author_id: '100', text: '  Kaito   will shut down  ', created_at: '2026-08-09T10:00:00Z' }],
      includes: { users: [{ id: '100', username: 'KaitoOfficial' }] },
      meta: { next_token: 'next-page' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const result = await fetchRecentXPosts('Kaito shutdown', 't'.repeat(30), fetcher)
  assert.equal(authorization, 'Bearer ' + 't'.repeat(30))
  assert.equal(result.posts[0].sourceUrl, 'https://x.com/KaitoOfficial/status/123')
  assert.equal(result.posts[0].text, 'Kaito will shut down')
  assert.equal(result.nextToken, 'next-page')
})

test('HTTP failures never include the bearer token', async () => {
  const token = 'secret-token-that-must-not-leak'
  const fetcher: typeof fetch = async () => new Response('denied', { status: 401 })
  await assert.rejects(() => fetchRecentXPosts('Kaito', token, fetcher), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message.includes(token), false)
    assert.match(error.message, /HTTP 401/)
    return true
  })
})

test('adds a validated since_id without persisting it internally', async () => {
  let requested = ''
  const fetcher: typeof fetch = async input => {
    requested = String(input)
    return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await fetchRecentXPosts('Kaito', 't'.repeat(30), fetcher, undefined, '123456')
  assert.equal(new URL(requested).searchParams.get('since_id'), '123456')
  await assert.rejects(() => fetchRecentXPosts('Kaito', 't'.repeat(30), fetcher, undefined, 'bad-id'), /sinceId/)
})
