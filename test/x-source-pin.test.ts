import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadOrPinXSourceRegistry } from '../src/x-source-pin.js'

const catalog = {
  schema: 'lolah-x-source-catalog-v1',
  entities: [{ id: 'hype', name: 'Hyperliquid', aliases: ['Hyperliquid'], symbols: ['HYPE'], hyperliquidMarkets: ['HYPE'] }],
  sources: [{
    username: 'HyperliquidX', tier: 'official_project', category: 'project', entityIds: ['hype'],
    identityProofUrl: 'https://hyperliquid.zendesk.com/hc/en-us/articles/15931545575572-What-are-the-official-links-for-Hyperliquid',
  }],
}

test('resolves public author IDs once and reuses the durable pin without another X call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-x-pin-'))
  const catalogPath = join(directory, 'catalog.json')
  const pinPath = join(directory, 'pin.json')
  await writeFile(catalogPath, JSON.stringify(catalog))
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls += 1
    return new Response(JSON.stringify({ data: [{ id: '12345', username: 'HyperliquidX' }] }), { status: 200 })
  }
  try {
    const first = await loadOrPinXSourceRegistry({ catalogPath, pinPath, bearerToken: 't'.repeat(32), fetcher })
    const second = await loadOrPinXSourceRegistry({ catalogPath, pinPath, bearerToken: 't'.repeat(32), fetcher })
    assert.equal(first.sources[0].authorId, '12345')
    assert.deepEqual(second, first)
    assert.equal(calls, 1)
    assert.equal((await readFile(pinPath, 'utf8')).includes('t'.repeat(32)), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('fails closed when the catalog changes after identities are pinned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-x-pin-'))
  const catalogPath = join(directory, 'catalog.json')
  const pinPath = join(directory, 'pin.json')
  await writeFile(catalogPath, JSON.stringify(catalog))
  try {
    await loadOrPinXSourceRegistry({
      catalogPath, pinPath, bearerToken: 't'.repeat(32),
      fetcher: async () => new Response(JSON.stringify({ data: [{ id: '12345', username: 'HyperliquidX' }] }), { status: 200 }),
    })
    await writeFile(catalogPath, JSON.stringify({ ...catalog, entities: [{ ...catalog.entities[0], name: 'Changed' }] }))
    await assert.rejects(
      () => loadOrPinXSourceRegistry({
        catalogPath, pinPath, bearerToken: 't'.repeat(32),
        fetcher: async () => new Response(JSON.stringify({
          data: [{ id: '12345', username: 'HyperliquidX' }],
        }), { status: 200 }),
      }),
      /does not match the curated catalog/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('repins a strictly additive source update after resolving its immutable author ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-x-pin-'))
  const catalogPath = join(directory, 'catalog.json')
  const pinPath = join(directory, 'pin.json')
  await writeFile(catalogPath, JSON.stringify(catalog))
  let calls = 0
  const fetcher: typeof fetch = async input => {
    calls += 1
    const usernames = new URL(String(input)).searchParams.get('usernames')?.split(',') ?? []
    return new Response(JSON.stringify({
      data: usernames.map(username => ({
        id: username.toLowerCase() === 'fanvibeonx' ? '67890' : '12345',
        username,
      })),
    }), { status: 200 })
  }
  try {
    await loadOrPinXSourceRegistry({ catalogPath, pinPath, bearerToken: 't'.repeat(32), fetcher })
    await writeFile(catalogPath, JSON.stringify({
      ...catalog,
      entities: [...catalog.entities, {
        id: 'fvb', name: 'FanVibe', aliases: ['FanVibe'], symbols: ['FVB'], hyperliquidMarkets: ['FVB'],
      }],
      sources: [...catalog.sources, {
        username: 'FanVibeOnX', tier: 'official_project', category: 'project', entityIds: ['fvb'],
        identityProofUrl: 'https://www.fanvibe.xyz/',
      }],
    }))
    const updated = await loadOrPinXSourceRegistry({
      catalogPath, pinPath, bearerToken: 't'.repeat(32), fetcher,
    })
    const reused = await loadOrPinXSourceRegistry({
      catalogPath, pinPath, bearerToken: 't'.repeat(32),
      fetcher: async () => { throw new Error('Pinned registry should be reused.') },
    })
    assert.equal(updated.sources.find(source => source.username === 'fanvibeonx')?.authorId, '67890')
    assert.deepEqual(reused, updated)
    assert.equal(calls, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
