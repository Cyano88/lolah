import { createHash } from 'node:crypto'
import type { LolahSubscriptionSignal } from './subscription-push.js'

export type LolahSignalProofBatch = {
  schema: 'lolah-xlayer-signal-proof-batch-v1'
  root: `0x${string}`
  releaseHash: `0x${string}`
  windowStart: number
  windowEnd: number
  signalCount: number
  leaves: Array<{ signalId: string; leaf: `0x${string}` }>
  privacy: 'no_recipient_or_message_content'
}

function hash(value: string | Buffer): `0x${string}` {
  return ('0x' + createHash('sha256').update(value).digest('hex')) as `0x${string}`
}

function validRelease(value: string) {
  const normalized = value.trim()
  if (!/^[a-f0-9]{7,64}$/i.test(normalized)) throw new Error('Release identifier is invalid.')
  return normalized.toLowerCase()
}

function root(leaves: Array<`0x${string}`>): `0x${string}` {
  if (!leaves.length) throw new Error('Proof batch requires at least one signal.')
  let level = [...leaves].sort()
  while (level.length > 1) {
    const next: Array<`0x${string}`> = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]
      const right = level[index + 1] ?? left
      next.push(hash(Buffer.from([left, right].sort().join('').slice(2), 'hex')))
    }
    level = next.sort()
  }
  return level[0]
}

export function createSignalProofBatch(
  signals: LolahSubscriptionSignal[],
  release: string,
): LolahSignalProofBatch {
  const normalizedRelease = validRelease(release)
  const unique = new Map(signals.map(signal => [signal.signalId, signal]))
  if (!unique.size || unique.size > 10_000) throw new Error('Proof batch signal count is invalid.')
  const leaves = [...unique.values()].map(signal => ({
    signalId: signal.signalId,
    leaf: hash(JSON.stringify({
      schema: signal.schema,
      signalId: signal.signalId,
      source: signal.source,
      occurredAt: signal.occurredAt,
      expiresAt: signal.expiresAt,
      sourceHashes: [...new Set(signal.sourceUrls)].sort().map(hash),
      messageHash: hash(signal.message),
      executionAllowed: false,
    })),
  })).sort((left, right) => left.signalId.localeCompare(right.signalId))
  const times = [...unique.values()].map(signal => Date.parse(signal.occurredAt))
  if (times.some(value => !Number.isFinite(value))) throw new Error('Proof batch contains an invalid time.')
  return {
    schema: 'lolah-xlayer-signal-proof-batch-v1',
    root: root(leaves.map(item => item.leaf)),
    releaseHash: hash(normalizedRelease),
    windowStart: Math.floor(Math.min(...times) / 1_000),
    windowEnd: Math.floor(Math.max(...times) / 1_000),
    signalCount: leaves.length,
    leaves,
    privacy: 'no_recipient_or_message_content',
  }
}

export function createDeliveryProofRoot(input: Array<{
  signalId: string
  deliveryId: string
  messageId: string
  deliveredAt: string
}>) {
  if (!input.length || input.length > 100_000) throw new Error('Delivery proof count is invalid.')
  const leaves = input.map(item => hash(JSON.stringify({
    signalId: item.signalId,
    deliveryId: item.deliveryId,
    messageIdHash: hash(item.messageId),
    deliveredAt: new Date(item.deliveredAt).toISOString(),
  })))
  return { root: root(leaves), deliveryCount: leaves.length }
}
