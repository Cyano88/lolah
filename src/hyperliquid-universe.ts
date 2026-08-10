import { validateSourceRegistry, type LolahEntityDefinition, type LolahSourceRegistry } from './source-registry.js'

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function marketName(value: unknown) {
  const market = String(value ?? '').trim()
  if (!/^(?:[a-z0-9]+:)?[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(market)) return undefined
  const separator = market.indexOf(':')
  return separator < 0
    ? market.toUpperCase()
    : market.slice(0, separator).toLowerCase() + ':' + market.slice(separator + 1).toUpperCase()
}

function generatedEntity(market: string): LolahEntityDefinition {
  const separator = market.indexOf(':')
  const symbol = separator < 0 ? market : market.slice(separator + 1)
  return {
    id: 'hl_' + market.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    name: symbol.length >= 2 ? symbol : symbol + ' market',
    aliases: [symbol],
    symbols: [symbol],
    hyperliquidMarkets: [market],
    matchMode: 'symbol_strict',
  }
}

export async function expandRegistryWithHyperliquidUniverse(
  registryInput: LolahSourceRegistry,
  fetcher: typeof fetch = fetch,
): Promise<LolahSourceRegistry> {
  const registry = validateSourceRegistry(registryInput)
  const response = await fetcher('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('Hyperliquid universe request failed with HTTP ' + response.status + '.')
  const payload: unknown = await response.json()
  if (!record(payload) || !Array.isArray(payload.universe)) throw new Error('Hyperliquid returned an invalid universe.')
  const knownMarkets = new Set(registry.entities.flatMap(entity => entity.hyperliquidMarkets).map(value => value.toLowerCase()))
  const additions: LolahEntityDefinition[] = []
  for (const item of payload.universe) {
    const market = record(item) ? marketName(item.name) : undefined
    if (!market || knownMarkets.has(market.toLowerCase())) continue
    knownMarkets.add(market.toLowerCase())
    additions.push(generatedEntity(market))
  }
  if (!additions.length) return registry
  return validateSourceRegistry({ entities: [...registry.entities, ...additions], sources: registry.sources })
}
