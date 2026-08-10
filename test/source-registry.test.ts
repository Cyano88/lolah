import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSourceRegistry, type LolahSourceRegistry } from '../src/source-registry.js'

const valid: LolahSourceRegistry = {
  entities: [{ id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'], hyperliquidMarkets: ['KAITO'] }],
  sources: [{ platform: 'x', authorId: '100', username: 'kaito_official', tier: 'official_project', entityIds: ['kaito'] }],
}

test('normalizes a valid curated registry', () => {
  const registry = validateSourceRegistry(valid)
  assert.equal(registry.entities[0].symbols[0], 'KAITO')
  assert.equal(registry.sources[0].username, 'kaito_official')
})

test('accepts explicit source roles without changing immutable identity checks', () => {
  const registry = validateSourceRegistry({
    ...valid,
    sources: [{ ...valid.sources[0], category: 'foundation' }],
  })
  assert.equal(registry.sources[0].category, 'foundation')
})

test('allows a broad trusted source to cover every curated entity with one exclusive wildcard', () => {
  const registry = validateSourceRegistry({
    ...valid,
    sources: [{ ...valid.sources[0], entityIds: ['*'], category: 'exchange' }],
  })
  assert.deepEqual(registry.sources[0].entityIds, ['*'])
  assert.throws(() => validateSourceRegistry({
    ...valid,
    sources: [{ ...valid.sources[0], entityIds: ['*', 'kaito'] }],
  }), /wildcard/)
})

test('rejects duplicate immutable author IDs', () => {
  assert.throws(() => validateSourceRegistry({ ...valid, sources: [valid.sources[0], { ...valid.sources[0], username: 'other' }] }), /authorIds/)
})

test('rejects a source linked to an unknown entity', () => {
  assert.throws(() => validateSourceRegistry({ ...valid, sources: [{ ...valid.sources[0], entityIds: ['unknown'] }] }), /unknown entity/)
})

test('rejects unknown and secret-shaped registry fields', () => {
  assert.throws(() => validateSourceRegistry({
    ...valid,
    apiKey: 'must-not-be-accepted',
  } as unknown as LolahSourceRegistry), /unsupported field/)
  assert.throws(() => validateSourceRegistry({
    ...valid,
    sources: [{ ...valid.sources[0], bearerToken: 'must-not-be-accepted' }],
  } as unknown as LolahSourceRegistry), /unsupported field/)
})
