import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { LolahEventScan, LolahNewsEvent } from './contracts.js'
import type { LolahNewsScoutSnapshot } from './news-scout.js'

const STATE_SCHEMA = 'lolah-durable-state-v5'
const MAX_WATCH_MS = 30 * 24 * 60 * 60_000
const MAX_POST_RECEIPTS = 10_000
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{2,127}$/
const WRITE_QUEUES = new Map<string, Promise<void>>()

export type LolahWatch = {
  watchId: string
  recipientId: string
  entityIds: string[]
  targetMarkets: string[]
  createdAt: string
  expiresAt: string
  status: 'active' | 'expired' | 'cancelled'
  idempotencyKeyHash?: string
  requestFingerprint?: string
}

export type LolahPollingCheckpoint = {
  sourceKey: string
  newestPostId: string
  newestCreatedAt: string
  updatedAt: string
}

export type LolahDeliveryEnvelope = {
  schema: 'lolah-delivery-envelope-v1'
  deliveryId: string
  watchId: string
  recipientId: string
  eventId: string
  preparedAt: string
  sendAllowed: false
}

export type LolahContextJob = {
  schema: 'lolah-context-job-v1'
  jobId: string
  revisionHash: string
  event: LolahNewsEvent
  entityIds: string[]
  targetMarket: string
  status: 'pending' | 'in_progress' | 'retry_wait' | 'completed' | 'dead_letter'
  attempts: number
  createdAt: string
  updatedAt: string
  nextAttemptAt: string
  leaseUntil?: string
  failureCode?: 'provider_unavailable'
  scan?: LolahEventScan
}

export type LolahAlertDraft = {
  schema: 'lolah-alert-draft-v1'
  draftId: string
  sourceJobId: string
  revisionHash: string
  watchId: string
  recipientId: string
  eventId: string
  entityIds: string[]
  targetMarket: string
  verification: 'official_source' | 'corroborated'
  alertClass: 'context_ready' | 'risk_blocked'
  scanState: 'context_ready' | 'no_trade'
  reason: string
  preparedAt: string
  status: 'prepared' | 'superseded'
  sendAllowed: false
}

export type LolahOutboxItem = {
  schema: 'lolah-outbox-item-v1'
  outboxId: string
  draftId: string
  recipientId: string
  status: 'pending' | 'in_progress' | 'retry_wait' | 'acknowledged_simulated' | 'dead_letter' | 'superseded'
  attempts: number
  createdAt: string
  updatedAt: string
  nextAttemptAt: string
  leaseSessionId?: string
  leaseUntil?: string
  failureCode?: 'simulation_unacknowledged'
  simulationOnly: true
  sendAllowed: false
}

type PostReceipt = {
  postId: string
  fingerprint: string
  outcome: 'accepted' | 'ignored'
  processedAt: string
}

type DurableState = {
  schema: typeof STATE_SCHEMA
  watches: LolahWatch[]
  postReceipts: PostReceipt[]
  checkpoints: LolahPollingCheckpoint[]
  deliveries: LolahDeliveryEnvelope[]
  pollGates: Array<{ sourceKey: string; nextAllowedAt: string }>
  contextJobs: LolahContextJob[]
  alertDrafts: LolahAlertDraft[]
  outbox: LolahOutboxItem[]
  scoutSnapshot?: LolahNewsScoutSnapshot
}

export type CreateWatchInput = {
  recipientId: string
  entityIds: string[]
  targetMarkets: string[]
  expiresAt: Date
}

export type DeliveryCandidate = {
  eventId: string
  entityIds: string[]
  targetMarkets: string[]
}

function emptyState(): DurableState {
  return {
    schema: STATE_SCHEMA,
    watches: [],
    postReceipts: [],
    checkpoints: [],
    deliveries: [],
    pollGates: [],
    contextJobs: [],
    alertDrafts: [],
    outbox: [],
  }
}

function cleanId(value: string, label: string) {
  const result = String(value ?? '').trim()
  if (!ID_PATTERN.test(result)) throw new Error(label + ' is invalid.')
  return result
}

function uniqueIds(values: string[], label: string, maximum = 50) {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) {
    throw new Error(label + ' must contain 1 through ' + maximum + ' values.')
  }
  const result = values.map(value => cleanId(value, label + ' item'))
  if (new Set(result.map(value => value.toLowerCase())).size !== result.length) {
    throw new Error(label + ' must not contain duplicates.')
  }
  return result
}

function isoDate(value: string, label: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(label + ' is invalid.')
  return new Date(timestamp).toISOString()
}

function assertState(value: unknown): asserts value is DurableState {
  if (!value || typeof value !== 'object') throw new Error('Lolah state file is invalid.')
  const state = value as Partial<DurableState>
  if (state.schema !== STATE_SCHEMA || !Array.isArray(state.watches) || !Array.isArray(state.postReceipts)
    || !Array.isArray(state.checkpoints) || !Array.isArray(state.deliveries)
    || !Array.isArray(state.pollGates) || !Array.isArray(state.contextJobs)
    || !Array.isArray(state.alertDrafts) || !Array.isArray(state.outbox)) {
    throw new Error('Lolah state file is invalid.')
  }
  if (state.watches.length > 10_000 || state.postReceipts.length > MAX_POST_RECEIPTS
    || state.checkpoints.length > 2_000 || state.deliveries.length > 20_000
    || state.pollGates.length > 2_000 || state.contextJobs.length > 10_000
    || state.alertDrafts.length > 20_000 || state.outbox.length > 20_000) {
    throw new Error('Lolah state file exceeds safety limits.')
  }
  for (const watch of state.watches) {
    cleanId(watch.watchId, 'Stored watchId')
    cleanId(watch.recipientId, 'Stored recipientId')
    uniqueIds(watch.entityIds, 'Stored entityIds')
    uniqueIds(watch.targetMarkets, 'Stored targetMarkets')
    isoDate(watch.createdAt, 'Stored watch createdAt')
    isoDate(watch.expiresAt, 'Stored watch expiresAt')
    if (!['active', 'expired', 'cancelled'].includes(watch.status)) throw new Error('Stored watch status is invalid.')
    if ((watch.idempotencyKeyHash && !/^[a-f0-9]{64}$/.test(watch.idempotencyKeyHash))
      || (watch.requestFingerprint && !/^[a-f0-9]{64}$/.test(watch.requestFingerprint))
      || Boolean(watch.idempotencyKeyHash) !== Boolean(watch.requestFingerprint)) {
      throw new Error('Stored watch idempotency state is invalid.')
    }
  }
  for (const receipt of state.postReceipts) {
    if (!/^\d+$/.test(receipt.postId) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
      || !['accepted', 'ignored'].includes(receipt.outcome)) throw new Error('Stored post receipt is invalid.')
    isoDate(receipt.processedAt, 'Stored post processedAt')
  }
  for (const checkpoint of state.checkpoints) {
    cleanId(checkpoint.sourceKey, 'Stored sourceKey')
    if (!/^\d+$/.test(checkpoint.newestPostId)) throw new Error('Stored checkpoint postId is invalid.')
    isoDate(checkpoint.newestCreatedAt, 'Stored checkpoint newestCreatedAt')
    isoDate(checkpoint.updatedAt, 'Stored checkpoint updatedAt')
  }
  for (const envelope of state.deliveries) {
    if (envelope.schema !== 'lolah-delivery-envelope-v1' || envelope.sendAllowed !== false) {
      throw new Error('Stored delivery envelope is invalid.')
    }
    cleanId(envelope.deliveryId, 'Stored deliveryId')
    cleanId(envelope.watchId, 'Stored delivery watchId')
    cleanId(envelope.recipientId, 'Stored delivery recipientId')
    cleanId(envelope.eventId, 'Stored delivery eventId')
    isoDate(envelope.preparedAt, 'Stored delivery preparedAt')
  }
  for (const gate of state.pollGates) {
    cleanId(gate.sourceKey, 'Stored poll sourceKey')
    isoDate(gate.nextAllowedAt, 'Stored poll nextAllowedAt')
  }
  for (const job of state.contextJobs) {
    if (job.schema !== 'lolah-context-job-v1' || !['pending', 'in_progress', 'retry_wait', 'completed', 'dead_letter'].includes(job.status)
      || !Number.isInteger(job.attempts) || job.attempts < 0 || job.attempts > 5) {
      throw new Error('Stored context job is invalid.')
    }
    cleanId(job.jobId, 'Stored context jobId')
    if (!/^[a-f0-9]{64}$/.test(job.revisionHash)) throw new Error('Stored context revision is invalid.')
    uniqueIds(job.entityIds, 'Stored context entityIds')
    cleanId(job.targetMarket, 'Stored context targetMarket')
    isoDate(job.createdAt, 'Stored context createdAt')
    isoDate(job.updatedAt, 'Stored context updatedAt')
    isoDate(job.nextAttemptAt, 'Stored context nextAttemptAt')
    if (job.leaseUntil) isoDate(job.leaseUntil, 'Stored context leaseUntil')
    if (job.failureCode && job.failureCode !== 'provider_unavailable') throw new Error('Stored context failure code is invalid.')
    if (job.event?.schema !== 'lolah-news-event-v1' || !job.event.eventId.startsWith('evt_')
      || !Array.isArray(job.event.entities) || !job.event.entities.length) {
      throw new Error('Stored context event is invalid.')
    }
    if (job.status === 'completed') {
      if (!job.scan || !contextScanMatches(job.scan, job.event.eventId, job.targetMarket)) {
        throw new Error('Stored context scan is invalid.')
      }
    } else if (job.scan) {
      throw new Error('Incomplete context job must not contain a scan.')
    }
  }
  for (const draft of state.alertDrafts) {
    if (draft.schema !== 'lolah-alert-draft-v1' || draft.sendAllowed !== false
      || !['official_source', 'corroborated'].includes(draft.verification)
      || !['context_ready', 'risk_blocked'].includes(draft.alertClass)
      || !['prepared', 'superseded'].includes(draft.status)
      || !['context_ready', 'no_trade'].includes(draft.scanState)
      || typeof draft.reason !== 'string' || draft.reason.length < 1 || draft.reason.length > 500) {
      throw new Error('Stored alert draft is invalid.')
    }
    cleanId(draft.draftId, 'Stored alert draftId')
    cleanId(draft.sourceJobId, 'Stored alert sourceJobId')
    cleanId(draft.watchId, 'Stored alert watchId')
    cleanId(draft.recipientId, 'Stored alert recipientId')
    cleanId(draft.eventId, 'Stored alert eventId')
    cleanId(draft.targetMarket, 'Stored alert targetMarket')
    uniqueIds(draft.entityIds, 'Stored alert entityIds')
    if (!/^[a-f0-9]{64}$/.test(draft.revisionHash)) throw new Error('Stored alert revision is invalid.')
    isoDate(draft.preparedAt, 'Stored alert preparedAt')
  }
  for (const item of state.outbox) {
    if (item.schema !== 'lolah-outbox-item-v1' || item.simulationOnly !== true || item.sendAllowed !== false
      || !['pending', 'in_progress', 'retry_wait', 'acknowledged_simulated', 'dead_letter', 'superseded'].includes(item.status)
      || !Number.isInteger(item.attempts) || item.attempts < 0 || item.attempts > 5) {
      throw new Error('Stored outbox item is invalid.')
    }
    cleanId(item.outboxId, 'Stored outboxId')
    cleanId(item.draftId, 'Stored outbox draftId')
    cleanId(item.recipientId, 'Stored outbox recipientId')
    isoDate(item.createdAt, 'Stored outbox createdAt')
    isoDate(item.updatedAt, 'Stored outbox updatedAt')
    isoDate(item.nextAttemptAt, 'Stored outbox nextAttemptAt')
    if (item.leaseSessionId) cleanId(item.leaseSessionId, 'Stored outbox leaseSessionId')
    if (item.leaseUntil) isoDate(item.leaseUntil, 'Stored outbox leaseUntil')
    if (item.status === 'in_progress' && (!item.leaseSessionId || !item.leaseUntil)) {
      throw new Error('In-progress outbox item requires a session lease.')
    }
    if (item.status !== 'in_progress' && (item.leaseSessionId || item.leaseUntil)) {
      throw new Error('Inactive outbox item must not retain a session lease.')
    }
    if (item.failureCode && item.failureCode !== 'simulation_unacknowledged') {
      throw new Error('Stored outbox failure code is invalid.')
    }
  }
  if (state.scoutSnapshot !== undefined) {
    if (!state.scoutSnapshot || state.scoutSnapshot.schema !== 'lolah-news-scout-state-v1'
      || !Array.isArray(state.scoutSnapshot.seenPostIds) || !Array.isArray(state.scoutSnapshot.clusters)
      || state.scoutSnapshot.seenPostIds.length > 10_000 || state.scoutSnapshot.clusters.length > 5_000) {
      throw new Error('Stored scout snapshot is invalid.')
    }
  }
}

function fingerprintPost(post: { postId: string; authorId: string; text: string; createdAt: string; sourceUrl: string }) {
  if (!/^\d+$/.test(post.postId) || !/^\d+$/.test(post.authorId)) throw new Error('Post identity is invalid.')
  return createHash('sha256')
    .update(JSON.stringify([post.postId, post.authorId, post.text, post.createdAt, post.sourceUrl]))
    .digest('hex')
}

function eventRevision(event: LolahNewsEvent) {
  return createHash('sha256').update(JSON.stringify([
    event.eventId,
    event.verification.status,
    event.sourceUrl,
    [...event.verification.supportingSources].sort(),
    event.publishedAt,
  ])).digest('hex')
}

function contextScanMatches(scan: LolahEventScan, eventId: string, targetMarket: string) {
  return scan?.schema === 'lolah-event-scan-v1'
    && scan.executionAllowed === false
    && scan.eventId === eventId
    && ['context_ready', 'watch', 'no_trade'].includes(scan.state)
    && typeof scan.reason === 'string'
    && scan.reason.length >= 1
    && scan.reason.length <= 500
    && ['normal', 'reduced', 'blocked'].includes(scan.confidenceAdjustment)
    && Number.isFinite(Date.parse(scan.observedAt))
    && scan.polydesk?.schema === 'polydesk-market-context-v1'
    && scan.polydesk.provider === 'polydesk'
    && scan.polydesk.eventId === eventId
    && scan.hyperliquid?.schema === 'lolah-hyperliquid-context-v1'
    && scan.hyperliquid.venue === 'hyperliquid'
    && scan.hyperliquid.market === targetMarket
}

function overlaps(left: string[], right: string[]) {
  const values = new Set(left.map(value => value.toLowerCase()))
  return right.some(value => values.has(value.toLowerCase()))
}

export class LolahDurableStateStore {
  private readonly filePath: string

  constructor(filePath: string) {
    if (!filePath || !filePath.trim()) throw new Error('Lolah state path is required.')
    this.filePath = resolve(filePath)
  }

  private async load() {
    try {
      let parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        const previous = parsed as Record<string, unknown>
        const schema = String(previous.schema ?? '')
        if (schema === 'lolah-durable-state-v4') {
          const drafts = Array.isArray(previous.alertDrafts)
            ? previous.alertDrafts.map(value => ({ ...(value as Record<string, unknown>), status: (value as { status?: string }).status ?? 'prepared' }))
            : []
          parsed = { ...previous, schema: STATE_SCHEMA, alertDrafts: drafts, outbox: [] }
        } else if (['lolah-durable-state-v2', 'lolah-durable-state-v3'].includes(schema)) {
          parsed = { ...previous, schema: STATE_SCHEMA, contextJobs: [], alertDrafts: [], outbox: [] }
        }
      }
      assertState(parsed)
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      if (error instanceof SyntaxError) throw new Error('Lolah state file is invalid JSON.')
      throw error
    }
  }

  private async save(state: DurableState) {
    assertState(state)
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = this.filePath + '.' + process.pid + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporaryPath, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  private async mutate<T>(operation: (state: DurableState) => T | Promise<T>): Promise<T> {
    const prior = WRITE_QUEUES.get(this.filePath) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>(resolveQueue => { release = resolveQueue })
    WRITE_QUEUES.set(this.filePath, current)
    await prior
    try {
      const state = await this.load()
      const result = await operation(state)
      await this.save(state)
      return result
    } finally {
      release()
      if (WRITE_QUEUES.get(this.filePath) === current) WRITE_QUEUES.delete(this.filePath)
    }
  }

  async createWatch(input: CreateWatchInput, now = new Date(), idempotencyKey?: string): Promise<LolahWatch> {
    const recipientId = cleanId(input.recipientId, 'recipientId')
    const entityIds = uniqueIds(input.entityIds, 'entityIds')
    const targetMarkets = uniqueIds(input.targetMarkets, 'targetMarkets')
    const nowMs = now.getTime()
    const expiresAtMs = input.expiresAt.getTime()
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs)
      || expiresAtMs <= nowMs || expiresAtMs - nowMs > MAX_WATCH_MS) {
      throw new Error('Watch expiry must be in the future and no more than 30 days away.')
    }
    let idempotencyKeyHash: string | undefined
    let requestFingerprint: string | undefined
    if (idempotencyKey !== undefined) {
      if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new Error('Idempotency key is invalid.')
      idempotencyKeyHash = createHash('sha256').update(idempotencyKey).digest('hex')
      requestFingerprint = createHash('sha256').update(JSON.stringify([
        recipientId,
        [...entityIds].map(value => value.toLowerCase()).sort(),
        [...targetMarkets].map(value => value.toLowerCase()).sort(),
        input.expiresAt.toISOString(),
      ])).digest('hex')
    }
    return this.mutate(state => {
      if (idempotencyKeyHash) {
        const existing = state.watches.find(watch => watch.recipientId === recipientId
          && watch.idempotencyKeyHash === idempotencyKeyHash)
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) throw new Error('Watch idempotency conflict.')
          return structuredClone(existing)
        }
      }
      const watch: LolahWatch = {
        watchId: 'watch_' + randomUUID(),
        recipientId,
        entityIds,
        targetMarkets,
        createdAt: now.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        status: 'active',
        ...(idempotencyKeyHash ? { idempotencyKeyHash, requestFingerprint } : {}),
      }
      state.watches.push(watch)
      return watch
    })
  }

  async cancelWatch(watchId: string, recipientId: string): Promise<LolahWatch> {
    return this.mutate(state => {
      const watch = state.watches.find(item => item.watchId === cleanId(watchId, 'watchId')
        && item.recipientId === cleanId(recipientId, 'recipientId'))
      if (!watch) throw new Error('Watch is unavailable for this recipient.')
      if (watch.status === 'active') watch.status = 'cancelled'
      return { ...watch }
    })
  }

  async listRecipientWatches(recipientId: string, now = new Date()): Promise<LolahWatch[]> {
    const normalizedRecipientId = cleanId(recipientId, 'recipientId')
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      for (const watch of state.watches) {
        if (watch.status === 'active' && Date.parse(watch.expiresAt) <= nowMs) watch.status = 'expired'
      }
      return structuredClone(state.watches.filter(watch => watch.recipientId === normalizedRecipientId))
    })
  }

  async activeWatches(candidate: Omit<DeliveryCandidate, 'eventId'>, now = new Date()): Promise<LolahWatch[]> {
    const entityIds = uniqueIds(candidate.entityIds, 'entityIds')
    const targetMarkets = uniqueIds(candidate.targetMarkets, 'targetMarkets')
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      for (const watch of state.watches) {
        if (watch.status === 'active' && Date.parse(watch.expiresAt) <= nowMs) watch.status = 'expired'
      }
      return state.watches
        .filter(watch => watch.status === 'active'
          && (overlaps(watch.entityIds, entityIds) || overlaps(watch.targetMarkets, targetMarkets)))
        .map(watch => ({ ...watch, entityIds: [...watch.entityIds], targetMarkets: [...watch.targetMarkets] }))
    })
  }

  async recordPost(
    post: { postId: string; authorId: string; text: string; createdAt: string; sourceUrl: string },
    outcome: PostReceipt['outcome'],
    processedAt = new Date(),
  ): Promise<'recorded' | 'duplicate'> {
    const fingerprint = fingerprintPost(post)
    if (!['accepted', 'ignored'].includes(outcome) || !Number.isFinite(processedAt.getTime())) {
      throw new Error('Post receipt is invalid.')
    }
    return this.mutate(state => {
      const existing = state.postReceipts.find(receipt => receipt.postId === post.postId)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('Post replay conflicts with the stored fingerprint.')
        return 'duplicate'
      }
      state.postReceipts.push({ postId: post.postId, fingerprint, outcome, processedAt: processedAt.toISOString() })
      if (state.postReceipts.length > MAX_POST_RECEIPTS) {
        state.postReceipts.splice(0, state.postReceipts.length - MAX_POST_RECEIPTS)
      }
      return 'recorded'
    })
  }

  async inspectPost(
    post: { postId: string; authorId: string; text: string; createdAt: string; sourceUrl: string },
  ): Promise<'fresh' | 'duplicate'> {
    const fingerprint = fingerprintPost(post)
    const state = await this.load()
    const existing = state.postReceipts.find(receipt => receipt.postId === post.postId)
    if (!existing) return 'fresh'
    if (existing.fingerprint !== fingerprint) throw new Error('Post replay conflicts with the stored fingerprint.')
    return 'duplicate'
  }

  async commitPostAndScoutSnapshot(
    post: { postId: string; authorId: string; text: string; createdAt: string; sourceUrl: string },
    outcome: PostReceipt['outcome'],
    snapshot: LolahNewsScoutSnapshot,
    processedAt = new Date(),
  ): Promise<'recorded' | 'duplicate'> {
    const fingerprint = fingerprintPost(post)
    if (!snapshot || snapshot.schema !== 'lolah-news-scout-state-v1'
      || !Array.isArray(snapshot.seenPostIds) || !Array.isArray(snapshot.clusters)
      || snapshot.seenPostIds.length > 10_000 || snapshot.clusters.length > 5_000
      || !['accepted', 'ignored'].includes(outcome) || !Number.isFinite(processedAt.getTime())) {
      throw new Error('Scout processing commit is invalid.')
    }
    return this.mutate(state => {
      const existing = state.postReceipts.find(receipt => receipt.postId === post.postId)
      if (existing && existing.fingerprint !== fingerprint) {
        throw new Error('Post replay conflicts with the stored fingerprint.')
      }
      state.scoutSnapshot = structuredClone(snapshot)
      if (existing) return 'duplicate'
      state.postReceipts.push({ postId: post.postId, fingerprint, outcome, processedAt: processedAt.toISOString() })
      if (state.postReceipts.length > MAX_POST_RECEIPTS) {
        state.postReceipts.splice(0, state.postReceipts.length - MAX_POST_RECEIPTS)
      }
      return 'recorded'
    })
  }

  async commitPostScoutAndContextJobs(
    post: { postId: string; authorId: string; text: string; createdAt: string; sourceUrl: string },
    outcome: PostReceipt['outcome'],
    snapshot: LolahNewsScoutSnapshot,
    jobs: Array<{ event: LolahNewsEvent; entityIds: string[]; targetMarket: string }>,
    processedAt = new Date(),
  ): Promise<'recorded' | 'duplicate'> {
    const fingerprint = fingerprintPost(post)
    if (!snapshot || snapshot.schema !== 'lolah-news-scout-state-v1'
      || !Array.isArray(snapshot.seenPostIds) || !Array.isArray(snapshot.clusters)
      || snapshot.seenPostIds.length > 10_000 || snapshot.clusters.length > 5_000
      || !Array.isArray(jobs) || jobs.length > 50
      || !['accepted', 'ignored'].includes(outcome) || !Number.isFinite(processedAt.getTime())) {
      throw new Error('Scout and context-job commit is invalid.')
    }
    for (const job of jobs) {
      if (job.event?.schema !== 'lolah-news-event-v1' || !job.event.eventId.startsWith('evt_')) {
        throw new Error('Context job event is invalid.')
      }
      uniqueIds(job.entityIds, 'Context entityIds')
      cleanId(job.targetMarket, 'Context targetMarket')
    }
    return this.mutate(state => {
      const existingReceipt = state.postReceipts.find(receipt => receipt.postId === post.postId)
      if (existingReceipt && existingReceipt.fingerprint !== fingerprint) {
        throw new Error('Post replay conflicts with the stored fingerprint.')
      }
      state.scoutSnapshot = structuredClone(snapshot)
      for (const input of jobs) {
        const jobId = 'context_' + createHash('sha256')
          .update(input.event.eventId + ':' + input.targetMarket.toLowerCase()).digest('hex').slice(0, 40)
        const timestamp = processedAt.toISOString()
        const revisionHash = eventRevision(input.event)
        const existingJob = state.contextJobs.find(job => job.jobId === jobId)
        if (existingJob) {
          if (existingJob.revisionHash !== revisionHash) {
            existingJob.revisionHash = revisionHash
            existingJob.event = structuredClone(input.event)
            existingJob.entityIds = [...input.entityIds]
            existingJob.targetMarket = input.targetMarket
            existingJob.status = 'pending'
            existingJob.attempts = 0
            existingJob.updatedAt = timestamp
            existingJob.nextAttemptAt = timestamp
            existingJob.leaseUntil = undefined
            existingJob.failureCode = undefined
            existingJob.scan = undefined
          }
          continue
        }
        state.contextJobs.push({
          schema: 'lolah-context-job-v1',
          jobId,
          revisionHash,
          event: structuredClone(input.event),
          entityIds: [...input.entityIds],
          targetMarket: input.targetMarket,
          status: 'pending',
          attempts: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          nextAttemptAt: timestamp,
        })
      }
      if (existingReceipt) return 'duplicate'
      state.postReceipts.push({ postId: post.postId, fingerprint, outcome, processedAt: processedAt.toISOString() })
      if (state.postReceipts.length > MAX_POST_RECEIPTS) {
        state.postReceipts.splice(0, state.postReceipts.length - MAX_POST_RECEIPTS)
      }
      return 'recorded'
    })
  }

  async claimContextJobs(now = new Date(), limit = 20, leaseMs = 60_000): Promise<LolahContextJob[]> {
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs) || !Number.isInteger(limit) || limit < 1 || limit > 100
      || !Number.isInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 10 * 60_000) {
      throw new Error('Context queue claim is invalid.')
    }
    return this.mutate(state => {
      for (const job of state.contextJobs) {
        if (job.status === 'in_progress' && job.leaseUntil && Date.parse(job.leaseUntil) <= nowMs) {
          if (job.attempts >= 5) {
            job.status = 'dead_letter'
            job.failureCode = 'provider_unavailable'
          } else {
            job.status = 'retry_wait'
            job.nextAttemptAt = now.toISOString()
          }
          job.leaseUntil = undefined
          job.updatedAt = now.toISOString()
        }
      }
      const due = state.contextJobs
        .filter(job => (job.status === 'pending' || job.status === 'retry_wait') && Date.parse(job.nextAttemptAt) <= nowMs)
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
        .slice(0, limit)
      for (const job of due) {
        job.status = 'in_progress'
        job.attempts += 1
        job.updatedAt = now.toISOString()
        job.leaseUntil = new Date(nowMs + leaseMs).toISOString()
        job.failureCode = undefined
      }
      return structuredClone(due)
    })
  }

  async completeContextJob(jobId: string, scan: LolahEventScan, now = new Date()): Promise<LolahContextJob> {
    const normalizedJobId = cleanId(jobId, 'jobId')
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      const job = state.contextJobs.find(item => item.jobId === normalizedJobId)
      if (!job || job.status !== 'in_progress' || !job.leaseUntil || Date.parse(job.leaseUntil) < nowMs) {
        throw new Error('Context job lease is unavailable.')
      }
      if (!contextScanMatches(scan, job.event.eventId, job.targetMarket)) {
        throw new Error('Context scan does not match its leased job.')
      }
      job.status = 'completed'
      job.scan = structuredClone(scan)
      job.updatedAt = now.toISOString()
      job.leaseUntil = undefined
      job.failureCode = undefined
      return structuredClone(job)
    })
  }

  async failContextJob(jobId: string, now = new Date()): Promise<LolahContextJob> {
    const normalizedJobId = cleanId(jobId, 'jobId')
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      const job = state.contextJobs.find(item => item.jobId === normalizedJobId)
      if (!job || job.status !== 'in_progress' || !job.leaseUntil || Date.parse(job.leaseUntil) < nowMs) {
        throw new Error('Context job lease is unavailable.')
      }
      job.failureCode = 'provider_unavailable'
      job.updatedAt = now.toISOString()
      job.leaseUntil = undefined
      if (job.attempts >= 5) {
        job.status = 'dead_letter'
      } else {
        job.status = 'retry_wait'
        const backoffMs = Math.min(30 * 60_000, 30_000 * 2 ** (job.attempts - 1))
        job.nextAttemptAt = new Date(nowMs + backoffMs).toISOString()
      }
      return structuredClone(job)
    })
  }

  async listContextJobs(): Promise<LolahContextJob[]> {
    return structuredClone((await this.load()).contextJobs)
  }

  async prepareAlertDrafts(now = new Date()): Promise<LolahAlertDraft[]> {
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      for (const watch of state.watches) {
        if (watch.status === 'active' && Date.parse(watch.expiresAt) <= nowMs) watch.status = 'expired'
      }
      const prepared: LolahAlertDraft[] = []
      for (const job of state.contextJobs) {
        if (job.status !== 'completed' || !job.scan || job.event.verification.status === 'unverified'
          || job.scan.state === 'watch') continue
        const matchingWatches = state.watches.filter(watch => watch.status === 'active'
          && (overlaps(watch.entityIds, job.entityIds)
            || watch.targetMarkets.some(market => market.toLowerCase() === job.targetMarket.toLowerCase())))
        for (const watch of matchingWatches) {
          const draftId = 'draft_' + createHash('sha256')
            .update([watch.watchId, watch.recipientId, job.jobId, job.revisionHash].join(':')).digest('hex').slice(0, 40)
          if (state.alertDrafts.some(draft => draft.draftId === draftId)) continue
          for (const previous of state.alertDrafts) {
            if (previous.status === 'prepared' && previous.watchId === watch.watchId
              && previous.sourceJobId === job.jobId && previous.revisionHash !== job.revisionHash) {
              previous.status = 'superseded'
            }
          }
          const draft: LolahAlertDraft = {
            schema: 'lolah-alert-draft-v1',
            draftId,
            sourceJobId: job.jobId,
            revisionHash: job.revisionHash,
            watchId: watch.watchId,
            recipientId: watch.recipientId,
            eventId: job.event.eventId,
            entityIds: [...job.entityIds],
            targetMarket: job.targetMarket,
            verification: job.event.verification.status,
            alertClass: job.scan.state === 'context_ready' ? 'context_ready' : 'risk_blocked',
            scanState: job.scan.state,
            reason: job.scan.reason.slice(0, 500),
            preparedAt: now.toISOString(),
            status: 'prepared',
            sendAllowed: false,
          }
          state.alertDrafts.push(draft)
          prepared.push(structuredClone(draft))
        }
      }
      return prepared
    })
  }

  async listAlertDrafts(recipientId: string, includeSuperseded = false): Promise<LolahAlertDraft[]> {
    const normalizedRecipientId = cleanId(recipientId, 'recipientId')
    const state = await this.load()
    return structuredClone(state.alertDrafts.filter(draft => draft.recipientId === normalizedRecipientId
      && (includeSuperseded || draft.status === 'prepared')))
  }

  async stageAlertDraftsToOutbox(now = new Date()) {
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      let superseded = 0
      for (const item of state.outbox) {
        const draft = state.alertDrafts.find(candidate => candidate.draftId === item.draftId)
        if (draft?.status === 'superseded'
          && !['acknowledged_simulated', 'superseded'].includes(item.status)) {
          item.status = 'superseded'
          item.updatedAt = now.toISOString()
          item.leaseSessionId = undefined
          item.leaseUntil = undefined
          item.failureCode = undefined
          superseded += 1
        }
      }
      let created = 0
      for (const draft of state.alertDrafts.filter(candidate => candidate.status === 'prepared')) {
        if (state.outbox.some(item => item.draftId === draft.draftId)) continue
        const timestamp = now.toISOString()
        state.outbox.push({
          schema: 'lolah-outbox-item-v1',
          outboxId: 'outbox_' + createHash('sha256').update(draft.draftId).digest('hex').slice(0, 40),
          draftId: draft.draftId,
          recipientId: draft.recipientId,
          status: 'pending',
          attempts: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          nextAttemptAt: timestamp,
          simulationOnly: true,
          sendAllowed: false,
        })
        created += 1
      }
      return { created, superseded }
    })
  }

  async leaseRecipientOutbox(
    recipientId: string,
    sessionId: string,
    now = new Date(),
    limit = 20,
    leaseMs = 60_000,
  ): Promise<Array<{ item: LolahOutboxItem; draft: LolahAlertDraft }>> {
    const normalizedRecipientId = cleanId(recipientId, 'recipientId')
    const normalizedSessionId = cleanId(sessionId, 'sessionId')
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs) || !Number.isInteger(limit) || limit < 1 || limit > 100
      || !Number.isInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 10 * 60_000) {
      throw new Error('Outbox lease request is invalid.')
    }
    return this.mutate(state => {
      for (const item of state.outbox) {
        const draft = state.alertDrafts.find(candidate => candidate.draftId === item.draftId)
        if (draft?.status === 'superseded'
          && !['acknowledged_simulated', 'superseded'].includes(item.status)) {
          item.status = 'superseded'
          item.updatedAt = now.toISOString()
          item.leaseSessionId = undefined
          item.leaseUntil = undefined
          item.failureCode = undefined
        } else if (item.status === 'in_progress' && item.leaseUntil && Date.parse(item.leaseUntil) <= nowMs) {
          item.leaseSessionId = undefined
          item.leaseUntil = undefined
          item.updatedAt = now.toISOString()
          item.failureCode = 'simulation_unacknowledged'
          if (item.attempts >= 5) item.status = 'dead_letter'
          else {
            item.status = 'retry_wait'
            item.nextAttemptAt = now.toISOString()
          }
        }
      }
      const due = state.outbox
        .filter(item => item.recipientId === normalizedRecipientId
          && (item.status === 'pending' || item.status === 'retry_wait')
          && Date.parse(item.nextAttemptAt) <= nowMs)
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
        .slice(0, limit)
      const leased: Array<{ item: LolahOutboxItem; draft: LolahAlertDraft }> = []
      for (const item of due) {
        const draft = state.alertDrafts.find(candidate => candidate.draftId === item.draftId
          && candidate.recipientId === normalizedRecipientId && candidate.status === 'prepared')
        if (!draft) {
          item.status = 'superseded'
          item.updatedAt = now.toISOString()
          continue
        }
        item.status = 'in_progress'
        item.attempts += 1
        item.updatedAt = now.toISOString()
        item.leaseSessionId = normalizedSessionId
        item.leaseUntil = new Date(nowMs + leaseMs).toISOString()
        item.failureCode = undefined
        leased.push({ item: structuredClone(item), draft: structuredClone(draft) })
      }
      return leased
    })
  }

  async acknowledgeSimulatedOutbox(
    outboxId: string,
    recipientId: string,
    sessionId: string,
    now = new Date(),
  ): Promise<LolahOutboxItem> {
    const normalizedOutboxId = cleanId(outboxId, 'outboxId')
    const normalizedRecipientId = cleanId(recipientId, 'recipientId')
    const normalizedSessionId = cleanId(sessionId, 'sessionId')
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      const item = state.outbox.find(candidate => candidate.outboxId === normalizedOutboxId
        && candidate.recipientId === normalizedRecipientId)
      if (!item || item.status !== 'in_progress' || item.leaseSessionId !== normalizedSessionId
        || !item.leaseUntil || Date.parse(item.leaseUntil) < nowMs) {
        throw new Error('Simulated outbox lease is unavailable.')
      }
      item.status = 'acknowledged_simulated'
      item.updatedAt = now.toISOString()
      item.leaseSessionId = undefined
      item.leaseUntil = undefined
      item.failureCode = undefined
      return structuredClone(item)
    })
  }

  async listRecipientOutbox(recipientId: string): Promise<LolahOutboxItem[]> {
    const normalizedRecipientId = cleanId(recipientId, 'recipientId')
    return structuredClone((await this.load()).outbox.filter(item => item.recipientId === normalizedRecipientId))
  }

  async getScoutSnapshot(): Promise<LolahNewsScoutSnapshot | undefined> {
    const state = await this.load()
    return state.scoutSnapshot ? structuredClone(state.scoutSnapshot) : undefined
  }

  async claimPollWindow(sourceKey: string, minimumIntervalMs: number, now = new Date()) {
    const normalizedSourceKey = cleanId(sourceKey, 'sourceKey')
    if (!Number.isInteger(minimumIntervalMs) || minimumIntervalMs < 5_000 || minimumIntervalMs > 60 * 60_000) {
      throw new Error('Polling interval must be 5 seconds through 60 minutes.')
    }
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      const existing = state.pollGates.find(gate => gate.sourceKey === normalizedSourceKey)
      if (existing && Date.parse(existing.nextAllowedAt) > nowMs) {
        return { allowed: false as const, retryAfterMs: Date.parse(existing.nextAllowedAt) - nowMs }
      }
      const nextAllowedAt = new Date(nowMs + minimumIntervalMs).toISOString()
      if (existing) existing.nextAllowedAt = nextAllowedAt
      else state.pollGates.push({ sourceKey: normalizedSourceKey, nextAllowedAt })
      return { allowed: true as const, nextAllowedAt }
    })
  }

  async putCheckpoint(checkpoint: Omit<LolahPollingCheckpoint, 'updatedAt'>, now = new Date()) {
    const normalized: LolahPollingCheckpoint = {
      sourceKey: cleanId(checkpoint.sourceKey, 'sourceKey'),
      newestPostId: /^\d+$/.test(checkpoint.newestPostId) ? checkpoint.newestPostId : (() => { throw new Error('Checkpoint postId is invalid.') })(),
      newestCreatedAt: isoDate(checkpoint.newestCreatedAt, 'Checkpoint newestCreatedAt'),
      updatedAt: Number.isFinite(now.getTime()) ? now.toISOString() : (() => { throw new Error('Checkpoint time is invalid.') })(),
    }
    return this.mutate(state => {
      const index = state.checkpoints.findIndex(item => item.sourceKey === normalized.sourceKey)
      if (index >= 0) {
        const previous = state.checkpoints[index]
        if (Date.parse(normalized.newestCreatedAt) < Date.parse(previous.newestCreatedAt)) {
          throw new Error('Polling checkpoint cannot move backwards.')
        }
        state.checkpoints[index] = normalized
      } else {
        state.checkpoints.push(normalized)
      }
      return normalized
    })
  }

  async getCheckpoint(sourceKey: string) {
    const state = await this.load()
    const checkpoint = state.checkpoints.find(item => item.sourceKey === cleanId(sourceKey, 'sourceKey'))
    return checkpoint ? { ...checkpoint } : undefined
  }

  async prepareDelivery(
    watchId: string,
    recipientId: string,
    candidate: DeliveryCandidate,
    now = new Date(),
  ): Promise<LolahDeliveryEnvelope> {
    const normalizedWatchId = cleanId(watchId, 'watchId')
    const normalizedRecipientId = cleanId(recipientId, 'recipientId')
    const eventId = cleanId(candidate.eventId, 'eventId')
    const entityIds = uniqueIds(candidate.entityIds, 'entityIds')
    const targetMarkets = uniqueIds(candidate.targetMarkets, 'targetMarkets')
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      const watch = state.watches.find(item => item.watchId === normalizedWatchId
        && item.recipientId === normalizedRecipientId)
      if (!watch) throw new Error('Watch is unavailable for this recipient.')
      if (watch.status === 'active' && Date.parse(watch.expiresAt) <= nowMs) watch.status = 'expired'
      if (watch.status !== 'active') throw new Error('Watch is not active.')
      if (!overlaps(watch.entityIds, entityIds) && !overlaps(watch.targetMarkets, targetMarkets)) {
        throw new Error('Event does not match this watch.')
      }
      const deliveryId = 'delivery_' + createHash('sha256')
        .update([watch.watchId, watch.recipientId, eventId].join(':')).digest('hex').slice(0, 40)
      const existing = state.deliveries.find(item => item.deliveryId === deliveryId)
      if (existing) return { ...existing }
      const envelope: LolahDeliveryEnvelope = {
        schema: 'lolah-delivery-envelope-v1',
        deliveryId,
        watchId: watch.watchId,
        recipientId: watch.recipientId,
        eventId,
        preparedAt: now.toISOString(),
        sendAllowed: false,
      }
      state.deliveries.push(envelope)
      return envelope
    })
  }
}
