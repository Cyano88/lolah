import { createHash } from 'node:crypto'
import type { LolahDurableStateStore, LolahContextJob } from './durable-state.js'
import type { UpbitListingAlertDraft, UpbitListingWorkerStore } from './upbit-listing-worker.js'
import type { LolahSubscriptionSignal } from './subscription-push.js'

function signalId(source: 'x' | 'upbit', value: string) {
  return 'signal_' + source + '_' + createHash('sha256').update(value).digest('hex').slice(0, 40)
}

function expiry(occurredAt: string, lifetimeMs: number) {
  return new Date(Date.parse(occurredAt) + lifetimeMs).toISOString()
}

function compact(parts: Array<string | undefined>) {
  return parts.filter((part): part is string => Boolean(part)).join('\n').slice(0, 2_000)
}

export function xJobSubscriptionSignal(job: LolahContextJob): LolahSubscriptionSignal | undefined {
  if (job.status !== 'completed' || !job.scan || job.event.verification.status === 'unverified'
    || job.scan.state === 'watch') return undefined
  const market = job.scan.hyperliquid
  const polydesk = job.scan.polydesk
  const marketLine = market.marketStatus === 'available'
    ? `Hyperliquid ${market.market}: mark ${market.markPrice ?? 'unavailable'}, 24h move ${market.dayChangeFraction === undefined ? 'unavailable' : (market.dayChangeFraction * 100).toFixed(2) + '%'}, funding ${market.fundingRate ?? 'unavailable'}.`
    : `Hyperliquid ${market.market}: no supported market found.`
  const predictionLine = polydesk.matchStatus === 'matched'
    ? `PolyDesk context: ${polydesk.match?.question ?? 'matched market'}${polydesk.consensus?.probabilityNow === undefined ? '' : `, probability ${(polydesk.consensus.probabilityNow * 100).toFixed(1)}%`}.`
    : polydesk.matchStatus === 'no_relevant_market'
      ? 'PolyDesk context: no relevant Polymarket market is currently published.'
      : 'PolyDesk context: market match is ambiguous; confidence is reduced.'
  return {
    schema: 'lolah-subscription-signal-v1',
    signalId: signalId('x', job.jobId + ':' + job.revisionHash),
    source: 'x',
    occurredAt: job.event.detectedAt,
    expiresAt: expiry(job.event.detectedAt, 30 * 60_000),
    message: compact([
      `[Lolah Intelligence] ${job.event.headline}`,
      `Verification: ${job.event.verification.status}. Event: ${job.event.eventType}.`,
      marketLine,
      predictionLine,
      `Assessment: ${job.scan.reason}`,
      `Source: ${job.event.sourceUrl}`,
      'Intelligence only. Re-check live price, liquidity and risk before taking any action.',
    ]),
    sourceUrls: [job.event.sourceUrl, ...job.event.verification.supportingSources].slice(0, 5),
    executionAllowed: false,
  }
}

export function upbitAlertSubscriptionSignal(alert: UpbitListingAlertDraft): LolahSubscriptionSignal | undefined {
  if (alert.status !== 'prepared' || alert.event.freshness !== 'fresh') return undefined
  const assessments = alert.assessments.map(item =>
    `${item.symbol}: ${item.state.replaceAll('_', ' ')} - ${item.reason}`).join(' ')
  return {
    schema: 'lolah-subscription-signal-v1',
    signalId: signalId('upbit', alert.draftId + ':' + alert.enrichmentStatus),
    source: 'upbit',
    occurredAt: alert.event.detectedAt,
    expiresAt: expiry(alert.event.detectedAt, 30 * 60_000),
    message: compact([
      `[Lolah Upbit Alert] ${alert.event.title}`,
      `Official Upbit listing: ${alert.event.symbols.join(', ')} in ${alert.event.quoteMarkets.join(', ')} market(s).`,
      alert.event.tradingStartsAt ? `Trading starts: ${alert.event.tradingStartsAt}.` : undefined,
      `Detected after ${alert.event.detectionLatencyMs} ms.`,
      assessments ? `Market context: ${assessments}` : 'Market context is still being prepared; verify live conditions before acting.',
      `Source: ${alert.event.sourceUrl}`,
      'Intelligence only. Listing pumps can reverse sharply; no trade has been placed.',
    ]),
    sourceUrls: [alert.event.sourceUrl],
    executionAllowed: false,
  }
}

export async function collectSubscriptionSignals(input: {
  xStore: LolahDurableStateStore
  upbitStore: UpbitListingWorkerStore
}) {
  const [jobs, alerts] = await Promise.all([
    input.xStore.listContextJobs(),
    input.upbitStore.listPreparedAlerts(),
  ])
  return [
    ...jobs.map(xJobSubscriptionSignal),
    ...alerts.map(upbitAlertSubscriptionSignal),
  ].filter((value): value is LolahSubscriptionSignal => Boolean(value))
}
