import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  dispatchSubscriptionSignals,
  LOLAH_MARKET_WATCH_PLAN,
  SubscriptionPushLedger,
  type LolahSubscriptionSignal,
} from '../src/subscription-push.js'

const signal: LolahSubscriptionSignal = {
  schema: 'lolah-subscription-signal-v1',
  signalId: 'signal_upbit_123',
  source: 'upbit',
  occurredAt: '2026-08-10T12:00:00.000Z',
  expiresAt: '2026-08-10T12:15:00.000Z',
  message: 'Upbit officially announced ABC. Context only; review current market conditions before acting.',
  sourceUrls: ['https://upbit.com/service_center/notice?id=123'],
  executionAllowed: false,
}

async function ledger() {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-subscription-'))
  return new SubscriptionPushLedger(join(directory, 'ledger.json'))
}

function subscribers() {
  return [{
    jobId: 'job_123', providerAgentId: '9001', buyerAgentId: '7001',
    serviceName: LOLAH_MARKET_WATCH_PLAN.serviceName,
  }]
}

test('locks Market Watch to a 72-hour trial and 1 USDT monthly plan', () => {
  assert.deepEqual(LOLAH_MARKET_WATCH_PLAN, {
    serviceId: '17abe635-66b5-45c7-bfa2-8c7b546474e1',
    serviceName: 'Lolah Market Watch', billingModel: 'subscription',
    freeTrialHours: 72, interval: 'month', feeUsdt: '1',
  })
})

test('disabled push never queries subscribers or sends', async () => {
  let queried = false
  let sent = false
  const result = await dispatchSubscriptionSignals({
    enabled: false, providerAgentId: '9001', signals: [signal], ledger: await ledger(),
    directory: { async listActive() { queried = true; return subscribers() } },
    messenger: { async send() { sent = true; return { messageId: 'message_1' } } },
    now: new Date('2026-08-10T12:01:00Z'),
  })
  assert.equal(result.enabled, false)
  assert.equal(queried, false)
  assert.equal(sent, false)
})

test('sends only to subscribers for the exact Lolah provider and service', async () => {
  const recipients: string[] = []
  const result = await dispatchSubscriptionSignals({
    enabled: true, providerAgentId: '9001', signals: [signal], ledger: await ledger(),
    directory: { async listActive() {
      return [...subscribers(),
        { jobId: 'job_wrong_provider', providerAgentId: '5427', buyerAgentId: '7002', serviceName: 'Lolah Market Watch' },
        { jobId: 'job_wrong_service', providerAgentId: '9001', buyerAgentId: '7003', serviceName: 'Other Service' }]
    } },
    messenger: { async send(input) { recipients.push(input.toAgentId); return { messageId: 'message_1' } } },
    now: new Date('2026-08-10T12:01:00Z'),
  })
  assert.deepEqual(recipients, ['7001'])
  assert.equal(result.sent, 1)
})

test('deduplicates a successful delivery across ledger reloads', async () => {
  const durable = await ledger()
  let sends = 0
  const input = {
    enabled: true, providerAgentId: '9001', signals: [signal], ledger: durable,
    directory: { async listActive() { return subscribers() } },
    messenger: { async send() { sends += 1; return { messageId: 'message_1' } } },
    now: new Date('2026-08-10T12:01:00Z'),
  }
  await dispatchSubscriptionSignals(input)
  const reloaded = new SubscriptionPushLedger(durable.path)
  await dispatchSubscriptionSignals({ ...input, ledger: reloaded })
  assert.equal(sends, 1)
  const state = JSON.parse(await readFile(durable.path, 'utf8')) as { deliveries: unknown[] }
  assert.equal(state.deliveries.length, 1)
})

test('suppresses expired signals and retries transient send failures', async () => {
  const durable = await ledger()
  let sends = 0
  const messenger = { async send() {
    sends += 1
    if (sends === 1) throw new Error('temporary transport failure')
    return { messageId: 'message_2' }
  } }
  const base = {
    enabled: true, providerAgentId: '9001', directory: { async listActive() { return subscribers() } },
    messenger, ledger: durable,
  }
  const first = await dispatchSubscriptionSignals({ ...base, signals: [signal], now: new Date('2026-08-10T12:01:00Z') })
  const second = await dispatchSubscriptionSignals({ ...base, signals: [signal], now: new Date('2026-08-10T12:02:00Z') })
  const expired = await dispatchSubscriptionSignals({ ...base, signals: [signal], now: new Date('2026-08-10T12:16:00Z') })
  assert.equal(first.retrying, 1)
  assert.equal(second.sent, 1)
  assert.equal(expired.expired, 1)
  assert.equal(sends, 2)
})

test('dead-letters a repeatedly failing delivery after five attempts', async () => {
  const durable = await ledger()
  let sends = 0
  const input = {
    enabled: true, providerAgentId: '9001', signals: [signal],
    directory: { async listActive() { return subscribers() } },
    messenger: { async send() { sends += 1; throw new Error('ineligible or unavailable') } },
    ledger: durable,
  }
  for (let minute = 1; minute <= 6; minute += 1) {
    await dispatchSubscriptionSignals({
      ...input, now: new Date(`2026-08-10T12:0${minute}:00Z`),
    })
  }
  assert.equal(sends, 5)
  const state = JSON.parse(await readFile(durable.path, 'utf8')) as {
    deliveries: Array<{ status: string; attempts: number }>
  }
  assert.deepEqual(state.deliveries.map(item => ({ status: item.status, attempts: item.attempts })), [
    { status: 'dead_letter', attempts: 5 },
  ])
})
