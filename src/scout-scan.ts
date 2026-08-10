import type { LolahEventScan, LolahNewsEvent } from './contracts.js'
import type { LolahScanRequest } from './event-scan.js'
import { runLiveReadOnlyScan, type LiveLolahScanOptions } from './live-scan.js'
import { LolahNewsScout, type ScoutIngestResult } from './news-scout.js'
import type { RawXPost } from './x-recent-search.js'

export type ScoutScanResult =
  | { status: 'duplicate' | 'ignored'; reason: string }
  | {
      status: 'new_event' | 'updated_event'
      event: LolahNewsEvent
      targetMarkets: string[]
      scans: LolahEventScan[]
    }

export type ScoutScanDependencies = {
  scan: (request: LolahScanRequest) => Promise<LolahEventScan>
}

export async function scoutAndScanPost(
  post: RawXPost,
  scout: LolahNewsScout,
  dependencies: ScoutScanDependencies,
  detectedAt = new Date(),
): Promise<ScoutScanResult> {
  const result = scout.ingest(post, detectedAt)
  if (!('event' in result)) return result
  const scans = await Promise.all(
    result.targetMarkets.map(targetMarket => dependencies.scan({ event: result.event, targetMarket })),
  )
  return { ...result, scans }
}

export async function scoutAndRunLiveReadOnlyScan(
  post: RawXPost,
  scout: LolahNewsScout,
  options: LiveLolahScanOptions,
  detectedAt = new Date(),
) {
  return scoutAndScanPost(
    post,
    scout,
    { scan: request => runLiveReadOnlyScan(request, options) },
    detectedAt,
  )
}
