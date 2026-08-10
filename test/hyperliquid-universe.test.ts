import assert from 'node:assert/strict'
import test from 'node:test'
import { expandRegistryWithHyperliquidUniverse } from '../src/hyperliquid-universe.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'

const registry: LolahSourceRegistry = {
  entities: [{ id: 'hype', name: 'Hyperliquid', aliases: ['Hyperliquid'], symbols: ['HYPE'], hyperliquidMarkets: ['HYPE'] }],
  sources: [{ platform: 'x', authorId: '100', username: 'exchange', tier: 'official_project', category: 'exchange', entityIds: ['*'] }],
}

test('adds current Hyperliquid markets as strict ticker entities without replacing curated metadata', async () => {
  const expanded = await expandRegistryWithHyperliquidUniverse(registry, async (input, init) => {
    assert.equal(String(input), 'https://api.hyperliquid.xyz/info')
    assert.deepEqual(JSON.parse(String(init?.body)), { type: 'meta' })
    return new Response(JSON.stringify({ universe: [{ name: 'HYPE' }, { name: 'CYS' }, { name: 'xyz:NVDA' }, { name: 'S' }] }), { status: 200 })
  })
  assert.equal(expanded.entities.length, 4)
  assert.equal(expanded.entities.find(entity => entity.id === 'hype')?.matchMode, 'name_or_symbol')
  assert.equal(expanded.entities.find(entity => entity.id === 'hl_cys')?.matchMode, 'symbol_strict')
  assert.deepEqual(expanded.entities.find(entity => entity.id === 'hl_xyz_nvda')?.hyperliquidMarkets, ['xyz:NVDA'])
  assert.equal(expanded.entities.find(entity => entity.id === 'hl_s')?.name, 'S market')
})

test('fails closed on malformed universe data', async () => {
  await assert.rejects(
    () => expandRegistryWithHyperliquidUniverse(registry, async () => new Response(JSON.stringify({ universe: 'bad' }), { status: 200 })),
    /invalid universe/,
  )
})
