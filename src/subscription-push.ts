import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const LOLAH_MARKET_WATCH_PLAN = Object.freeze({
  serviceName: 'Lolah Market Watch',
  billingModel: 'subscription' as const,
  freeTrialHours: 72,
  interval: 'month' as const,
  feeUsdt: '1',
})

export type LolahSubscriptionSignal = {
  schema: 'lolah-subscription-signal-v1'
  signalId: string
  source: 'x' | 'upbit'
  occurredAt: string
  expiresAt: string
  message: string
  sourceUrls: string[]
  executionAllowed: false
}

export type LolahActiveSubscriber = {
  jobId: string
  providerAgentId: string
  buyerAgentId: string
  serviceName: string
}

export type LolahSubscriptionDirectory = {
  listActive(providerAgentId: string, serviceName: string): Promise<LolahActiveSubscriber[]>
}

export type LolahSubscriptionMessenger = {
  send(input: { jobId: string; toAgentId: string; message: string }): Promise<{ messageId: string }>
}

type DeliveryRecord = {
  deliveryId: string
  signalId: string
  jobId: string
  buyerAgentId: string
  status: 'retry_wait' | 'sent' | 'dead_letter'
  attempts: number
  updatedAt: string
  messageId?: string
}

type LedgerState = {
  schema: 'lolah-subscription-push-ledger-v1'
  deliveries: DeliveryRecord[]
}

const WRITE_QUEUES = new Map<string, Promise<void>>()

function validId(value: string, label: string) {
  const normalized = String(value).trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(normalized)) throw new Error(label + ' is invalid.')
  return normalized
}

function validDate(value: string, label: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(label + ' is invalid.')
  return new Date(value).toISOString()
}

function deliveryId(signalId: string, jobId: string, buyerAgentId: string) {
  return 'sub_delivery_' + createHash('sha256')
    .update([signalId, jobId, buyerAgentId].join(':')).digest('hex').slice(0, 40)
}

export function validateSubscriptionSignal(signal: LolahSubscriptionSignal): LolahSubscriptionSignal {
  if (signal.schema !== 'lolah-subscription-signal-v1' || signal.executionAllowed !== false) {
    throw new Error('Subscription signal is invalid.')
  }
  validId(signal.signalId, 'signalId')
  if (signal.source !== 'x' && signal.source !== 'upbit') throw new Error('Signal source is invalid.')
  validDate(signal.occurredAt, 'Signal occurredAt')
  validDate(signal.expiresAt, 'Signal expiresAt')
  const message = String(signal.message).trim()
  if (!message || message.length > 2_000) throw new Error('Signal message is invalid.')
  if (!Array.isArray(signal.sourceUrls) || signal.sourceUrls.length < 1 || signal.sourceUrls.length > 5
    || signal.sourceUrls.some(url => {
      try { return new URL(url).protocol !== 'https:' } catch { return true }
    })) throw new Error('Signal source URLs are invalid.')
  return structuredClone({ ...signal, message })
}

export class SubscriptionPushLedger {
  readonly path: string

  constructor(path: string) {
    this.path = resolve(path)
  }

  private async load(): Promise<LedgerState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as LedgerState
      if (parsed.schema !== 'lolah-subscription-push-ledger-v1' || !Array.isArray(parsed.deliveries)) {
        throw new Error('Subscription push ledger is invalid.')
      }
      for (const item of parsed.deliveries) {
        validId(item.deliveryId, 'deliveryId')
        validId(item.signalId, 'signalId')
        validId(item.jobId, 'jobId')
        validId(item.buyerAgentId, 'buyerAgentId')
        if (!['retry_wait', 'sent', 'dead_letter'].includes(item.status) || !Number.isInteger(item.attempts)
          || item.attempts < 1 || !Number.isFinite(Date.parse(item.updatedAt))) {
          throw new Error('Subscription push delivery is invalid.')
        }
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schema: 'lolah-subscription-push-ledger-v1', deliveries: [] }
      }
      throw error
    }
  }

  private async save(state: LedgerState) {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = this.path + '.tmp'
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }

  private async mutate<T>(operation: (state: LedgerState) => T | Promise<T>): Promise<T> {
    const previous = WRITE_QUEUES.get(this.path) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolveQueue => { release = resolveQueue })
    WRITE_QUEUES.set(this.path, previous.then(() => current))
    await previous
    try {
      const state = await this.load()
      const result = await operation(state)
      await this.save(state)
      return result
    } finally {
      release()
    }
  }

  async canAttempt(signalId: string, jobId: string, buyerAgentId: string) {
    const id = deliveryId(signalId, jobId, buyerAgentId)
    const existing = (await this.load()).deliveries.find(item => item.deliveryId === id)
    return !existing || existing.status === 'retry_wait'
  }

  async recordAttempt(input: {
    signalId: string
    jobId: string
    buyerAgentId: string
    now: Date
    messageId?: string
  }) {
    return this.mutate(state => {
      const id = deliveryId(input.signalId, input.jobId, input.buyerAgentId)
      const existing = state.deliveries.find(item => item.deliveryId === id)
      if (existing?.status === 'sent') return structuredClone(existing)
      const record: DeliveryRecord = existing ?? {
        deliveryId: id,
        signalId: input.signalId,
        jobId: input.jobId,
        buyerAgentId: input.buyerAgentId,
        status: 'retry_wait',
        attempts: 0,
        updatedAt: input.now.toISOString(),
      }
      record.attempts += 1
      record.updatedAt = input.now.toISOString()
      if (input.messageId) {
        record.status = 'sent'
        record.messageId = input.messageId
      } else if (record.attempts >= 5) {
        record.status = 'dead_letter'
      }
      if (!existing) state.deliveries.push(record)
      return structuredClone(record)
    })
  }
}

export async function dispatchSubscriptionSignals(input: {
  enabled: boolean
  providerAgentId: string
  signals: LolahSubscriptionSignal[]
  directory: LolahSubscriptionDirectory
  messenger: LolahSubscriptionMessenger
  ledger: SubscriptionPushLedger
  now?: Date
}) {
  const providerAgentId = validId(input.providerAgentId, 'Lolah providerAgentId')
  const now = input.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('Current time is invalid.')
  if (!input.enabled) {
    return { enabled: false, subscribers: 0, attempted: 0, sent: 0, retrying: 0, deadLettered: 0, expired: 0 }
  }
  const subscribers = await input.directory.listActive(providerAgentId, LOLAH_MARKET_WATCH_PLAN.serviceName)
  const unique = new Map<string, LolahActiveSubscriber>()
  for (const subscriber of subscribers) {
    if (validId(subscriber.providerAgentId, 'Subscriber providerAgentId') !== providerAgentId
      || subscriber.serviceName !== LOLAH_MARKET_WATCH_PLAN.serviceName) continue
    const jobId = validId(subscriber.jobId, 'Subscriber jobId')
    const buyerAgentId = validId(subscriber.buyerAgentId, 'Subscriber buyerAgentId')
    unique.set(jobId + ':' + buyerAgentId, { ...subscriber, jobId, buyerAgentId, providerAgentId })
  }
  let attempted = 0
  let sent = 0
  let retrying = 0
  let deadLettered = 0
  let expired = 0
  for (const rawSignal of input.signals) {
    const signal = validateSubscriptionSignal(rawSignal)
    if (Date.parse(signal.expiresAt) <= now.getTime()) {
      expired += 1
      continue
    }
    for (const subscriber of unique.values()) {
      if (!await input.ledger.canAttempt(signal.signalId, subscriber.jobId, subscriber.buyerAgentId)) continue
      attempted += 1
      try {
        const result = await input.messenger.send({
          jobId: subscriber.jobId,
          toAgentId: subscriber.buyerAgentId,
          message: signal.message,
        })
        await input.ledger.recordAttempt({
          signalId: signal.signalId, jobId: subscriber.jobId,
          buyerAgentId: subscriber.buyerAgentId, now, messageId: validId(result.messageId, 'messageId'),
        })
        sent += 1
      } catch {
        const record = await input.ledger.recordAttempt({
          signalId: signal.signalId, jobId: subscriber.jobId,
          buyerAgentId: subscriber.buyerAgentId, now,
        })
        if (record.status === 'dead_letter') deadLettered += 1
        else retrying += 1
      }
    }
  }
  return { enabled: true, subscribers: unique.size, attempted, sent, retrying, deadLettered, expired }
}
