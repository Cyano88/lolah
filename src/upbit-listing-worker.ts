import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  UpbitListingMonitor,
  type UpbitListingEvent,
  type UpbitListingMonitorSnapshot,
  type UpbitPollResult,
} from './upbit-listing-monitor.js'
import type { UpbitListingSource, UpbitListingSourceSnapshot } from './upbit-listing-source.js'
import type { UpbitMarketAssessment } from './upbit-shadow-replay.js'

const STATE_SCHEMA = 'lolah-upbit-worker-state-v3'
const MAX_ALERTS = 10_000
const MAX_SUBSCRIPTIONS = 10_000
const MAX_DELIVERIES = 20_000
const MAX_ENRICHMENT_JOBS = 20_000
const WRITE_QUEUES = new Map<string, Promise<void>>()

export type UpbitListingAlertDraft = {
  schema: 'lolah-upbit-alert-draft-v1'
  draftId: string
  event: UpbitListingEvent
  alertClass: 'early_listing' | 'listing_update'
  status: 'prepared' | 'superseded'
  preparedAt: string
  enrichmentStatus: 'pending' | 'complete'
  assessments: UpbitMarketAssessment[]
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

export type UpbitEnrichmentJob = {
  schema: 'lolah-upbit-enrichment-job-v1'
  jobId: string
  draftId: string
  event: UpbitListingEvent
  symbol: string
  status: 'pending' | 'in_progress' | 'completed'
  attemptCount: number
  nextAttemptAt: string
  leaseUntil?: string
  createdAt: string
  updatedAt: string
}

export type UpbitListingWatch = {
  watchId: string
  recipientId: string
  symbols: string[]
  createdAt: string
  expiresAt: string
  status: 'active' | 'expired' | 'cancelled'
  idempotencyKeyHash?: string
  requestFingerprint?: string
}

export type UpbitListingDelivery = {
  schema: 'lolah-upbit-delivery-v1'
  deliveryId: string
  draftId: string
  watchId: string
  recipientId: string
  status: 'pending' | 'in_progress' | 'acknowledged_simulated' | 'superseded'
  createdAt: string
  updatedAt: string
  leaseSessionId?: string
  leaseUntil?: string
  simulationOnly: true
  sendAllowed: false
}

type WorkerState = {
  schema: typeof STATE_SCHEMA
  monitor?: UpbitListingSourceSnapshot
  alerts: UpbitListingAlertDraft[]
  lateRevisionIds: string[]
  watches: UpbitListingWatch[]
  deliveries: UpbitListingDelivery[]
  enrichmentJobs: UpbitEnrichmentJob[]
}

export type UpbitListingWorkerCycleResult = {
  schema: 'lolah-upbit-worker-cycle-v1'
  polling: UpbitPollResult['status']
  eventsObserved: number
  alertsPrepared: number
  lateEventsSuppressed: number
  nextPollInMs: number
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

export type UpbitEnrichmentCycleResult = {
  schema: 'lolah-upbit-enrichment-cycle-v1'
  claimed: number
  completed: number
  retrying: number
  unavailableFinalized: number
  simulationOnly: true
  sendAllowed: false
  executionAllowed: false
}

function emptyState(): WorkerState {
  return { schema: STATE_SCHEMA, alerts: [], lateRevisionIds: [], watches: [], deliveries: [], enrichmentJobs: [] }
}

function cleanId(value: string, label: string) {
  const result = String(value ?? '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{2,127}$/.test(result)) throw new Error(label + ' is invalid.')
  return result
}

function symbols(value: string[]) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error('Upbit watch symbols must contain 1 through 100 values.')
  }
  const normalized = value.map(item => String(item).trim().toUpperCase())
  if (normalized.some(item => item !== '*' && !/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(item))
    || new Set(normalized).size !== normalized.length
    || (normalized.includes('*') && normalized.length !== 1)) {
    throw new Error('Upbit watch symbols are invalid.')
  }
  return normalized
}

function validEvent(event: UpbitListingEvent) {
  return event?.schema === 'lolah-upbit-listing-v1'
    && /^upbit_\d+$/.test(event.eventId)
    && /^[a-f0-9]{40}$/.test(event.revisionId)
    && event.sourceAuthority === 'upbit_official_website'
    && event.sourceUrl === 'https://www.upbit.com/service_center/notice?id=' + event.noticeId
    && ['new_listing', 'listing_update'].includes(event.status)
    && ['fresh', 'late'].includes(event.freshness)
    && Array.isArray(event.symbols) && event.symbols.length > 0
    && Array.isArray(event.quoteMarkets) && event.quoteMarkets.length > 0
    && Number.isFinite(Date.parse(event.detectedAt))
    && event.executionAllowed === false
}

function validAssessment(value: UpbitMarketAssessment) {
  return value && /^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(value.symbol)
    && value.targetMarket === value.symbol
    && ['context_ready', 'watch', 'no_trade', 'provider_unavailable'].includes(value.state)
    && ['positive_catalyst_watch', 'chasing_risk', 'weakness_watch', 'market_unavailable',
      'risk_blocked', 'context_unavailable'].includes(value.marketPosture)
    && ['adequate', 'thin', 'unknown'].includes(value.liquidityAssessment)
    && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 500
    && value.simulationOnly === true && value.sendAllowed === false && value.executionAllowed === false
    && (!value.scan || (value.scan.eventId.startsWith('evt_upbit_')
      && value.scan.executionAllowed === false))
}

function unavailableAssessment(symbol: string): UpbitMarketAssessment {
  return {
    symbol,
    targetMarket: symbol,
    state: 'provider_unavailable',
    marketPosture: 'context_unavailable',
    liquidityAssessment: 'unknown',
    reason: 'Live context remained unavailable after bounded retries.',
    simulationOnly: true,
    sendAllowed: false,
    executionAllowed: false,
  }
}

function assertState(value: unknown): asserts value is WorkerState {
  if (!value || typeof value !== 'object') throw new Error('Upbit worker state is invalid.')
  const state = value as Partial<WorkerState>
  if (state.schema !== STATE_SCHEMA || !Array.isArray(state.alerts)
    || !Array.isArray(state.lateRevisionIds) || !Array.isArray(state.watches)
    || !Array.isArray(state.deliveries) || !Array.isArray(state.enrichmentJobs)
    || state.alerts.length > MAX_ALERTS
    || state.lateRevisionIds.length > MAX_ALERTS || state.watches.length > MAX_SUBSCRIPTIONS
    || state.deliveries.length > MAX_DELIVERIES || state.enrichmentJobs.length > MAX_ENRICHMENT_JOBS) {
    throw new Error('Upbit worker state is invalid.')
  }
  if (new Set(state.lateRevisionIds).size !== state.lateRevisionIds.length
    || state.lateRevisionIds.some(id => !/^[a-f0-9]{40}$/.test(id))) {
    throw new Error('Upbit worker late revisions are invalid.')
  }
  for (const alert of state.alerts) {
    if (alert.schema !== 'lolah-upbit-alert-draft-v1'
      || !/^upbit_draft_[a-f0-9]{40}$/.test(alert.draftId)
      || !validEvent(alert.event)
      || !['early_listing', 'listing_update'].includes(alert.alertClass)
      || !['prepared', 'superseded'].includes(alert.status)
      || !Number.isFinite(Date.parse(alert.preparedAt))
      || !['pending', 'complete'].includes(alert.enrichmentStatus)
      || !Array.isArray(alert.assessments) || alert.assessments.length > 100
      || alert.assessments.some(item => !validAssessment(item))
      || alert.simulationOnly !== true || alert.sendAllowed !== false
      || alert.executionAllowed !== false) {
      throw new Error('Upbit worker alert draft is invalid.')
    }
  }
  for (const watch of state.watches) {
    if (!/^upbit_watch_[a-f0-9-]{36}$/.test(watch.watchId)
      || !['active', 'expired', 'cancelled'].includes(watch.status)
      || !Number.isFinite(Date.parse(watch.createdAt)) || !Number.isFinite(Date.parse(watch.expiresAt))) {
      throw new Error('Upbit worker watch is invalid.')
    }
    cleanId(watch.recipientId, 'Upbit watch recipientId')
    symbols(watch.symbols)
    if ((watch.idempotencyKeyHash && !/^[a-f0-9]{64}$/.test(watch.idempotencyKeyHash))
      || (watch.requestFingerprint && !/^[a-f0-9]{64}$/.test(watch.requestFingerprint))
      || Boolean(watch.idempotencyKeyHash) !== Boolean(watch.requestFingerprint)) {
      throw new Error('Upbit watch idempotency state is invalid.')
    }
  }
  for (const delivery of state.deliveries) {
    if (delivery.schema !== 'lolah-upbit-delivery-v1'
      || !/^upbit_outbox_[a-f0-9]{40}$/.test(delivery.deliveryId)
      || !/^upbit_draft_[a-f0-9]{40}$/.test(delivery.draftId)
      || !/^upbit_watch_[a-f0-9-]{36}$/.test(delivery.watchId)
      || !['pending', 'in_progress', 'acknowledged_simulated', 'superseded'].includes(delivery.status)
      || !Number.isFinite(Date.parse(delivery.createdAt)) || !Number.isFinite(Date.parse(delivery.updatedAt))
      || delivery.simulationOnly !== true || delivery.sendAllowed !== false) {
      throw new Error('Upbit worker delivery is invalid.')
    }
    cleanId(delivery.recipientId, 'Upbit delivery recipientId')
    if (delivery.leaseUntil && !Number.isFinite(Date.parse(delivery.leaseUntil))) {
      throw new Error('Upbit worker delivery lease is invalid.')
    }
    if (delivery.leaseSessionId) cleanId(delivery.leaseSessionId, 'Upbit delivery leaseSessionId')
    if (delivery.status === 'in_progress' && (!delivery.leaseSessionId || !delivery.leaseUntil)) {
      throw new Error('Upbit worker in-progress delivery requires a lease.')
    }
    if (delivery.status !== 'in_progress' && (delivery.leaseSessionId || delivery.leaseUntil)) {
      throw new Error('Upbit worker inactive delivery must not retain a lease.')
    }
  }
  for (const job of state.enrichmentJobs) {
    if (job.schema !== 'lolah-upbit-enrichment-job-v1'
      || !/^upbit_enrich_[a-f0-9]{40}$/.test(job.jobId)
      || !/^upbit_draft_[a-f0-9]{40}$/.test(job.draftId)
      || !validEvent(job.event) || !job.event.symbols.includes(job.symbol)
      || !['pending', 'in_progress', 'completed'].includes(job.status)
      || !Number.isInteger(job.attemptCount) || job.attemptCount < 0 || job.attemptCount > 5
      || !Number.isFinite(Date.parse(job.nextAttemptAt))
      || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt))) {
      throw new Error('Upbit enrichment job is invalid.')
    }
    if (job.leaseUntil && !Number.isFinite(Date.parse(job.leaseUntil))) {
      throw new Error('Upbit enrichment lease is invalid.')
    }
    if (job.status === 'in_progress' !== Boolean(job.leaseUntil)) {
      throw new Error('Upbit enrichment lease state is invalid.')
    }
  }
  if (state.monitor) {
    if (!['lolah-upbit-monitor-state-v1', 'lolah-upbit-coinlisting-state-v1'].includes(state.monitor.schema)
      || !Array.isArray(state.monitor.revisions) || state.monitor.revisions.length > 5_000) {
      throw new Error('Upbit worker monitor state is invalid.')
    }
  }
}

function draftId(event: UpbitListingEvent) {
  return 'upbit_draft_' + createHash('sha256')
    .update(event.eventId + ':' + event.revisionId)
    .digest('hex')
    .slice(0, 40)
}

function enrichmentJobId(event: UpbitListingEvent, symbol: string) {
  return 'upbit_enrich_' + createHash('sha256')
    .update(event.eventId + ':' + event.revisionId + ':' + symbol)
    .digest('hex')
    .slice(0, 40)
}

export class UpbitListingWorkerStore {
  private readonly filePath: string

  constructor(filePath: string) {
    if (!filePath || !filePath.trim()) throw new Error('Upbit worker state path is required.')
    this.filePath = resolve(filePath)
  }

  private async load() {
    try {
      let state: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (state && typeof state === 'object'
        && ['lolah-upbit-worker-state-v1', 'lolah-upbit-worker-state-v2']
          .includes(String((state as { schema?: string }).schema))) {
        const previous = state as Record<string, unknown>
        const oldAlerts = Array.isArray(previous.alerts) ? previous.alerts : []
        state = {
          ...previous,
          schema: STATE_SCHEMA,
          watches: Array.isArray(previous.watches) ? previous.watches : [],
          deliveries: Array.isArray(previous.deliveries) ? previous.deliveries : [],
          enrichmentJobs: [],
          alerts: oldAlerts.map(alert => ({
            ...(alert as Record<string, unknown>),
            enrichmentStatus: 'complete',
            assessments: [],
          })),
        }
      }
      assertState(state)
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      if (error instanceof SyntaxError) throw new Error('Upbit worker state is invalid JSON.')
      throw error
    }
  }

  private async save(state: WorkerState) {
    assertState(state)
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.' + process.pid + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, this.filePath)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  private async mutate<T>(operation: (state: WorkerState) => T | Promise<T>) {
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

  async getMonitorSnapshot() {
    const state = await this.load()
    return state.monitor ? structuredClone(state.monitor) : undefined
  }

  async createWatch(input: {
    recipientId: string
    symbols: string[]
    expiresAt: Date
  }, now = new Date(), idempotencyKey?: string): Promise<UpbitListingWatch> {
    const recipientId = cleanId(input.recipientId, 'Upbit watch recipientId')
    const watchSymbols = symbols(input.symbols)
    const nowMs = now.getTime()
    const expiryMs = input.expiresAt.getTime()
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs)
      || expiryMs <= nowMs || expiryMs - nowMs > 30 * 24 * 60 * 60_000) {
      throw new Error('Upbit watch expiry must be in the future and no more than 30 days away.')
    }
    let idempotencyKeyHash: string | undefined
    let requestFingerprint: string | undefined
    if (idempotencyKey !== undefined) {
      if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new Error('Upbit idempotency key is invalid.')
      idempotencyKeyHash = createHash('sha256').update(idempotencyKey).digest('hex')
      requestFingerprint = createHash('sha256').update(JSON.stringify([
        recipientId,
        [...watchSymbols].sort(),
        input.expiresAt.toISOString(),
      ])).digest('hex')
    }
    return this.mutate(state => {
      if (idempotencyKeyHash) {
        const existing = state.watches.find(watch => watch.recipientId === recipientId
          && watch.idempotencyKeyHash === idempotencyKeyHash)
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) throw new Error('Upbit watch idempotency conflict.')
          return structuredClone(existing)
        }
      }
      const watch: UpbitListingWatch = {
        watchId: 'upbit_watch_' + randomUUID(),
        recipientId,
        symbols: watchSymbols,
        createdAt: now.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        status: 'active',
        ...(idempotencyKeyHash ? { idempotencyKeyHash, requestFingerprint } : {}),
      }
      state.watches.push(watch)
      return structuredClone(watch)
    })
  }

  async listRecipientWatches(recipientId: string, now = new Date()) {
    const normalizedRecipient = cleanId(recipientId, 'Upbit watch recipientId')
    if (!Number.isFinite(now.getTime())) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      for (const watch of state.watches) {
        if (watch.status === 'active' && Date.parse(watch.expiresAt) <= now.getTime()) watch.status = 'expired'
      }
      return structuredClone(state.watches.filter(watch => watch.recipientId === normalizedRecipient))
    })
  }

  async cancelWatch(watchId: string, recipientId: string) {
    return this.mutate(state => {
      const watch = state.watches.find(candidate => candidate.watchId === watchId
        && candidate.recipientId === cleanId(recipientId, 'Upbit watch recipientId'))
      if (!watch) throw new Error('Upbit watch is unavailable for this recipient.')
      if (watch.status === 'active') watch.status = 'cancelled'
      return structuredClone(watch)
    })
  }

  async commitPoll(snapshot: UpbitListingSourceSnapshot, events: UpbitListingEvent[], now = new Date()) {
    if (!Number.isFinite(now.getTime())
      || !['lolah-upbit-monitor-state-v1', 'lolah-upbit-coinlisting-state-v1'].includes(snapshot.schema)
      || events.some(event => !validEvent(event))) {
      throw new Error('Upbit worker poll commit is invalid.')
    }
    return this.mutate(state => {
      state.monitor = structuredClone(snapshot)
      for (const watch of state.watches) {
        if (watch.status === 'active' && Date.parse(watch.expiresAt) <= now.getTime()) watch.status = 'expired'
      }
      let prepared = 0
      let lateSuppressed = 0
      for (const event of events) {
        if (event.freshness === 'late') {
          if (!state.lateRevisionIds.includes(event.revisionId)) {
            state.lateRevisionIds.push(event.revisionId)
            lateSuppressed += 1
          }
          continue
        }
        const id = draftId(event)
        if (state.alerts.some(alert => alert.draftId === id)) continue
        for (const previous of state.alerts) {
          if (previous.event.eventId === event.eventId && previous.status === 'prepared') {
            previous.status = 'superseded'
            for (const job of state.enrichmentJobs) {
              if (job.draftId === previous.draftId && job.status !== 'completed') {
                job.status = 'completed'
                job.updatedAt = now.toISOString()
                job.leaseUntil = undefined
              }
            }
            for (const delivery of state.deliveries) {
              if (delivery.draftId === previous.draftId
                && !['acknowledged_simulated', 'superseded'].includes(delivery.status)) {
                delivery.status = 'superseded'
                delivery.updatedAt = now.toISOString()
                delivery.leaseSessionId = undefined
                delivery.leaseUntil = undefined
              }
            }
          }
        }
        const alert: UpbitListingAlertDraft = {
          schema: 'lolah-upbit-alert-draft-v1',
          draftId: id,
          event: structuredClone(event),
          alertClass: event.status === 'new_listing' ? 'early_listing' : 'listing_update',
          status: 'prepared',
          preparedAt: now.toISOString(),
          enrichmentStatus: 'pending',
          assessments: [],
          simulationOnly: true,
          sendAllowed: false,
          executionAllowed: false,
        }
        state.alerts.push(alert)
        for (const symbol of event.symbols) {
          const jobId = enrichmentJobId(event, symbol)
          if (state.enrichmentJobs.some(job => job.jobId === jobId)) continue
          state.enrichmentJobs.push({
            schema: 'lolah-upbit-enrichment-job-v1',
            jobId,
            draftId: id,
            event: structuredClone(event),
            symbol,
            status: 'pending',
            attemptCount: 0,
            nextAttemptAt: now.toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          })
        }
        const eventSymbols = new Set(event.symbols)
        const matchingWatches = state.watches.filter(watch => watch.status === 'active'
          && (watch.symbols.includes('*') || watch.symbols.some(symbol => eventSymbols.has(symbol))))
        const deliveredRecipients = new Set<string>()
        for (const watch of matchingWatches) {
          if (deliveredRecipients.has(watch.recipientId)) continue
          deliveredRecipients.add(watch.recipientId)
          const deliveryId = 'upbit_outbox_' + createHash('sha256')
            .update(watch.recipientId + ':' + id).digest('hex').slice(0, 40)
          if (state.deliveries.some(delivery => delivery.deliveryId === deliveryId)) continue
          state.deliveries.push({
            schema: 'lolah-upbit-delivery-v1',
            deliveryId,
            draftId: id,
            watchId: watch.watchId,
            recipientId: watch.recipientId,
            status: 'pending',
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            simulationOnly: true,
            sendAllowed: false,
          })
        }
        prepared += 1
      }
      if (state.alerts.length > MAX_ALERTS) state.alerts.splice(0, state.alerts.length - MAX_ALERTS)
      if (state.lateRevisionIds.length > MAX_ALERTS) {
        state.lateRevisionIds.splice(0, state.lateRevisionIds.length - MAX_ALERTS)
      }
      if (state.deliveries.length > MAX_DELIVERIES) {
        state.deliveries.splice(0, state.deliveries.length - MAX_DELIVERIES)
      }
      if (state.enrichmentJobs.length > MAX_ENRICHMENT_JOBS) {
        const removable = state.enrichmentJobs.filter(job => job.status === 'completed')
        const remove = Math.min(removable.length, state.enrichmentJobs.length - MAX_ENRICHMENT_JOBS)
        const ids = new Set(removable.slice(0, remove).map(job => job.jobId))
        state.enrichmentJobs = state.enrichmentJobs.filter(job => !ids.has(job.jobId))
      }
      return { prepared, lateSuppressed }
    })
  }

  async listPreparedAlerts() {
    return structuredClone((await this.load()).alerts.filter(alert => alert.status === 'prepared'))
  }

  async claimEnrichmentJobs(now = new Date(), limit = 5, leaseMs = 30_000) {
    if (!Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 20
      || !Number.isInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 5 * 60_000) {
      throw new Error('Upbit enrichment claim is invalid.')
    }
    return this.mutate(state => {
      for (const job of state.enrichmentJobs) {
        if (job.status === 'in_progress' && job.leaseUntil && Date.parse(job.leaseUntil) <= now.getTime()) {
          job.updatedAt = now.toISOString()
          job.leaseUntil = undefined
          if (job.attemptCount >= 5) {
            job.status = 'completed'
            const alert = state.alerts.find(item => item.draftId === job.draftId && item.status === 'prepared')
            if (alert && !alert.assessments.some(item => item.symbol === job.symbol)) {
              alert.assessments.push(unavailableAssessment(job.symbol))
            }
          } else {
            job.status = 'pending'
            job.nextAttemptAt = now.toISOString()
          }
        }
      }
      for (const alert of state.alerts.filter(item => item.status === 'prepared'
        && item.enrichmentStatus === 'pending')) {
        const related = state.enrichmentJobs.filter(item => item.draftId === alert.draftId)
        if (related.length === alert.event.symbols.length && related.every(item => item.status === 'completed')) {
          alert.enrichmentStatus = 'complete'
        }
      }
      const due = state.enrichmentJobs.filter(job => job.status === 'pending'
        && Date.parse(job.nextAttemptAt) <= now.getTime()
        && state.alerts.some(alert => alert.draftId === job.draftId
          && alert.status === 'prepared' && alert.enrichmentStatus === 'pending'))
        .slice(0, limit)
      for (const job of due) {
        job.status = 'in_progress'
        job.attemptCount += 1
        job.updatedAt = now.toISOString()
        job.leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
      }
      return structuredClone(due)
    })
  }

  async completeEnrichmentJob(
    jobId: string,
    assessment: UpbitMarketAssessment,
    now = new Date(),
  ) {
    if (!validAssessment(assessment) || !Number.isFinite(now.getTime())) {
      throw new Error('Upbit enrichment completion is invalid.')
    }
    return this.mutate(state => {
      const job = state.enrichmentJobs.find(item => item.jobId === jobId)
      if (!job || job.status !== 'in_progress' || !job.leaseUntil
        || Date.parse(job.leaseUntil) < now.getTime()
        || assessment.symbol !== job.symbol || assessment.targetMarket !== job.symbol
        || (assessment.scan && assessment.scan.eventId !== 'evt_upbit_' + job.event.noticeId + '_' + job.symbol.toLowerCase())) {
        throw new Error('Upbit enrichment job is unavailable.')
      }
      const alert = state.alerts.find(item => item.draftId === job.draftId && item.status === 'prepared')
      if (!alert) throw new Error('Upbit enrichment alert is unavailable.')
      if (!alert.assessments.some(item => item.symbol === assessment.symbol)) {
        alert.assessments.push(structuredClone(assessment))
      }
      job.status = 'completed'
      job.updatedAt = now.toISOString()
      job.leaseUntil = undefined
      const related = state.enrichmentJobs.filter(item => item.draftId === alert.draftId)
      if (related.length === alert.event.symbols.length && related.every(item => item.status === 'completed')) {
        alert.enrichmentStatus = 'complete'
      }
      return structuredClone(alert)
    })
  }

  async failEnrichmentJob(jobId: string, now = new Date()) {
    if (!Number.isFinite(now.getTime())) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      const job = state.enrichmentJobs.find(item => item.jobId === jobId)
      if (!job || job.status !== 'in_progress') throw new Error('Upbit enrichment job is unavailable.')
      const alert = state.alerts.find(item => item.draftId === job.draftId && item.status === 'prepared')
      if (!alert) throw new Error('Upbit enrichment alert is unavailable.')
      job.updatedAt = now.toISOString()
      job.leaseUntil = undefined
      if (job.attemptCount >= 5) {
        const unavailable = unavailableAssessment(job.symbol)
        if (!alert.assessments.some(item => item.symbol === job.symbol)) alert.assessments.push(unavailable)
        job.status = 'completed'
        const related = state.enrichmentJobs.filter(item => item.draftId === alert.draftId)
        if (related.length === alert.event.symbols.length && related.every(item => item.status === 'completed')) {
          alert.enrichmentStatus = 'complete'
        }
        return 'unavailable_finalized' as const
      }
      job.status = 'pending'
      job.nextAttemptAt = new Date(now.getTime() + upbitEnrichmentRetryDelayMs(job.attemptCount)).toISOString()
      return 'retrying' as const
    })
  }

  async leaseRecipientAlerts(recipientId: string, sessionId: string, now = new Date(), limit = 20, leaseMs = 60_000) {
    const recipient = cleanId(recipientId, 'Upbit delivery recipientId')
    const session = cleanId(sessionId, 'Upbit delivery sessionId')
    if (!Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 100
      || !Number.isInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 10 * 60_000) {
      throw new Error('Upbit alert lease request is invalid.')
    }
    return this.mutate(state => {
      for (const delivery of state.deliveries) {
        if (delivery.status === 'in_progress' && delivery.leaseUntil
          && Date.parse(delivery.leaseUntil) <= now.getTime()) {
          delivery.status = 'pending'
          delivery.updatedAt = now.toISOString()
          delivery.leaseSessionId = undefined
          delivery.leaseUntil = undefined
        }
      }
      const due = state.deliveries.filter(delivery => delivery.recipientId === recipient
        && delivery.status === 'pending'
        && state.alerts.some(alert => alert.draftId === delivery.draftId
          && alert.status === 'prepared' && alert.enrichmentStatus === 'complete'))
        .slice(0, limit)
      return due.map(delivery => {
        const alert = state.alerts.find(candidate => candidate.draftId === delivery.draftId
          && candidate.status === 'prepared' && candidate.enrichmentStatus === 'complete')
        if (!alert) {
          delivery.status = 'superseded'
          delivery.updatedAt = now.toISOString()
          return undefined
        }
        delivery.status = 'in_progress'
        delivery.updatedAt = now.toISOString()
        delivery.leaseSessionId = session
        delivery.leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
        return { delivery: structuredClone(delivery), alert: structuredClone(alert) }
      }).filter((value): value is { delivery: UpbitListingDelivery; alert: UpbitListingAlertDraft } => Boolean(value))
    })
  }

  async acknowledgeRecipientAlert(deliveryId: string, recipientId: string, sessionId: string, now = new Date()) {
    const recipient = cleanId(recipientId, 'Upbit delivery recipientId')
    const session = cleanId(sessionId, 'Upbit delivery sessionId')
    if (!Number.isFinite(now.getTime())) throw new Error('Current time is invalid.')
    return this.mutate(state => {
      const delivery = state.deliveries.find(candidate => candidate.deliveryId === deliveryId
        && candidate.recipientId === recipient)
      if (!delivery || delivery.status !== 'in_progress' || delivery.leaseSessionId !== session
        || !delivery.leaseUntil || Date.parse(delivery.leaseUntil) < now.getTime()) {
        throw new Error('Upbit alert acknowledgement is unavailable.')
      }
      delivery.status = 'acknowledged_simulated'
      delivery.updatedAt = now.toISOString()
      delivery.leaseSessionId = undefined
      delivery.leaseUntil = undefined
      return structuredClone(delivery)
    })
  }
}

export async function runUpbitListingWorkerCycle(input: {
  store: UpbitListingWorkerStore
  fetcher?: typeof fetch
  now?: () => Date
  actionableLatencyMs?: number
  source?: UpbitListingSource
  sourceFactory?: (snapshot?: UpbitListingSourceSnapshot) => UpbitListingSource
}): Promise<UpbitListingWorkerCycleResult> {
  const now = input.now ?? (() => new Date())
  const detectedAt = now()
  const snapshot = await input.store.getMonitorSnapshot()
  const monitor = input.source ?? (input.sourceFactory
    ? input.sourceFactory(snapshot)
    : new UpbitListingMonitor(input.fetcher ?? fetch, snapshot as UpbitListingMonitorSnapshot | undefined, input.actionableLatencyMs))
  const result = await monitor.poll(detectedAt)
  const commit = await input.store.commitPoll(monitor.snapshot(), result.events, now())
  return {
    schema: 'lolah-upbit-worker-cycle-v1',
    polling: result.status,
    eventsObserved: result.events.length,
    alertsPrepared: commit.prepared,
    lateEventsSuppressed: commit.lateSuppressed,
    nextPollInMs: result.nextPollInMs,
    simulationOnly: true,
    sendAllowed: false,
    executionAllowed: false,
  }
}

export async function runContinuousUpbitListingWorker(input: {
  store: UpbitListingWorkerStore
  fetcher?: typeof fetch
  signal: AbortSignal
  onCycle?: (result: UpbitListingWorkerCycleResult) => void
  onError?: (failure: { consecutiveFailures: number; retryAfterMs: number; category: 'upstream_unavailable' }) => void
  source?: UpbitListingSource
  sourceFactory?: (snapshot?: UpbitListingSourceSnapshot) => UpbitListingSource
}) {
  let consecutiveFailures = 0
  while (!input.signal.aborted) {
    const started = Date.now()
    let nextPollInMs: number
    try {
      const result = await runUpbitListingWorkerCycle(input)
      consecutiveFailures = 0
      input.onCycle?.(result)
      nextPollInMs = result.nextPollInMs
    } catch {
      consecutiveFailures += 1
      nextPollInMs = upbitRetryDelayMs(consecutiveFailures)
      input.onError?.({ consecutiveFailures, retryAfterMs: nextPollInMs, category: 'upstream_unavailable' })
    }
    const remaining = Math.max(0, nextPollInMs - (Date.now() - started))
    if (remaining > 0) {
      await new Promise<void>(resolveWait => {
        const timer = setTimeout(resolveWait, remaining)
        input.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolveWait()
        }, { once: true })
      })
    }
  }
}

export async function runUpbitEnrichmentCycle(input: {
  store: UpbitListingWorkerStore
  enrich: (event: UpbitListingEvent, symbol: string) => Promise<UpbitMarketAssessment>
  now?: () => Date
  limit?: number
}): Promise<UpbitEnrichmentCycleResult> {
  const now = input.now ?? (() => new Date())
  const jobs = await input.store.claimEnrichmentJobs(now(), input.limit ?? 5)
  let completed = 0
  let retrying = 0
  let unavailableFinalized = 0
  for (const job of jobs) {
    try {
      const result = await input.enrich(job.event, job.symbol)
      await input.store.completeEnrichmentJob(job.jobId, result, now())
      completed += 1
    } catch {
      const outcome = await input.store.failEnrichmentJob(job.jobId, now())
      if (outcome === 'retrying') retrying += 1
      else unavailableFinalized += 1
    }
  }
  return {
    schema: 'lolah-upbit-enrichment-cycle-v1',
    claimed: jobs.length,
    completed,
    retrying,
    unavailableFinalized,
    simulationOnly: true,
    sendAllowed: false,
    executionAllowed: false,
  }
}

export async function runContinuousUpbitEnrichmentWorker(input: {
  store: UpbitListingWorkerStore
  enrich: (event: UpbitListingEvent, symbol: string) => Promise<UpbitMarketAssessment>
  signal: AbortSignal
  intervalMs?: number
  onCycle?: (result: UpbitEnrichmentCycleResult) => void
  onError?: (failure: { category: 'enrichment_store_unavailable'; retryAfterMs: number }) => void
}) {
  const intervalMs = input.intervalMs ?? 1_000
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
    throw new Error('Upbit enrichment interval is invalid.')
  }
  while (!input.signal.aborted) {
    try {
      const result = await runUpbitEnrichmentCycle(input)
      if (result.claimed > 0) input.onCycle?.(result)
    } catch {
      input.onError?.({ category: 'enrichment_store_unavailable', retryAfterMs: intervalMs })
    }
    await new Promise<void>(resolveWait => {
      const aborted = () => {
        clearTimeout(timer)
        resolveWait()
      }
      const timer = setTimeout(() => {
        input.signal.removeEventListener('abort', aborted)
        resolveWait()
      }, intervalMs)
      input.signal.addEventListener('abort', aborted, { once: true })
    })
  }
}

export function upbitRetryDelayMs(consecutiveFailures: number) {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 1) throw new Error('Upbit failure count is invalid.')
  return Math.min(5 * 60_000, 1_000 * (2 ** Math.min(18, consecutiveFailures - 1)))
}

export function upbitEnrichmentRetryDelayMs(attemptCount: number) {
  if (!Number.isInteger(attemptCount) || attemptCount < 1 || attemptCount > 5) {
    throw new Error('Upbit enrichment attempt count is invalid.')
  }
  return Math.min(60_000, 1_000 * (2 ** (attemptCount - 1)))
}
