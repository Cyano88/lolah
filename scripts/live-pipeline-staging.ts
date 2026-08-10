import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LolahDurableStateStore } from '../src/durable-state.js'
import { runLolahLivePipeline } from '../src/live-pipeline-runner.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'

const safety = {
  simulationOnly: true as const,
  sendAllowed: false as const,
  executionAllowed: false as const,
}

function value(name: string) {
  return String(process.env[name] ?? '').trim()
}

function list(name: string) {
  return [...new Set(value(name).split(',').map(item => item.trim()).filter(Boolean))]
}

async function loadRegistry(path: string) {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > 256 * 1_024) {
    throw new Error('registry_invalid')
  }
  return JSON.parse(await readFile(path, 'utf8')) as LolahSourceRegistry
}

async function main() {
  const required = [
    'X_BEARER_TOKEN',
    'LOLAH_SOURCE_REGISTRY_PATH',
    'LOLAH_X_QUERY',
    'LOLAH_WATCH_ENTITY_IDS',
    'LOLAH_WATCH_TARGET_MARKETS',
  ]
  const missing = required.filter(name => !value(name))
  if (missing.length) {
    console.log(JSON.stringify({
      schema: 'lolah-live-pipeline-preflight-v1',
      status: 'blocked',
      errorCode: 'configuration_missing',
      missing,
      ...safety,
    }, null, 2))
    process.exitCode = 2
    return
  }

  const directory = await mkdtemp(join(tmpdir(), 'lolah-live-pipeline-'))
  try {
    const now = new Date()
    const result = await runLolahLivePipeline({
      registry: await loadRegistry(value('LOLAH_SOURCE_REGISTRY_PATH')),
      store: new LolahDurableStateStore(join(directory, 'state.json')),
      sourceKey: 'x:live-staging',
      query: value('LOLAH_X_QUERY'),
      xBearerToken: value('X_BEARER_TOKEN'),
      polydeskEndpoint: value('POLYDESK_CONTEXT_ENDPOINT')
        || 'http://127.0.0.1:4317/api/agent/polymarket-context',
      mode: 'local_staging',
      watch: {
        recipientId: 'staging:lolah-shadow',
        entityIds: list('LOLAH_WATCH_ENTITY_IDS'),
        targetMarkets: list('LOLAH_WATCH_TARGET_MARKETS'),
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        idempotencyKey: 'live-pipeline-staging',
      },
      now: () => now,
    })
    console.log(JSON.stringify(result, null, 2))
  } catch {
    console.log(JSON.stringify({
      schema: 'lolah-live-pipeline-preflight-v1',
      status: 'blocked',
      errorCode: 'pipeline_failed',
      ...safety,
    }, null, 2))
    process.exitCode = 1
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

await main()
