import type { LolahNewsEvent } from '../src/contracts.js'
import { runLolahLiveShadow } from '../src/live-shadow-runner.js'

const now = new Date()
const event: LolahNewsEvent = {
  schema: 'lolah-news-event-v1',
  eventId: 'evt_live_shadow_probe_20260810',
  headline: 'Bitcoin network outage context availability probe',
  publisher: 'lolah-shadow',
  sourceUrl: 'https://example.com/lolah-live-shape-probe',
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
    ?? 'https://polydesk.trade/api/agent/polymarket-context',
  x: {
    query: 'Bitcoin network outage',
    bearerToken: process.env.X_BEARER_TOKEN,
  },
  now: () => now,
})

console.log(JSON.stringify(result, null, 2))
if (result.state === 'unavailable') process.exitCode = 1
