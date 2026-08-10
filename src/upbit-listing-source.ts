import type { UpbitPollResult } from './upbit-listing-monitor.js'
import type { UpbitListingMonitorSnapshot } from './upbit-listing-monitor.js'

export type UpbitSignedRelaySnapshot = {
  schema: 'lolah-upbit-relay-state-v1'
  lastSequence?: number
  lastDigest?: string
  revisions: Array<{ noticeId: number; revisionId: string }>
}

export type UpbitListingSourceSnapshot = UpbitListingMonitorSnapshot | UpbitSignedRelaySnapshot

export interface UpbitListingSource {
  poll(detectedAt?: Date): Promise<UpbitPollResult>
  snapshot(): UpbitListingSourceSnapshot
}
