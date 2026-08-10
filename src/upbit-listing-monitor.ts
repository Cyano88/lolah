import { createHash } from 'node:crypto'

const ANNOUNCEMENTS_URL = 'https://pub-info.upbit.com/api/v1/announcements?os=web&page=1&per_page=10&category=all'
const ANNOUNCEMENT_URL = 'https://pub-info.upbit.com/api/v1/announcements/'
const NOTICE_URL = 'https://www.upbit.com/service_center/notice?id='

type JsonRecord = Record<string, unknown>

export type UpbitAnnouncementSummary = {
  id: number
  title: string
  category: string
  listedAt: string
  firstListedAt: string
  updated: boolean
}

export type UpbitListingEvent = {
  schema: 'lolah-upbit-listing-v1'
  eventId: string
  revisionId: string
  noticeId: number
  status: 'new_listing' | 'listing_update'
  sourceAuthority: 'upbit_official_website'
  sourceUrl: string
  title: string
  symbols: string[]
  quoteMarkets: string[]
  firstPublishedAt: string
  revisedAt: string
  detectedAt: string
  detectionLatencyMs: number
  providerSentAt?: string
  transportLatencyMs?: number
  freshness: 'fresh' | 'late'
  tradingStartsAt?: string
  executionAllowed: false
}

export type UpbitListingMonitorSnapshot = {
  schema: 'lolah-upbit-monitor-state-v1'
  etag?: string
  revisions: Array<{ noticeId: number; revisionId: string }>
}

export type UpbitPollResult = {
  status: 'changed' | 'unchanged'
  events: UpbitListingEvent[]
  nextPollInMs: number
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredText(value: unknown, label: string, maximum = 1_000) {
  if (typeof value !== 'string') throw new Error(label + ' is invalid.')
  const result = value.trim()
  if (!result || result.length > maximum) throw new Error(label + ' is invalid.')
  return result
}

function iso(value: unknown, label: string) {
  const text = requiredText(value, label, 50)
  const timestamp = Date.parse(text)
  if (!Number.isFinite(timestamp)) throw new Error(label + ' is invalid.')
  return new Date(timestamp).toISOString()
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function revisionId(summary: UpbitAnnouncementSummary, body: string) {
  return createHash('sha256')
    .update([summary.id, summary.listedAt, summary.title, body].join('\n'))
    .digest('hex')
    .slice(0, 40)
}

function listingTitle(title: string) {
  return title.includes('신규 거래지원') && title.includes('마켓')
}

function parseSymbols(title: string) {
  const groups = [...title.matchAll(/\(([^()]+)\)/g)].map(match => match[1].trim())
  const symbolGroup = groups.find(group => /^[A-Z0-9][A-Z0-9, ._-]*$/.test(group)
    && group.split(',').every(value => /^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(value.trim())))
  if (!symbolGroup) throw new Error('Upbit listing symbols could not be determined.')
  return unique(symbolGroup.split(',').map(value => value.trim().toUpperCase()))
}

function parseQuoteMarkets(title: string) {
  const match = title.match(/^(.+?)\s*마켓\s*신규 거래지원/)
    ?? title.match(/\(([A-Z0-9][A-Z0-9, ]+)\s*마켓\)/)
  if (!match) throw new Error('Upbit listing markets could not be determined.')
  const markets = match[1].split(',').map(value => value.trim().toUpperCase())
  if (!markets.length || markets.some(value => !/^[A-Z0-9]{2,12}$/.test(value))) {
    throw new Error('Upbit listing markets are invalid.')
  }
  return unique(markets)
}

function kstDate(value: string) {
  const match = value.match(/(20\d{2})[-.]\s*(\d{1,2})[-.]\s*(\d{1,2})\s+(\d{1,2}):(\d{2})\s*KST/i)
  if (!match) return undefined
  const [, year, month, day, hour, minute] = match
  const timestamp = Date.parse(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00+09:00`)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

function tradingStart(body: string) {
  const changed = body.match(/변경된 거래지원 개시 시점\s*:\s*([^\r\n]+)/)
  if (changed) return kstDate(changed[1])
  const explicit = body.match(/거래지원 개시 시점\s*:\s*([^\r\n]+)/)
  return explicit ? kstDate(explicit[1]) : undefined
}

function parseSummary(value: unknown): UpbitAnnouncementSummary {
  if (!isRecord(value) || !Number.isInteger(value.id) || Number(value.id) < 1) {
    throw new Error('Upbit announcement summary is invalid.')
  }
  return {
    id: Number(value.id),
    title: requiredText(value.title, 'Upbit announcement title', 500),
    category: requiredText(value.category, 'Upbit announcement category', 40),
    listedAt: iso(value.listed_at, 'Upbit announcement listed_at'),
    firstListedAt: iso(value.first_listed_at, 'Upbit announcement first_listed_at'),
    updated: value.need_update_badge === true,
  }
}

async function responseJson(response: Response, label: string) {
  const value: unknown = await response.json()
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) {
    throw new Error(label + ' returned an invalid response.')
  }
  return value.data
}

export class UpbitListingMonitor {
  private etag?: string
  private readonly revisions = new Map<number, string>()

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    snapshot?: UpbitListingMonitorSnapshot,
    private readonly actionableLatencyMs = 15_000,
  ) {
    if (!Number.isInteger(actionableLatencyMs) || actionableLatencyMs < 1_000 || actionableLatencyMs > 5 * 60_000) {
      throw new Error('Upbit actionable latency must be 1 second through 5 minutes.')
    }
    if (snapshot) this.restore(snapshot)
  }

  private restore(snapshot: UpbitListingMonitorSnapshot) {
    if (snapshot.schema !== 'lolah-upbit-monitor-state-v1' || !Array.isArray(snapshot.revisions)
      || snapshot.revisions.length > 5_000 || (snapshot.etag !== undefined && snapshot.etag.length > 500)) {
      throw new Error('Upbit monitor snapshot is invalid.')
    }
    this.etag = snapshot.etag
    for (const item of snapshot.revisions) {
      if (!Number.isInteger(item.noticeId) || item.noticeId < 1 || !/^[a-f0-9]{40}$/.test(item.revisionId)) {
        throw new Error('Upbit monitor snapshot contains an invalid revision.')
      }
      this.revisions.set(item.noticeId, item.revisionId)
    }
  }

  snapshot(): UpbitListingMonitorSnapshot {
    return {
      schema: 'lolah-upbit-monitor-state-v1',
      ...(this.etag ? { etag: this.etag } : {}),
      revisions: [...this.revisions].map(([noticeId, storedRevision]) => ({ noticeId, revisionId: storedRevision })),
    }
  }

  async poll(detectedAt = new Date()): Promise<UpbitPollResult> {
    if (!Number.isFinite(detectedAt.getTime())) throw new Error('Upbit detection time is invalid.')
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.etag) headers['If-None-Match'] = this.etag
    const response = await this.fetcher(ANNOUNCEMENTS_URL, {
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    if (response.status === 304) return { status: 'unchanged', events: [], nextPollInMs: 1_000 }
    if (!response.ok) throw new Error('Upbit announcements failed with HTTP ' + response.status + '.')
    const nextEtag = response.headers.get('etag')
    if (nextEtag) this.etag = nextEtag
    const data = await responseJson(response, 'Upbit announcements')
    if (!Array.isArray(data.notices) || data.notices.length > 100) {
      throw new Error('Upbit announcements returned an invalid notice list.')
    }
    const summaries = data.notices.map(parseSummary).filter(item => item.category === '거래' && listingTitle(item.title))
    const events = (await Promise.all(summaries.map(summary => this.fetchListing(summary, detectedAt))))
      .filter((event): event is UpbitListingEvent => Boolean(event))
    return { status: 'changed', events, nextPollInMs: 1_000 }
  }

  private async fetchListing(summary: UpbitAnnouncementSummary, detectedAt: Date) {
    const response = await this.fetcher(ANNOUNCEMENT_URL + summary.id, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error('Upbit announcement detail failed with HTTP ' + response.status + '.')
    const data = await responseJson(response, 'Upbit announcement detail')
    const body = requiredText(data.body, 'Upbit announcement body', 100_000)
    const storedRevision = revisionId(summary, body)
    if (this.revisions.get(summary.id) === storedRevision) return undefined
    const previous = this.revisions.get(summary.id)
    this.revisions.set(summary.id, storedRevision)
    if (this.revisions.size > 5_000) this.revisions.delete(this.revisions.keys().next().value!)
    const revisionAt = Date.parse(summary.listedAt)
    const latency = Math.max(0, detectedAt.getTime() - revisionAt)
    return {
      schema: 'lolah-upbit-listing-v1' as const,
      eventId: 'upbit_' + summary.id,
      revisionId: storedRevision,
      noticeId: summary.id,
      status: previous || summary.updated ? 'listing_update' as const : 'new_listing' as const,
      sourceAuthority: 'upbit_official_website' as const,
      sourceUrl: NOTICE_URL + summary.id,
      title: summary.title,
      symbols: parseSymbols(summary.title),
      quoteMarkets: parseQuoteMarkets(summary.title),
      firstPublishedAt: summary.firstListedAt,
      revisedAt: summary.listedAt,
      detectedAt: detectedAt.toISOString(),
      detectionLatencyMs: latency,
      freshness: latency <= this.actionableLatencyMs ? 'fresh' as const : 'late' as const,
      ...(tradingStart(body) ? { tradingStartsAt: tradingStart(body) } : {}),
      executionAllowed: false as const,
    }
  }
}

export const UPBIT_LISTING_POLL_INTERVAL_MS = 1_000
