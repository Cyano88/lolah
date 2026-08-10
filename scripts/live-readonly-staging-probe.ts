import type { LolahNewsEvent } from '../src/contracts.js'
import { runLolahLiveShadow } from '../src/live-shadow-runner.js'

const now = new Date()
const event: LolahNewsEvent = {
  schema: 'lolah-news-event-v1',
  eventId: 'evt_local_staging_probe_20260810',
  headline: 'Bitcoin network outage context availability probe',
  publisher: 'lolah-local-staging',
  sourceUrl: 'https://example.com/lolah-local-staging-probe',
  publishedAt: now.toISOString(),
  detectedAt: now.toISOString(),
  entities: ['Bitcoin'],
  eventType: 'network_outage',
  verification: { status: 'unverified', supportingSources: [] },
}

const result = await runLolahLiveShadow({
  event,
  targetMarket: 'BTC',
  polydeskEndpoint: process.env.POLYDESK_CONTEXT_ENDPOINT
    ?? 'http://127.0.0.1:4317/api/agent/polymarket-context',
  mode: 'local_staging',
  x: {
    query: 'Bitcoin network outage',
    bearerToken: process.env.X_BEARER_TOKEN,
  },
  now: () => now,
})

console.log(JSON.stringify(result, null, 2))
if (result.components.polydesk.status !== 'ok'
  || result.components.hyperliquid.status !== 'ok') {
  process.exitCode = 1
}
