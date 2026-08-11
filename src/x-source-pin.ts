import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { validateSourceRegistry, type LolahSourceRegistry } from './source-registry.js'
import { resolveXSourceCatalog, type LolahSourceCatalog } from './x-source-resolver.js'

type PinnedRegistry = {
  schema: 'lolah-x-source-pin-v1'
  catalogSha256: string
  registry: LolahSourceRegistry
}

async function boundedJson(path: string, label: string) {
  const raw = await readFile(path, 'utf8')
  if (raw.length < 2 || raw.length > 512 * 1_024) throw new Error(label + ' is invalid.')
  return { raw, parsed: JSON.parse(raw) as unknown }
}

function catalogHash(raw: string) {
  return createHash('sha256').update(raw).digest('hex')
}

function additiveRegistryUpdate(previousInput: LolahSourceRegistry, nextInput: LolahSourceRegistry) {
  const previous = validateSourceRegistry(previousInput)
  const next = validateSourceRegistry(nextInput)
  const entities = new Map(next.entities.map(entity => [entity.id, JSON.stringify(entity)]))
  const sources = new Map(next.sources.map(source => [source.username, JSON.stringify(source)]))
  return previous.entities.every(entity => entities.get(entity.id) === JSON.stringify(entity))
    && previous.sources.every(source => sources.get(source.username) === JSON.stringify(source))
}

export async function loadOrPinXSourceRegistry(options: {
  catalogPath: string
  pinPath: string
  bearerToken: string
  fetcher?: typeof fetch
}) {
  const catalogFile = await boundedJson(options.catalogPath, 'X source catalog')
  const digest = catalogHash(catalogFile.raw)
  let previousRegistry: LolahSourceRegistry | undefined
  try {
    const pinnedFile = await boundedJson(options.pinPath, 'Pinned X source registry')
    const pinned = pinnedFile.parsed as Partial<PinnedRegistry>
    if (pinned?.schema !== 'lolah-x-source-pin-v1' || !pinned.registry) {
      throw new Error('Pinned X source registry does not match the curated catalog.')
    }
    previousRegistry = validateSourceRegistry(pinned.registry)
    if (pinned.catalogSha256 === digest) return previousRegistry
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }

  const registry = await resolveXSourceCatalog(
    catalogFile.parsed as LolahSourceCatalog,
    options.bearerToken,
    options.fetcher,
  )
  if (previousRegistry && !additiveRegistryUpdate(previousRegistry, registry)) {
    throw new Error('Pinned X source registry does not match the curated catalog.')
  }
  const pinned: PinnedRegistry = { schema: 'lolah-x-source-pin-v1', catalogSha256: digest, registry }
  await mkdir(dirname(options.pinPath), { recursive: true })
  const temporaryPath = options.pinPath + '.' + process.pid + '.' + Date.now() + '.tmp'
  try {
    await writeFile(temporaryPath, JSON.stringify(pinned, null, 2) + '\n', {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    })
    if (previousRegistry) await unlink(options.pinPath)
    await rename(temporaryPath, options.pinPath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  return registry
}
