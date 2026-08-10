import { dirname, resolve } from 'node:path'
import { LolahDurableStateStore } from '../src/durable-state.js'
import {
  OfficialOkxSubscriptionDirectory,
  OfficialOkxSubscriptionMessenger,
} from '../src/official-okx-subscription.js'
import { collectSubscriptionSignals } from '../src/subscription-signal-source.js'
import { dispatchSubscriptionSignals, SubscriptionPushLedger } from '../src/subscription-push.js'
import { UpbitListingWorkerStore } from '../src/upbit-listing-worker.js'

function required(name: string) {
  const value = String(process.env[name] ?? '').trim()
  if (!value) throw new Error(name + ' is required.')
  return value
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolveWait => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolveWait()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

if (String(process.env.LOLAH_SUBSCRIPTION_PUSH_ENABLED ?? '').trim() !== 'true') {
  throw new Error('LOLAH_SUBSCRIPTION_PUSH_ENABLED must be true to start the dispatcher.')
}
const providerAgentId = required('LOLAH_OKX_ASP_AGENT_ID')
const xStatePath = resolve(required('LOLAH_X_STATE_PATH'))
const upbitStatePath = resolve(required('LOLAH_UPBIT_STATE_PATH'))
if (xStatePath === upbitStatePath) throw new Error('X and Upbit state paths must be separate.')
const ledgerPath = resolve(String(process.env.LOLAH_SUBSCRIPTION_LEDGER_PATH ?? '').trim()
  || resolve(dirname(xStatePath), 'subscription-push-ledger.json'))
const intervalMs = Number(String(process.env.LOLAH_SUBSCRIPTION_PUSH_INTERVAL_MS ?? '5000').trim())
if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) {
  throw new Error('LOLAH_SUBSCRIPTION_PUSH_INTERVAL_MS is invalid.')
}

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
const xStore = new LolahDurableStateStore(xStatePath)
const upbitStore = new UpbitListingWorkerStore(upbitStatePath)
const ledger = new SubscriptionPushLedger(ledgerPath)
const directory = new OfficialOkxSubscriptionDirectory()
const messenger = new OfficialOkxSubscriptionMessenger()

console.log(JSON.stringify({
  component: 'subscription_dispatcher', state: 'enabled',
  providerAgentId, service: 'Lolah Market Watch',
  executionAllowed: false,
}))
while (!controller.signal.aborted) {
  try {
    const signals = await collectSubscriptionSignals({ xStore, upbitStore })
    const result = await dispatchSubscriptionSignals({
      enabled: true, providerAgentId, signals, directory, messenger, ledger,
    })
    if (result.attempted || result.expired) {
      console.log(JSON.stringify({ component: 'subscription_dispatcher', ...result }))
    }
  } catch {
    console.error(JSON.stringify({ component: 'subscription_dispatcher', state: 'retrying' }))
  }
  await wait(intervalMs, controller.signal)
}
