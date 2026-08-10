import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LolahEventScan } from '../src/contracts.js'
import { LolahDurableStateStore } from '../src/durable-state.js'
import { runLolahEndToEndFixture } from '../src/fixture-scenario-runner.js'
import type { LolahSourceRegistry } from '../src/source-registry.js'

const now = new Date('2026-08-10T10:10:00Z')
const directory = await mkdtemp(join(tmpdir(), 'lolah-e2e-fixture-'))
const registry: LolahSourceRegistry = {
  entities: [{
    id: 'kaito',
    name: 'Kaito',
    aliases: ['Kaito AI'],
    symbols: ['KAITO'],
    hyperliquidMarkets: ['KAITO'],
  }],
  sources: [{
    platform: 'x',
    authorId: '100',
    username: 'kaito_official',
    tier: 'official_project',
    entityIds: ['kaito'],
  }],
}

function scan(eventId: string, market: string): LolahEventScan {
  return {
    schema: 'lolah-event-scan-v1',
    eventId,
    state: 'context_ready',
    reason: 'Verified fixture context is ready.',
    confidenceAdjustment: 'reduced',
    executionAllowed: false,
    polydesk: {
      schema: 'polydesk-market-context-v1',
      provider: 'polydesk',
      eventId,
      matchStatus: 'no_relevant_market',
      searchedAt: now.toISOString(),
      candidates: [],
    },
    hyperliquid: {
      schema: 'lolah-hyperliquid-context-v1',
      venue: 'hyperliquid',
      market,
      marketStatus: 'available',
      observedAt: now.toISOString(),
    },
    observedAt: now.toISOString(),
  }
}

try {
  const accessToken = 'fixture-okx-access-token-123456789'
  const result = await runLolahEndToEndFixture({
    inboundEnvelope: {
      msgType: 'a2a-agent-chat',
      jobId: 'job_watch_001',
      sender: { role: 1 },
      content: 'Watch Kaito for verified news and market context.',
    },
    structuredWatch: {
      jobId: 'job_watch_001',
      recipientAgentId: '123',
      accessToken,
      idempotencyKey: 'fixture-watch-job-001',
      entityIds: ['kaito'],
      targetMarkets: ['KAITO'],
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    },
    introspection: {
      active: true,
      agentId: '123',
      sessionId: 'fixture_session',
      audience: ['lolah'],
      issuedAt: Math.floor(now.getTime() / 1_000),
      expiresAt: Math.floor(now.getTime() / 1_000) + 3_600,
    },
    registry,
    store: new LolahDurableStateStore(join(directory, 'state.json')),
    polling: {
      sourceKey: 'x:fixture-news',
      query: 'Kaito shutdown',
      xBearerToken: 'fixture-x-bearer-token-123456789',
      fetcher: async () => new Response(JSON.stringify({
        data: [{
          id: '99001',
          author_id: '100',
          text: 'Kaito will shut down operations.',
          created_at: '2026-08-10T10:09:00Z',
        }],
        includes: { users: [{ id: '100', username: 'kaito_official' }] },
        meta: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      scan: request => Promise.resolve(scan(request.event.eventId, request.targetMarket)),
    },
    now: () => now,
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'completed') process.exitCode = 1
} finally {
  await rm(directory, { recursive: true, force: true })
}
