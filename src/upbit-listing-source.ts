import type { UpbitPollResult } from './upbit-listing-monitor.js'
import type { UpbitListingMonitorSnapshot } from './upbit-listing-monitor.js'

export type UpbitCoinListingSnapshot = {
  schema: 'lolah-upbit-coinlisting-state-v1'
  revisions: Array<{ noticeId: number; revisionId: string }>
}

export type UpbitListingSourceSnapshot = UpbitListingMonitorSnapshot | UpbitCoinListingSnapshot

export interface UpbitListingSource {
  poll(detectedAt?: Date): Promise<UpbitPollResult>
  snapshot(): UpbitListingSourceSnapshot
}
