import type { LolahEventScan } from './contracts.js'
import { LolahDurableStateStore } from './durable-state.js'
import type { LolahScanRequest } from './event-scan.js'

export type ContextQueueDrainOptions = {
  store: LolahDurableStateStore
  scan: (request: LolahScanRequest) => Promise<LolahEventScan>
  now?: () => Date
  limit?: number
  leaseMs?: number
}

export type ContextQueueOutcome = {
  jobId: string
  eventId: string
  targetMarket: string
  status: 'completed' | 'retry_wait' | 'dead_letter' | 'lease_expired'
  scan?: LolahEventScan
}

export async function drainReadOnlyContextQueue(options: ContextQueueDrainOptions): Promise<ContextQueueOutcome[]> {
  const now = options.now ?? (() => new Date())
  const jobs = await options.store.claimContextJobs(now(), options.limit ?? 20, options.leaseMs ?? 60_000)
  return Promise.all(jobs.map(async job => {
    try {
      const scan = await options.scan({ event: job.event, targetMarket: job.targetMarket })
      const completed = await options.store.completeContextJob(job.jobId, scan, now())
      return {
        jobId: job.jobId,
        eventId: job.event.eventId,
        targetMarket: job.targetMarket,
        status: 'completed' as const,
        scan: completed.scan!,
      }
    } catch {
      try {
        const failed = await options.store.failContextJob(job.jobId, now())
        return {
          jobId: job.jobId,
          eventId: job.event.eventId,
          targetMarket: job.targetMarket,
          status: failed.status as 'retry_wait' | 'dead_letter',
        }
      } catch {
        return {
          jobId: job.jobId,
          eventId: job.event.eventId,
          targetMarket: job.targetMarket,
          status: 'lease_expired' as const,
        }
      }
    }
  }))
}
