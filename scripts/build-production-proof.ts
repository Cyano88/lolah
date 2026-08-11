import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function main() {
const appRoot = resolve(String(process.env.LOLAH_APP_ROOT ?? process.cwd()))
const relay = await import(pathToFileURL(resolve(appRoot, 'src/subscription-signal-relay.ts')).href)
const proof = await import(pathToFileURL(resolve(appRoot, 'src/xlayer-signal-proof.ts')).href)

const token = String(process.env.LOLAH_SUBSCRIPTION_FEED_TOKEN ?? '').trim()
const ledgerPath = String(process.env.LOLAH_SUBSCRIPTION_LEDGER_PATH
  ?? '/var/lib/lolah-a2a/subscription-push-ledger.json').trim()
const sourceUrl = String(process.env.LOLAH_PROOF_SOURCE_URL ?? '').trim()
const release = String(process.env.LOLAH_PROOF_RELEASE ?? '').trim()
if (!sourceUrl.startsWith('https://') || !release) {
  throw new Error('Proof source URL and release are required.')
}
const signals = await relay.fetchRelayedSubscriptionSignals({
  url: relay.LOLAH_SUBSCRIPTION_FEED_URL,
  token,
})
const signal = signals.find(item => item.sourceUrls.includes(sourceUrl))
if (!signal) throw new Error('Requested production signal is unavailable.')
const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
  schema?: unknown
  deliveries?: Array<{
    signalId?: unknown
    deliveryId?: unknown
    messageId?: unknown
    updatedAt?: unknown
    status?: unknown
  }>
}
if (ledger.schema !== 'lolah-subscription-push-ledger-v1' || !Array.isArray(ledger.deliveries)) {
  throw new Error('Production delivery ledger is invalid.')
}
const deliveries = ledger.deliveries.filter(item => item.status === 'sent'
  && item.signalId === signal.signalId
  && typeof item.deliveryId === 'string'
  && typeof item.messageId === 'string'
  && typeof item.updatedAt === 'string').map(item => ({
    signalId: signal.signalId,
    deliveryId: String(item.deliveryId),
    messageId: String(item.messageId),
    deliveredAt: new Date(String(item.updatedAt)).toISOString(),
  }))
if (!deliveries.length) throw new Error('No completed production delivery matches the signal.')
const signalProof = proof.createSignalProofBatch([signal], release)
const deliveryProof = proof.createDeliveryProofRoot(deliveries)
console.log(JSON.stringify({
  ok: true,
  schema: 'lolah-production-proof-evidence-v1',
  source: signal.source,
  sourceUrl,
  signalId: signal.signalId,
  occurredAt: signal.occurredAt,
  expiresAt: signal.expiresAt,
  signalProof,
  deliveryProof,
  executionAllowed: false,
}))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Production proof generation failed.')
  process.exitCode = 1
})
