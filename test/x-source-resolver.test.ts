import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { resolveXSourceCatalog, type LolahSourceCatalog } from '../src/x-source-resolver.js'

const catalog: LolahSourceCatalog = {
  schema: 'lolah-x-source-catalog-v1',
  entities: [{ id: 'hype', name: 'Hyperliquid', aliases: ['Hyperliquid'], symbols: ['HYPE'], hyperliquidMarkets: ['HYPE'] }],
  sources: [{
    username: 'HyperliquidX', tier: 'official_project', category: 'project', entityIds: ['hype'],
    identityProofUrl: 'https://hyperliquid.zendesk.com/hc/en-us/articles/15931545575572-What-are-the-official-links-for-Hyperliquid',
  }],
}

test('resolves a proof-backed handle to its immutable numeric X author ID', async () => {
  let authorization = ''
  let requested = ''
  const registry = await resolveXSourceCatalog(catalog, 't'.repeat(32), async (input, init) => {
    requested = String(input)
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    return new Response(JSON.stringify({ data: [{ id: '12345', username: 'HyperliquidX' }] }), { status: 200 })
  })
  assert.equal(new URL(requested).hostname, 'api.x.com')
  assert.equal(new URL(requested).searchParams.get('usernames'), 'HyperliquidX')
  assert.equal(authorization, 'Bearer ' + 't'.repeat(32))
  assert.equal(registry.sources[0].authorId, '12345')
})

test('rejects circular X identity proof and incomplete lookup without leaking the token', async () => {
  await assert.rejects(() => resolveXSourceCatalog({
    ...catalog,
    sources: [{ ...catalog.sources[0], identityProofUrl: 'https://x.com/HyperliquidX' }],
  }, 't'.repeat(32), async () => new Response('{}')), /non-X HTTPS proof/)
  const token = 'secret-token-'.repeat(3)
  await assert.rejects(
    () => resolveXSourceCatalog(catalog, token, async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    error => error instanceof Error && !error.message.includes(token) && /every curated source/.test(error.message),
  )
})

test('resolves the checked-in starter catalog without guessed IDs', async () => {
  const starter = JSON.parse(await readFile(
    new URL('../config/x-source-catalog.json', import.meta.url), 'utf8',
  )) as LolahSourceCatalog
  const registry = await resolveXSourceCatalog(starter, 't'.repeat(32), async input => {
    const usernames = new URL(String(input)).searchParams.get('usernames')?.split(',') ?? []
    return new Response(JSON.stringify({
      data: usernames.map((username, index) => ({ id: String(50_000 + index), username })),
    }), { status: 200 })
  })
  assert.equal(registry.entities.length, 24)
  assert.equal(registry.sources.length, 9)
  assert.equal(registry.sources.some(source => source.category === 'crypto_news'), true)
  assert.equal(registry.sources.some(source => source.category === 'security'), true)
  assert.equal(registry.sources.filter(source => source.entityIds[0] === '*').length, 4)
})
