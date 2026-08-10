import assert from 'node:assert/strict'
import test from 'node:test'
import { buildXIntelligencePlan } from '../src/x-intelligence-plan.js'

const entities = [{
  id: 'kaito', name: 'Kaito', aliases: ['Kaito AI'], symbols: ['KAITO'], hyperliquidMarkets: ['KAITO'],
}]

test('reads every official post and keyword-filters trusted sources in bounded shards', () => {
  const plan = buildXIntelligencePlan({ entities, sources: [
    { platform: 'x', authorId: '100', username: 'kaito_official', tier: 'official_project', category: 'project', entityIds: ['kaito'] },
    { platform: 'x', authorId: '200', username: 'crypto_news', tier: 'trusted_reporter', category: 'crypto_news', entityIds: ['kaito'] },
  ] })
  const official = plan.filter(item => item.lane === 'official_firehose')
  const trusted = plan.filter(item => item.lane === 'trusted_catalysts')
  assert.equal(official.length, 1)
  assert.equal(official[0].query.includes('from:kaito_official'), true)
  assert.equal(official[0].query.includes('listing'), false)
  assert.equal(trusted.length, 8)
  assert.equal(trusted.every(item => item.query.includes('from:crypto_news')), true)
  assert.equal(plan.every(item => item.query.length <= 480), true)
})

test('stretches polling intervals when a broad registry would exceed the X request budget', () => {
  const sources = Array.from({ length: 120 }, (_, index) => ({
    platform: 'x' as const,
    authorId: String(1_000 + index),
    username: 'news_' + index,
    tier: 'trusted_reporter' as const,
    category: 'crypto_news' as const,
    entityIds: ['kaito'],
  }))
  const plan = buildXIntelligencePlan({ entities, sources })
  assert.equal(plan.every(item => item.minimumIntervalMs > 60_000), true)
  const projectedCalls = plan.reduce((total, item) => total + 900_000 / item.minimumIntervalMs, 0)
  assert.equal(projectedCalls <= 120.01, true)
})
