import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveXSourceCatalog, type LolahSourceCatalog } from '../src/x-source-resolver.js'

const token = String(process.env.LOLAH_X_BEARER_TOKEN ?? '').trim()
const path = resolve(String(process.env.LOLAH_X_SOURCE_CATALOG_PATH ?? 'config/x-source-catalog.json').trim())
const metadata = await stat(path)
if (!metadata.isFile() || metadata.size < 2 || metadata.size > 512 * 1_024) {
  throw new Error('X source catalog file is invalid.')
}
const catalog = JSON.parse(await readFile(path, 'utf8')) as LolahSourceCatalog
const registry = await resolveXSourceCatalog(catalog, token)
console.log(JSON.stringify(registry, null, 2))
