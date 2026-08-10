import { createHash } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import type { UpbitListingEvent, UpbitPollResult } from './upbit-listing-monitor.js'
import type { UpbitCoinListingSnapshot, UpbitListingSource } from './upbit-listing-source.js'

const SEOUL_FEED = 'wss://seoul.coinlisting.pro/feed'
const ALLOWED_ENDPOINTS = new Set([
  SEOUL_FEED,
  'wss://tokyo.coinlisting.pro/feed',
])
const NEW_SUPPORT = '\uC2E0\uADDC \uAC70\uB798\uC9C0\uC6D0'
const DIGITAL_ASSET_ADD = '\uB514\uC9C0\uD138 \uC790\uC0B0 \uCD94\uAC00'
const MARKET = '\uB9C8\uCF13'

type JsonRecord = Record<string, unknown>

export type CoinListingFrame = {
  text: string
  receivedAt: Date
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredText(value: unknown, label: string, maximum = 2_000) {
  if (typeof value !== 'string') throw new Error(label + ' is invalid.')
  const result = value.trim()
  if (!result || result.length > maximum) throw new Error(label + ' is invalid.')
  return result
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function listingTitle(title: string) {
  return (title.includes(NEW_SUPPORT) || title.includes(DIGITAL_ASSET_ADD))
    && (title.includes(MARKET) || /\bMarket\b/i.test(title))
}

function symbols(title: string) {
  const groups = [...title.matchAll(/\(([^()]+)\)/g)].map(match => match[1].trim())
  const group = groups.find(value => /^[A-Z0-9][A-Z0-9, ._-]*$/.test(value)
    && value.split(',').every(symbol => /^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(symbol.trim()))
    && !/^(?:KRW|BTC|USDT)(?:\s*,\s*(?:KRW|BTC|USDT))*$/.test(value))
  if (!group) throw new Error('CoinListing Upbit symbols are unavailable.')
  return unique(group.split(',').map(value => value.trim().toUpperCase()))
}

function quoteMarkets(title: string) {
  const prefix = title.match(new RegExp('^(.+?)\\s*' + MARKET))
  const parenthesized = [...title.matchAll(/\(([^()]+)\)/g)]
    .map(match => match[1])
    .find(value => value.includes(MARKET) || /\bMarket\b/i.test(value))
  const context = prefix?.[1] ?? parenthesized ?? ''
  const markets = unique([...context.matchAll(/\b(KRW|BTC|USDT)\b/g)].map(match => match[1]))
  if (!markets.length) throw new Error('CoinListing Upbit quote markets are unavailable.')
  return markets
}

function providerEvent(
  payload: JsonRecord,
  receivedAt: Date,
  previousRevisionId?: string,
  actionableLatencyMs = 15_000,
): UpbitListingEvent | undefined {
  if (!Number.isFinite(receivedAt.getTime()) || !Number.isInteger(actionableLatencyMs)
    || actionableLatencyMs < 1_000 || actionableLatencyMs > 5 * 60_000) {
    throw new Error('CoinListing Upbit timing is invalid.')
  }
  if (payload.source !== 'UPBIT') return undefined
  const title = requiredText(payload.title, 'CoinListing Upbit title')
  if (!listingTitle(title)) return undefined
  const source = new URL(requiredText(payload.url, 'CoinListing Upbit URL'))
  if (source.protocol !== 'https:' || !['upbit.com', 'www.upbit.com'].includes(source.hostname.toLowerCase())
    || source.pathname !== '/service_center/notice' || source.username || source.password || source.hash) {
    throw new Error('CoinListing Upbit URL is invalid.')
  }
  const noticeIdText = source.searchParams.get('id') ?? ''
  if (!/^\d{1,12}$/.test(noticeIdText)) throw new Error('CoinListing Upbit notice ID is invalid.')
  const noticeId = Number(noticeIdText)
  const providerDetectedAt = new Date(requiredText(payload.detected_at_iso, 'CoinListing detection time', 50))
  if (!Number.isFinite(providerDetectedAt.getTime()) || providerDetectedAt.getTime() > receivedAt.getTime() + 30_000) {
    throw new Error('CoinListing detection time is invalid.')
  }
  const revisionId = createHash('sha256').update([noticeId, title].join('\n')).digest('hex').slice(0, 40)
  const latency = Math.max(0, receivedAt.getTime() - providerDetectedAt.getTime())
  return {
    schema: 'lolah-upbit-listing-v1',
    eventId: 'upbit_' + noticeId,
    revisionId,
    noticeId,
    status: previousRevisionId && previousRevisionId !== revisionId ? 'listing_update' : 'new_listing',
    sourceAuthority: 'upbit_official_website',
    sourceUrl: 'https://www.upbit.com/service_center/notice?id=' + noticeId,
    title,
    symbols: symbols(title),
    quoteMarkets: quoteMarkets(title),
    firstPublishedAt: providerDetectedAt.toISOString(),
    revisedAt: providerDetectedAt.toISOString(),
    detectedAt: receivedAt.toISOString(),
    detectionLatencyMs: latency,
    freshness: latency <= actionableLatencyMs ? 'fresh' : 'late',
    executionAllowed: false,
  }
}

export function parseCoinListingFrame(
  frame: CoinListingFrame,
  previousRevisionId?: string,
  actionableLatencyMs = 15_000,
) {
  if (typeof frame.text !== 'string' || frame.text.length < 2 || frame.text.length > 256_000) {
    throw new Error('CoinListing frame size is invalid.')
  }
  let payload: unknown
  try { payload = JSON.parse(frame.text) } catch { throw new Error('CoinListing frame JSON is invalid.') }
  if (!isRecord(payload)) throw new Error('CoinListing frame is invalid.')
  if (payload.type === 'connection') {
    if (payload.status !== 'connected' || !Array.isArray(payload.sources) || !payload.sources.includes('UPBIT')) {
      throw new Error('CoinListing connection cannot provide Upbit.')
    }
    return undefined
  }
  if (payload.type === 'pong') return undefined
  return providerEvent(payload, frame.receivedAt, previousRevisionId, actionableLatencyMs)
}

function rawText(data: RawData) {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data)
  if (buffer.byteLength > 256_000) throw new Error('CoinListing frame size is invalid.')
  return buffer.toString('utf8')
}

function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

async function openSocket(socket: WebSocket, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const clean = () => {
      socket.off('open', opened)
      socket.off('error', failed)
      socket.off('close', closed)
      signal.removeEventListener('abort', aborted)
    }
    const opened = () => { clean(); resolve() }
    const failed = () => { clean(); reject(new Error('CoinListing connection failed.')) }
    const closed = () => { clean(); reject(new Error('CoinListing connection closed.')) }
    const aborted = () => { clean(); socket.close(); reject(new Error('CoinListing connection stopped.')) }
    socket.once('open', opened)
    socket.once('error', failed)
    socket.once('close', closed)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

async function* socketFrames(socket: WebSocket, signal: AbortSignal): AsyncGenerator<CoinListingFrame> {
  const frames: CoinListingFrame[] = []
  let wake: (() => void) | undefined
  let closed = false
  const onMessage = (data: RawData) => {
    try {
      frames.push({ text: rawText(data), receivedAt: new Date() })
    } catch {
      closed = true
      socket.close()
    }
    wake?.()
  }
  const onClose = () => { closed = true; wake?.() }
  const onError = () => { closed = true; wake?.() }
  const onAbort = () => { closed = true; socket.close(); wake?.() }
  socket.on('message', onMessage)
  socket.once('close', onClose)
  socket.once('error', onError)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    while (!signal.aborted && (!closed || frames.length)) {
      if (frames.length) {
        yield frames.shift()!
        continue
      }
      await new Promise<void>(resolve => { wake = resolve })
      wake = undefined
    }
  } finally {
    socket.off('message', onMessage)
    socket.off('close', onClose)
    socket.off('error', onError)
    signal.removeEventListener('abort', onAbort)
  }
}

export async function* coinListingFrames(input: {
  apiKey: string
  signal: AbortSignal
  endpoint?: string
  onStatus?: (status: { state: 'connected' | 'reconnecting'; retryAfterMs?: number }) => void
}): AsyncGenerator<CoinListingFrame> {
  const endpoint = input.endpoint ?? SEOUL_FEED
  if (!ALLOWED_ENDPOINTS.has(endpoint)) throw new Error('CoinListing endpoint is not allowed.')
  if (!/^[^\s?#&]{8,512}$/.test(input.apiKey)) throw new Error('CoinListing API access is not configured.')
  let failures = 0
  while (!input.signal.aborted) {
    const url = new URL(endpoint)
    url.searchParams.set('key', input.apiKey)
    let socket: WebSocket | undefined
    try {
      socket = new WebSocket(url)
      await openSocket(socket, input.signal)
      failures = 0
      input.onStatus?.({ state: 'connected' })
      for await (const frame of socketFrames(socket, input.signal)) yield frame
    } catch {
      if (input.signal.aborted) break
    } finally {
      socket?.terminate()
    }
    failures += 1
    const retryAfterMs = Math.min(30_000, 1_000 * (2 ** Math.min(5, failures - 1)))
    input.onStatus?.({ state: 'reconnecting', retryAfterMs })
    await wait(retryAfterMs, input.signal)
  }
}

export class CoinListingUpbitSource implements UpbitListingSource {
  private readonly iterator: AsyncIterator<CoinListingFrame>
  private readonly revisions = new Map<number, string>()

  constructor(
    frames: AsyncIterable<CoinListingFrame>,
    snapshot?: UpbitCoinListingSnapshot,
    private readonly actionableLatencyMs = 15_000,
  ) {
    if (snapshot) {
      if (snapshot.schema !== 'lolah-upbit-coinlisting-state-v1' || !Array.isArray(snapshot.revisions)
        || snapshot.revisions.length > 5_000 || snapshot.revisions.some(item => !Number.isInteger(item.noticeId)
          || item.noticeId < 1 || !/^[a-f0-9]{40}$/.test(item.revisionId))) {
        throw new Error('CoinListing snapshot is invalid.')
      }
      for (const item of snapshot.revisions) this.revisions.set(item.noticeId, item.revisionId)
    }
    this.iterator = frames[Symbol.asyncIterator]()
  }

  snapshot(): UpbitCoinListingSnapshot {
    return {
      schema: 'lolah-upbit-coinlisting-state-v1',
      revisions: [...this.revisions].map(([noticeId, revisionId]) => ({ noticeId, revisionId })),
    }
  }

  async poll(): Promise<UpbitPollResult> {
    while (true) {
      const next = await this.iterator.next()
      if (next.done) throw new Error('CoinListing feed stopped.')
      const parsed = parseCoinListingFrame(next.value, undefined, this.actionableLatencyMs)
      if (!parsed) continue
      const previous = this.revisions.get(parsed.noticeId)
      if (previous === parsed.revisionId) continue
      const event: UpbitListingEvent = previous ? { ...parsed, status: 'listing_update' } : parsed
      this.revisions.set(event.noticeId, event.revisionId)
      if (this.revisions.size > 5_000) this.revisions.delete(this.revisions.keys().next().value!)
      return { status: 'changed', events: [event], nextPollInMs: 0 }
    }
  }
}

export const COINLISTING_UPBIT_ENDPOINT = SEOUL_FEED
