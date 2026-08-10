import {
  validateSourceRegistry,
  type LolahEntityDefinition,
  type LolahSourceCategory,
  type LolahSourceRegistry,
  type LolahSourceTier,
} from './source-registry.js'

export type LolahSourceCatalog = {
  schema: 'lolah-x-source-catalog-v1'
  entities: LolahEntityDefinition[]
  sources: Array<{
    username: string
    tier: LolahSourceTier
    category: LolahSourceCategory
    entityIds: string[]
    identityProofUrl: string
  }>
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function batches<T>(values: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function validateCatalog(catalog: LolahSourceCatalog) {
  if (!catalog || catalog.schema !== 'lolah-x-source-catalog-v1'
    || !Array.isArray(catalog.entities) || !catalog.entities.length
    || !Array.isArray(catalog.sources) || !catalog.sources.length || catalog.sources.length > 2_000) {
    throw new Error('X source catalog is invalid.')
  }
  const usernames = new Set<string>()
  for (const source of catalog.sources) {
    const username = String(source?.username ?? '').replace(/^@/, '').toLowerCase()
    if (!/^[a-z0-9_]{1,15}$/.test(username) || usernames.has(username)) {
      throw new Error('X source catalog username is invalid or duplicated.')
    }
    usernames.add(username)
    const proof = new URL(String(source.identityProofUrl ?? ''))
    if (proof.protocol !== 'https:' || proof.username || proof.password
      || ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(proof.hostname.toLowerCase())) {
      throw new Error('X source identity requires a non-X HTTPS proof URL.')
    }
  }
}

export async function resolveXSourceCatalog(
  catalog: LolahSourceCatalog,
  bearerToken: string,
  fetcher: typeof fetch = fetch,
): Promise<LolahSourceRegistry> {
  validateCatalog(catalog)
  if (bearerToken.length < 20 || bearerToken.length > 8_192) throw new Error('X API access is not configured.')
  const identities = new Map<string, string>()
  for (const group of batches(catalog.sources, 100)) {
    const params = new URLSearchParams({ usernames: group.map(source => source.username.replace(/^@/, '')).join(',') })
    const response = await fetcher('https://api.x.com/2/users/by?' + params.toString(), {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearerToken },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error('X user lookup failed with HTTP ' + response.status + '.')
    const payload: unknown = await response.json()
    if (!record(payload) || !Array.isArray(payload.data)) throw new Error('X returned an invalid user lookup response.')
    for (const item of payload.data) {
      if (!record(item)) continue
      const id = String(item.id ?? '').trim()
      const username = String(item.username ?? '').trim().toLowerCase()
      if (/^\d+$/.test(id) && /^[a-z0-9_]{1,15}$/.test(username)) identities.set(username, id)
    }
  }
  const missing = catalog.sources.filter(source => !identities.has(source.username.replace(/^@/, '').toLowerCase()))
  if (missing.length) throw new Error('X did not resolve every curated source identity.')
  return validateSourceRegistry({
    entities: catalog.entities,
    sources: catalog.sources.map(source => ({
      platform: 'x',
      authorId: identities.get(source.username.replace(/^@/, '').toLowerCase())!,
      username: source.username,
      tier: source.tier,
      category: source.category,
      entityIds: source.entityIds,
    })),
  })
}
