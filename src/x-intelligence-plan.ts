import { validateSourceRegistry, type LolahSourceDefinition, type LolahSourceRegistry } from './source-registry.js'

export type XIntelligenceLane = 'official_firehose' | 'trusted_catalysts'
export type XIntelligenceQuery = {
  sourceKey: string
  lane: XIntelligenceLane
  query: string
  minimumIntervalMs: number
}

const CATALYST_GROUPS = [
  ['list', 'listing', 'delist', 'delisting', 'trading halt', 'trading suspended'],
  ['exploit', 'hacked', 'hack', 'drained', 'breach', 'vulnerability', 'emergency pause'],
  ['shutdown', 'shut down', 'cease operations', 'insolvency', 'bankruptcy', 'wind down'],
  ['mainnet', 'token launch', 'TGE', 'airdrop', 'token unlock', 'vesting', 'buyback', 'token burn'],
  ['acquisition', 'acquired', 'merger', 'partnership', 'integration', 'strategic investment'],
  ['lawsuit', 'sued', 'enforcement', 'investigation', 'sanctions', 'regulatory approval'],
  ['network outage', 'chain halt', 'blocks halted', 'upgrade', 'hard fork', 'governance vote'],
  ['CEO resigns', 'founder leaves', 'leadership change', 'depeg', 'reserve shortfall', 'ETF approval'],
] as const

function sourceExpression(sources: LolahSourceDefinition[]) {
  return '(' + sources.map(source => 'from:' + source.username).join(' OR ') + ')'
}

function keywordExpression(terms: readonly string[]) {
  return '(' + terms.map(term => term.includes(' ') ? JSON.stringify(term) : term).join(' OR ') + ')'
}

function batches<T>(values: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function checked(query: string) {
  if (query.length > 480) throw new Error('Generated X query exceeds the configured safety limit.')
  return query
}

export function buildXIntelligencePlan(registryInput: LolahSourceRegistry): XIntelligenceQuery[] {
  const registry = validateSourceRegistry(registryInput)
  const official = registry.sources.filter(source => source.tier === 'official_project')
  const trusted = registry.sources.filter(source => source.tier !== 'official_project')
  const plan: XIntelligenceQuery[] = []
  const officialBatches = batches(official, 14)
  const trustedBatches = batches(trusted, 6)
  const officialIntervalMs = Math.max(5 * 60_000, Math.ceil(officialBatches.length * 900_000 / 30))
  const trustedQueryCount = trustedBatches.length * CATALYST_GROUPS.length
  const trustedIntervalMs = Math.max(30 * 60_000, Math.ceil(trustedQueryCount * 900_000 / 30))
  for (const [index, sources] of officialBatches.entries()) {
    plan.push({
      sourceKey: 'x:official:' + index,
      lane: 'official_firehose',
      query: checked(sourceExpression(sources) + ' -is:retweet'),
      minimumIntervalMs: officialIntervalMs,
    })
  }
  for (const [sourceIndex, sources] of trustedBatches.entries()) {
    for (const [termIndex, terms] of CATALYST_GROUPS.entries()) {
      plan.push({
        sourceKey: 'x:trusted:' + sourceIndex + ':' + termIndex,
        lane: 'trusted_catalysts',
        query: checked(sourceExpression(sources) + ' ' + keywordExpression(terms) + ' -is:retweet'),
        minimumIntervalMs: trustedIntervalMs,
      })
    }
  }
  if (!plan.length) throw new Error('X intelligence plan requires at least one curated source.')
  return plan
}
