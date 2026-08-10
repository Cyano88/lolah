import type { LolahEventScan } from './contracts.js'
import { drainReadOnlyContextQueue, type ContextQueueOutcome } from './context-retry-queue.js'
import { LolahDurableStateStore } from './durable-state.js'
import type { LolahScanRequest } from './event-scan.js'
import { LolahNewsScout, type ScoutIngestResult } from './news-scout.js'
import type { LolahSourceRegistry } from './source-registry.js'
import { fetchRecentXPosts } from './x-recent-search.js'

export type ReadOnlyPollingBatchOptions = {
  sourceKey: string
  query: string
  bearerToken: string
  registry: LolahSourceRegistry
  store: LolahDurableStateStore
  scan: (request: LolahScanRequest) => Promise<LolahEventScan>
  fetcher?: typeof fetch
  minimumIntervalMs?: number
  maxPages?: number
  now?: () => Date
}

export type PollingPostResult = {
  postId: string
  status: ScoutIngestResult['status']
  reason?: string
  eventId?: string
  verification?: 'official_source' | 'corroborated' | 'unverified'
  scans: LolahEventScan[]
  failedMarkets: string[]
}

export type ReadOnlyPollingBatchResult =
  | {
      status: 'rate_limited'
      retryAfterMs: number
      posts: []
      contextQueue: ContextQueueSummary
      alertDraftsPrepared: number
      outboxStaged: number
    }
  | {
      status: 'processed'
      fetched: number
      pagesFetched: number
      windowComplete: boolean
      posts: PollingPostResult[]
      contextQueue: ContextQueueSummary
      alertDraftsPrepared: number
      outboxStaged: number
      checkpoint?: { newestPostId: string; newestCreatedAt: string }
    }

type ContextQueueSummary = {
  attempted: number
  completed: number
  retryWait: number
  deadLetter: number
  leaseExpired: number
}

function summarizeContextQueue(outcomes: ContextQueueOutcome[]): ContextQueueSummary {
  return {
    attempted: outcomes.length,
    completed: outcomes.filter(item => item.status === 'completed').length,
    retryWait: outcomes.filter(item => item.status === 'retry_wait').length,
    deadLetter: outcomes.filter(item => item.status === 'dead_letter').length,
    leaseExpired: outcomes.filter(item => item.status === 'lease_expired').length,
  }
}

function chronological(left: { postId: string; createdAt: string }, right: { postId: string; createdAt: string }) {
  const timeDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt)
  if (timeDifference) return timeDifference
  const leftId = BigInt(left.postId)
  const rightId = BigInt(right.postId)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

export async function runReadOnlyPollingBatch(options: ReadOnlyPollingBatchOptions): Promise<ReadOnlyPollingBatchResult> {
  const now = options.now ?? (() => new Date())
  const batchStartedAt = now()
  const gate = await options.store.claimPollWindow(
    options.sourceKey,
    options.minimumIntervalMs ?? 60_000,
    batchStartedAt,
  )
  if (!gate.allowed) {
    const queueOutcomes = await drainReadOnlyContextQueue({ store: options.store, scan: options.scan, now })
    const alertDrafts = await options.store.prepareAlertDrafts(now())
    const outbox = await options.store.stageAlertDraftsToOutbox(now())
    return {
      status: 'rate_limited',
      retryAfterMs: gate.retryAfterMs,
      posts: [],
      contextQueue: summarizeContextQueue(queueOutcomes),
      alertDraftsPrepared: alertDrafts.length,
      outboxStaged: outbox.created,
    }
  }

  const checkpoint = await options.store.getCheckpoint(options.sourceKey)
  const maxPages = options.maxPages ?? 10
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('maxPages must be 1 through 100.')
  }
  const fetchedPosts = new Map<string, Awaited<ReturnType<typeof fetchRecentXPosts>>['posts'][number]>()
  let nextToken: string | undefined
  let pagesFetched = 0
  let windowComplete = false
  const firstBootStartTime = checkpoint
    ? undefined
    : new Date(batchStartedAt.getTime() - 2 * 60_000).toISOString()
  do {
    const page = await fetchRecentXPosts(
      options.query,
      options.bearerToken,
      options.fetcher ?? fetch,
      nextToken,
      checkpoint?.newestPostId,
      firstBootStartTime,
    )
    pagesFetched += 1
    for (const post of page.posts) {
      const existing = fetchedPosts.get(post.postId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(post)) {
        throw new Error('X returned conflicting content for one post ID.')
      }
      fetchedPosts.set(post.postId, post)
    }
    nextToken = page.nextToken
    windowComplete = !nextToken
  } while (nextToken && pagesFetched < maxPages)

  const scout = new LolahNewsScout(options.registry, await options.store.getScoutSnapshot())
  const posts: PollingPostResult[] = []
  const ordered = [...fetchedPosts.values()].sort(chronological)

  for (const post of ordered) {
    const replay = await options.store.inspectPost(post)
    if (replay === 'duplicate') {
      posts.push({ postId: post.postId, status: 'duplicate', reason: 'Post is already durably processed.', scans: [], failedMarkets: [] })
      continue
    }
    const result = scout.ingest(post, batchStartedAt)
    const contextJobs = 'event' in result
      ? result.targetMarkets.map(targetMarket => ({ event: result.event, entityIds: result.entityIds, targetMarket }))
      : []
    await options.store.commitPostScoutAndContextJobs(
      post,
      result.status === 'new_event' || result.status === 'updated_event' ? 'accepted' : 'ignored',
      scout.snapshot(),
      contextJobs,
      batchStartedAt,
    )
    if (!('event' in result)) {
      posts.push({ postId: post.postId, status: result.status, reason: result.reason, scans: [], failedMarkets: [] })
      continue
    }
    posts.push({
      postId: post.postId,
      status: result.status,
      eventId: result.event.eventId,
      verification: result.event.verification.status,
      scans: [],
      failedMarkets: [],
    })
  }

  const queueOutcomes = await drainReadOnlyContextQueue({ store: options.store, scan: options.scan, now })
  const alertDrafts = await options.store.prepareAlertDrafts(now())
  const outbox = await options.store.stageAlertDraftsToOutbox(now())
  for (const outcome of queueOutcomes) {
    for (const post of posts.filter(item => item.eventId === outcome.eventId)) {
      if (outcome.status === 'completed' && outcome.scan) post.scans.push(outcome.scan)
      else if (!post.failedMarkets.includes(outcome.targetMarket)) post.failedMarkets.push(outcome.targetMarket)
    }
  }

  const newest = ordered.at(-1)
  if (newest && windowComplete) {
    await options.store.putCheckpoint({
      sourceKey: options.sourceKey,
      newestPostId: newest.postId,
      newestCreatedAt: newest.createdAt,
    }, batchStartedAt)
  }
  return {
    status: 'processed',
    fetched: ordered.length,
    pagesFetched,
    windowComplete,
    posts,
    contextQueue: summarizeContextQueue(queueOutcomes),
    alertDraftsPrepared: alertDrafts.length,
    outboxStaged: outbox.created,
    ...(newest && windowComplete ? { checkpoint: { newestPostId: newest.postId, newestCreatedAt: newest.createdAt } } : {}),
  }
}
