import { createHash, createPublicKey, verify } from 'node:crypto'
import type { UpbitListingEvent, UpbitPollResult } from './upbit-listing-monitor.js'
import type { UpbitSignedRelaySnapshot } from './upbit-listing-source.js'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validEvent(event: unknown): event is UpbitListingEvent {
  if (!isRecord(event)) return false
  return event.schema === 'lolah-upbit-listing-v1'
    && typeof event.noticeId === 'number' && Number.isInteger(event.noticeId) && event.noticeId > 0
    && event.eventId === 'upbit_' + event.noticeId
    && typeof event.revisionId === 'string' && /^[a-f0-9]{40}$/.test(event.revisionId)
    && event.sourceAuthority === 'upbit_official_website'
    && event.sourceUrl === 'https://www.upbit.com/service_center/notice?id=' + event.noticeId
    && (event.status === 'new_listing' || event.status === 'listing_update')
    && typeof event.firstPublishedAt === 'string' && Number.isFinite(Date.parse(event.firstPublishedAt))
    && typeof event.revisedAt === 'string' && Number.isFinite(Date.parse(event.revisedAt))
    && Array.isArray(event.symbols) && event.symbols.length > 0
    && event.symbols.every(symbol => typeof symbol === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(symbol))
    && Array.isArray(event.quoteMarkets) && event.quoteMarkets.length > 0
    && event.quoteMarkets.every(market => typeof market === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(market))
    && event.executionAllowed === false
}

function validateSnapshot(snapshot?: UpbitSignedRelaySnapshot) {
  if (!snapshot) return
  if (snapshot.schema !== 'lolah-upbit-relay-state-v1'
    || !Array.isArray(snapshot.revisions) || snapshot.revisions.length > 5_000
    || (snapshot.lastSequence !== undefined && (!Number.isSafeInteger(snapshot.lastSequence) || snapshot.lastSequence < 1))
    || (snapshot.lastDigest !== undefined && !/^[a-f0-9]{64}$/.test(snapshot.lastDigest))
    || Boolean(snapshot.lastSequence) !== Boolean(snapshot.lastDigest)
    || snapshot.revisions.some(item => !Number.isInteger(item.noticeId) || item.noticeId < 1
      || !/^[a-f0-9]{40}$/.test(item.revisionId))) {
    throw new Error('Upbit relay snapshot is invalid.')
  }
}

export class UpbitSignedRelay {
  private lastSequence?: number
  private lastDigest?: string
  private etag?: string
  private readonly revisions = new Map<number, string>()
  private readonly publicKey: ReturnType<typeof createPublicKey>

  constructor(
    private readonly relayUrl: string,
    publicKeySpkiBase64: string,
    private readonly fetcher: typeof fetch = fetch,
    snapshot?: UpbitSignedRelaySnapshot,
    private readonly actionableLatencyMs = 15_000,
  ) {
    const url = new URL(relayUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Upbit relay URL must be HTTPS.')
    if (!/^[A-Za-z0-9+/=]{40,2000}$/.test(publicKeySpkiBase64)) throw new Error('Upbit relay public key is invalid.')
    this.publicKey = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
    if (this.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Upbit relay public key must use Ed25519.')
    if (!Number.isInteger(actionableLatencyMs) || actionableLatencyMs < 1_000 || actionableLatencyMs > 5 * 60_000) {
      throw new Error('Upbit actionable latency must be 1 second through 5 minutes.')
    }
    validateSnapshot(snapshot)
    if (snapshot) {
      this.lastSequence = snapshot.lastSequence
      this.lastDigest = snapshot.lastDigest
      for (const item of snapshot.revisions) this.revisions.set(item.noticeId, item.revisionId)
    }
  }

  snapshot(): UpbitSignedRelaySnapshot {
    return {
      schema: 'lolah-upbit-relay-state-v1',
      ...(this.lastSequence ? { lastSequence: this.lastSequence, lastDigest: this.lastDigest } : {}),
      revisions: [...this.revisions].map(([noticeId, revisionId]) => ({ noticeId, revisionId })),
    }
  }

  async poll(detectedAt = new Date()): Promise<UpbitPollResult> {
    if (!Number.isFinite(detectedAt.getTime())) throw new Error('Upbit detection time is invalid.')
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.etag) headers['If-None-Match'] = this.etag
    const response = await this.fetcher(this.relayUrl, { headers, signal: AbortSignal.timeout(5_000) })
    if (response.status === 304) return { status: 'unchanged', events: [], nextPollInMs: 1_000 }
    if (!response.ok) throw new Error('Upbit relay failed with HTTP ' + response.status + '.')
    const body = await response.text()
    if (body.length < 2 || body.length > 1_000_000) throw new Error('Upbit relay response size is invalid.')
    const signature = response.headers.get('x-lolah-ed25519-signature') ?? ''
    if (!/^[A-Za-z0-9+/=]{80,120}$/.test(signature)
      || !verify(null, Buffer.from(body), this.publicKey, Buffer.from(signature, 'base64'))) {
      throw new Error('Upbit relay signature is invalid.')
    }
    let payload: unknown
    try { payload = JSON.parse(body) } catch { throw new Error('Upbit relay returned invalid JSON.') }
    if (!isRecord(payload) || payload.schema !== 'lolah-upbit-relay-v1'
      || !Number.isSafeInteger(payload.sequence) || Number(payload.sequence) < 1
      || typeof payload.generatedAt !== 'string' || !Number.isFinite(Date.parse(payload.generatedAt))
      || !Array.isArray(payload.events) || payload.events.length > 100 || !payload.events.every(validEvent)) {
      throw new Error('Upbit relay envelope is invalid.')
    }
    const sequence = Number(payload.sequence)
    const digest = createHash('sha256').update(body).digest('hex')
    if (this.lastSequence !== undefined && sequence < this.lastSequence) throw new Error('Upbit relay sequence moved backwards.')
    if (this.lastSequence === sequence) {
      if (this.lastDigest !== digest) throw new Error('Upbit relay sequence content conflicts with stored state.')
      return { status: 'unchanged', events: [], nextPollInMs: 1_000 }
    }
    const generatedAtMs = Date.parse(payload.generatedAt)
    if (generatedAtMs > detectedAt.getTime() + 30_000 || detectedAt.getTime() - generatedAtMs > 5 * 60_000) {
      throw new Error('Upbit relay envelope time is invalid.')
    }
    const events: UpbitListingEvent[] = []
    for (const signedEvent of payload.events as UpbitListingEvent[]) {
      if (this.revisions.get(signedEvent.noticeId) === signedEvent.revisionId) continue
      const latency = Math.max(0, detectedAt.getTime() - Date.parse(signedEvent.revisedAt))
      const event: UpbitListingEvent = {
        ...structuredClone(signedEvent),
        detectedAt: detectedAt.toISOString(),
        detectionLatencyMs: latency,
        freshness: latency <= this.actionableLatencyMs ? 'fresh' : 'late',
        executionAllowed: false,
      }
      this.revisions.set(event.noticeId, event.revisionId)
      events.push(event)
    }
    this.lastSequence = sequence
    this.lastDigest = digest
    const nextEtag = response.headers.get('etag')
    if (nextEtag) this.etag = nextEtag
    return { status: 'changed', events, nextPollInMs: 1_000 }
  }
}
