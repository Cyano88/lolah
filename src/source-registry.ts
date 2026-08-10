export type LolahSourceTier = 'official_project' | 'security_researcher' | 'trusted_reporter'

export type LolahEntityDefinition = {
  id: string
  name: string
  aliases: string[]
  symbols: string[]
  hyperliquidMarkets: string[]
}

export type LolahSourceDefinition = {
  platform: 'x'
  authorId: string
  username: string
  tier: LolahSourceTier
  entityIds: string[]
}

export type LolahSourceRegistry = {
  entities: LolahEntityDefinition[]
  sources: LolahSourceDefinition[]
}

function requireOnlyFields(
  value: unknown,
  fields: readonly string[],
  label: string,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object.')
  }
  const allowed = new Set(fields)
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown) throw new Error(label + ' contains an unsupported field.')
}

function clean(value: unknown, label: string, minimum = 1, maximum = 100) {
  const result = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (result.length < minimum || result.length > maximum) {
    throw new Error(label + ' must contain ' + minimum + ' through ' + maximum + ' characters.')
  }
  return result
}

function unique(values: string[], label: string) {
  const normalized = values.map(value => value.toLowerCase())
  if (new Set(normalized).size !== values.length) throw new Error(label + ' must not contain duplicates.')
}

function stringList(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(label + ' must contain ' + minimum + ' through ' + maximum + ' values.')
  }
  const result = value.map(item => clean(item, label + ' item', 1, 80))
  unique(result, label)
  return result
}

function marketSymbol(value: string) {
  if (!/^(?:[a-z0-9]+:)?[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value)) {
    throw new Error('Each Hyperliquid market must be a venue market symbol.')
  }
  const separator = value.indexOf(':')
  return separator < 0
    ? value.toUpperCase()
    : value.slice(0, separator).toLowerCase() + ':' + value.slice(separator + 1).toUpperCase()
}

export function validateSourceRegistry(value: LolahSourceRegistry): LolahSourceRegistry {
  if (!value || typeof value !== 'object') throw new Error('Source registry is required.')
  requireOnlyFields(value, ['entities', 'sources'], 'Source registry')
  if (!Array.isArray(value.entities) || value.entities.length === 0 || value.entities.length > 500) {
    throw new Error('Source registry must contain 1 through 500 entities.')
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > 2_000) {
    throw new Error('Source registry must contain 1 through 2000 sources.')
  }
  const entities = value.entities.map(entity => {
    requireOnlyFields(entity, ['id', 'name', 'aliases', 'symbols', 'hyperliquidMarkets'], 'Entity')
    const id = clean(entity.id, 'Entity id', 2, 80).toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]+$/.test(id)) throw new Error('Entity id is invalid.')
    const aliases = stringList(entity.aliases, 'Entity aliases', 1, 20)
    const symbols = stringList(entity.symbols, 'Entity symbols', 1, 10).map(symbol => symbol.toUpperCase())
    return {
      id,
      name: clean(entity.name, 'Entity name', 2, 80),
      aliases,
      symbols,
      hyperliquidMarkets: stringList(entity.hyperliquidMarkets, 'Hyperliquid markets', 1, 10).map(marketSymbol),
    }
  })
  unique(entities.map(entity => entity.id), 'Entity ids')
  const entityIds = new Set(entities.map(entity => entity.id))
  const sources = value.sources.map(source => {
    requireOnlyFields(source, ['platform', 'authorId', 'username', 'tier', 'entityIds'], 'Source')
    if (source.platform !== 'x') throw new Error('Only X sources are enabled in this phase.')
    const authorId = clean(source.authorId, 'Source authorId', 1, 40)
    if (!/^\d+$/.test(authorId)) throw new Error('X source authorId must be numeric.')
    const username = clean(source.username, 'Source username', 1, 30).replace(/^@/, '').toLowerCase()
    if (!/^[a-z0-9_]{1,15}$/i.test(username)) throw new Error('X source username is invalid.')
    if (!['official_project', 'security_researcher', 'trusted_reporter'].includes(source.tier)) {
      throw new Error('Source tier is unsupported.')
    }
    const sourceEntityIds = stringList(source.entityIds, 'Source entityIds', 1, 100).map(id => id.toLowerCase())
    if (sourceEntityIds.some(id => !entityIds.has(id))) throw new Error('Source references an unknown entity.')
    return { platform: 'x' as const, authorId, username, tier: source.tier, entityIds: sourceEntityIds }
  })
  unique(sources.map(source => source.authorId), 'Source authorIds')
  return { entities, sources }
}

export function sourceByAuthorId(registry: LolahSourceRegistry, authorId: string) {
  return registry.sources.find(source => source.authorId === authorId)
}

export function entitiesForSource(registry: LolahSourceRegistry, source: LolahSourceDefinition) {
  const allowed = new Set(source.entityIds)
  return registry.entities.filter(entity => allowed.has(entity.id))
}
