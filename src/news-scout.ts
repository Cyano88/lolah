import { createHash } from 'node:crypto'
import type { LolahEventType, LolahNewsEvent } from './contracts.js'
import {
  entitiesForSource,
  sourceByAuthorId,
  validateSourceRegistry,
  type LolahEntityDefinition,
  type LolahSourceRegistry,
} from './source-registry.js'
import type { RawXPost } from './x-recent-search.js'

export type ScoutIngestResult =
  | { status: 'new_event' | 'updated_event'; event: LolahNewsEvent; entityIds: string[]; targetMarkets: string[] }
  | { status: 'duplicate' | 'ignored'; reason: string }

type EventType = LolahEventType

export type LolahNewsScoutSnapshot = {
  schema: 'lolah-news-scout-state-v1'
  seenPostIds: string[]
  clusters: Array<{
    clusterKey: string
    event: LolahNewsEvent
    postIds: string[]
    sourceIds: string[]
    sourceUrls: string[]
  }>
}

const EVENT_TERMS: Array<{ eventType: EventType; phrases: string[] }> = [
  { eventType: 'exploit', phrases: ['security exploit', 'was exploited', 'has been hacked', 'security breach', 'funds drained', 'stolen funds'] },
  { eventType: 'shutdown', phrases: ['shut down', 'shutdown', 'cease operations', 'wind down operations', 'permanently closing'] },
  { eventType: 'delisting', phrases: ['will delist', 'has delisted', 'being delisted', 'delisting'] },
  { eventType: 'listing', phrases: ['will list', 'now listed', 'new listing', 'listing announcement'] },
  { eventType: 'token_unlock', phrases: ['token unlock', 'tokens unlock', 'vesting release', 'unlock schedule'] },
  { eventType: 'acquisition', phrases: ['has acquired', 'will acquire', 'acquisition', 'merger agreement', 'being acquired'] },
  { eventType: 'lawsuit', phrases: ['filed a lawsuit', 'has sued', 'was sued', 'litigation', 'court action'] },
  { eventType: 'regulatory_action', phrases: ['enforcement action', 'regulatory action', 'regulator investigation', 'regulatory investigation', 'sanctions imposed'] },
  { eventType: 'leadership_change', phrases: ['chief executive resigns', 'ceo resigns', 'founder leaves', 'appointed chief executive', 'new ceo'] },
  { eventType: 'partnership', phrases: ['strategic partnership', 'partners with', 'partnership announcement', 'integration with', 'integrates with'] },
  { eventType: 'governance_decision', phrases: ['governance vote', 'proposal approved', 'proposal rejected', 'governance proposal'] },
  { eventType: 'network_outage', phrases: ['network outage', 'network is down', 'chain halted', 'block production halted', 'stopped producing blocks'] },
  { eventType: 'mainnet_launch', phrases: ['mainnet launch', 'launches mainnet', 'mainnet is live', 'mainnet goes live'] },
  { eventType: 'token_launch', phrases: ['token launch', 'launching our token', 'token generation event', ' tge '] },
  { eventType: 'airdrop', phrases: ['airdrop announced', 'airdrop claim', 'airdrop eligibility', 'claim the airdrop'] },
  { eventType: 'protocol_upgrade', phrases: ['protocol upgrade', 'network upgrade', 'hard fork', 'major upgrade'] },
  { eventType: 'buyback', phrases: [
    'token buyback', 'buyback program', 'treasury buyback', 'open market buyback',
    'buy back tokens', 'repurchase tokens', 'repurchased tokens', 'buyback complete',
  ] },
  { eventType: 'token_burn', phrases: ['token burn', 'burning tokens', 'tokens burned'] },
  { eventType: 'bankruptcy', phrases: ['filed for bankruptcy', 'bankruptcy filing', 'insolvency proceedings', 'is insolvent'] },
  { eventType: 'trading_halt', phrases: ['trading halted', 'trading suspended', 'suspend trading', 'halt deposits', 'halt withdrawals'] },
  { eventType: 'depeg', phrases: ['lost its peg', 'stablecoin depeg', 'depegged', 'reserve shortfall'] },
]

const DENIAL_PHRASES = [
  'will not shut down',
  'not shutting down',
  'not been exploited',
  'was not exploited',
  'no security exploit',
  'will not delist',
  'not delisting',
  'no token unlock',
  'reports are false',
  'rumors are false',
]
const MAX_POST_AGE_MS = 60 * 60_000

function normalized(value: string) {
  return ' ' + value.toLowerCase().replace(/[^a-z0-9$]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '
}

function phrasePresent(text: string, phrase: string) {
  return text.includes(normalized(phrase))
}

function entityMentioned(text: string, rawText: string, entity: LolahEntityDefinition) {
  if (entity.matchMode === 'symbol_strict') {
    return entity.symbols.some(symbol => {
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (symbol.length <= 2) {
        return new RegExp('(?:\\$' + escaped + '(?:$|[^A-Za-z0-9])|\\(' + escaped
          + '\\)|\\[' + escaped + '\\]|(?:^|[^A-Za-z0-9])' + escaped + '[-/](?:USDT|USDC)(?:$|[^A-Za-z0-9]))').test(rawText)
      }
      return new RegExp('(?:^|[^A-Za-z0-9])\\$?' + escaped + '(?:$|[^A-Za-z0-9])').test(rawText)
    })
  }
  const candidates = [...entity.aliases, ...entity.symbols.map(symbol => '$' + symbol), ...entity.symbols]
  return candidates.some(candidate => {
    const normalizedCandidate = normalized(candidate)
    if (normalizedCandidate.trim().length <= 2 && !candidate.startsWith('$')) return false
    return text.includes(normalizedCandidate)
  })
}

function classifyEvent(text: string) {
  if (DENIAL_PHRASES.some(phrase => phrasePresent(text, phrase))) return undefined
  const matches = EVENT_TERMS.filter(definition => definition.phrases.some(phrase => phrasePresent(text, phrase)))
  return matches[0]?.eventType
}

function validSourceUrl(post: RawXPost) {
  try {
    const url = new URL(post.sourceUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    return url.protocol === 'https:'
      && (url.hostname === 'x.com' || url.hostname === 'www.x.com')
      && parts.length === 3
      && parts[0].toLowerCase() === post.username.toLowerCase()
      && parts[1] === 'status'
      && parts[2] === post.postId
  } catch {
    return false
  }
}

function eventHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 40)
}

function validStoredXUrl(value: string) {
  try {
    const url = new URL(value)
    const parts = url.pathname.split('/').filter(Boolean)
    return url.protocol === 'https:' && (url.hostname === 'x.com' || url.hostname === 'www.x.com')
      && parts.length === 3 && parts[1] === 'status' && /^\d+$/.test(parts[2])
  } catch {
    return false
  }
}

type StoredEvent = {
  event: LolahNewsEvent
  entityIds: string[]
  targetMarkets: string[]
  postIds: Set<string>
  sourceIds: Set<string>
  sourceUrls: Set<string>
  official: boolean
}

export class LolahNewsScout {
  private readonly registry: LolahSourceRegistry
  private readonly clusters = new Map<string, StoredEvent>()
  private readonly seenPostIds = new Set<string>()

  constructor(registry: LolahSourceRegistry, snapshot?: LolahNewsScoutSnapshot) {
    this.registry = validateSourceRegistry(registry)
    if (snapshot) this.restore(snapshot)
  }

  private restore(snapshot: LolahNewsScoutSnapshot) {
    if (!snapshot || snapshot.schema !== 'lolah-news-scout-state-v1'
      || !Array.isArray(snapshot.seenPostIds) || snapshot.seenPostIds.length > 10_000
      || !Array.isArray(snapshot.clusters) || snapshot.clusters.length > 5_000) {
      throw new Error('Lolah scout snapshot is invalid.')
    }
    for (const postId of snapshot.seenPostIds) {
      if (!/^\d+$/.test(postId)) throw new Error('Lolah scout snapshot contains an invalid post ID.')
      this.seenPostIds.add(postId)
    }
    const eventTypes = new Set(EVENT_TERMS.map(item => item.eventType))
    const registryEntities = new Map(this.registry.entities.map(entity => [entity.id, entity]))
    const registrySources = new Map(this.registry.sources.map(source => [source.authorId, source]))
    for (const item of snapshot.clusters) {
      if (!item || typeof item.clusterKey !== 'string' || item.clusterKey.length > 300
        || !Array.isArray(item.postIds) || item.postIds.length < 1 || item.postIds.length > 100
        || !Array.isArray(item.sourceIds) || item.sourceIds.length < 1 || item.sourceIds.length > 100
        || !Array.isArray(item.sourceUrls) || item.sourceUrls.length < 1 || item.sourceUrls.length > 100) {
        throw new Error('Lolah scout snapshot contains an invalid cluster.')
      }
      const parts = item.clusterKey.split(':')
      if (parts.length !== 3 || !eventTypes.has(parts[0] as EventType) || !/^\d+$/.test(parts[2])) {
        throw new Error('Lolah scout snapshot contains an invalid cluster key.')
      }
      const entityIds = parts[1].split(',')
      const entities = entityIds.map(id => registryEntities.get(id))
      if (entities.some(entity => !entity)) throw new Error('Lolah scout snapshot references an unknown entity.')
      if (item.event?.schema !== 'lolah-news-event-v1' || item.event.eventType !== parts[0]
        || item.event.eventId !== 'evt_' + eventHash(item.clusterKey)
        || !Number.isFinite(Date.parse(item.event.publishedAt)) || !Number.isFinite(Date.parse(item.event.detectedAt))) {
        throw new Error('Lolah scout snapshot contains an invalid event.')
      }
      if (item.postIds.some(id => !/^\d+$/.test(id))
        || item.sourceIds.some(id => !registrySources.has(id))
        || item.sourceUrls.some(url => !validStoredXUrl(url))
        || !item.sourceUrls.includes(item.event.sourceUrl)) {
        throw new Error('Lolah scout snapshot contains invalid evidence.')
      }
      const sourceIds = new Set(item.sourceIds)
      const sourceUrls = new Set(item.sourceUrls)
      const official = item.sourceIds.some(id => registrySources.get(id)?.tier === 'official_project')
      const targetMarkets = [...new Set(entities.flatMap(entity => entity?.hyperliquidMarkets ?? []))].sort()
      const event: LolahNewsEvent = {
        ...item.event,
        entities: entities.map(entity => entity!.name),
        verification: {
          status: official ? 'official_source' : sourceIds.size >= 2 ? 'corroborated' : 'unverified',
          supportingSources: [...sourceUrls].filter(url => url !== item.event.sourceUrl).sort(),
        },
      }
      this.clusters.set(item.clusterKey, {
        event,
        entityIds,
        targetMarkets,
        postIds: new Set(item.postIds),
        sourceIds,
        sourceUrls,
        official,
      })
      for (const postId of item.postIds) this.seenPostIds.add(postId)
    }
  }

  snapshot(): LolahNewsScoutSnapshot {
    return {
      schema: 'lolah-news-scout-state-v1',
      seenPostIds: [...this.seenPostIds],
      clusters: [...this.clusters].map(([clusterKey, stored]) => ({
        clusterKey,
        event: {
          ...stored.event,
          entities: [...stored.event.entities],
          verification: {
            ...stored.event.verification,
            supportingSources: [...stored.event.verification.supportingSources],
          },
        },
        postIds: [...stored.postIds],
        sourceIds: [...stored.sourceIds],
        sourceUrls: [...stored.sourceUrls],
      })),
    }
  }

  ingest(post: RawXPost, detectedAt = new Date()): ScoutIngestResult {
    if (post.platform !== 'x' || !/^\d+$/.test(post.postId) || !/^\d+$/.test(post.authorId) || !validSourceUrl(post)) {
      return { status: 'ignored', reason: 'Post identity is invalid.' }
    }
    if (this.seenPostIds.has(post.postId)) return { status: 'duplicate', reason: 'Post was already processed.' }
    this.seenPostIds.add(post.postId)
    if (this.seenPostIds.size > 10_000) this.seenPostIds.delete(this.seenPostIds.values().next().value!)
    const source = sourceByAuthorId(this.registry, post.authorId)
    if (!source) return { status: 'ignored', reason: 'Author is not in the curated source registry.' }
    const publishedAtMs = Date.parse(post.createdAt)
    const detectedAtMs = detectedAt.getTime()
    if (!Number.isFinite(publishedAtMs) || !Number.isFinite(detectedAtMs)
      || detectedAtMs < publishedAtMs - 60_000 || detectedAtMs - publishedAtMs > MAX_POST_AGE_MS) {
      return { status: 'ignored', reason: 'Post timestamp is invalid.' }
    }
    const postText = normalized(post.text)
    const eventType = classifyEvent(postText)
    if (!eventType) return { status: 'ignored', reason: 'Post does not contain one unambiguous supported event type.' }
    const allowedEntities = entitiesForSource(this.registry, source)
    let matchedEntities = allowedEntities.filter(entity => entityMentioned(postText, post.text, entity))
    if (!matchedEntities.length && source.tier === 'official_project' && allowedEntities.length === 1) {
      matchedEntities = allowedEntities
    }
    if (!matchedEntities.length) return { status: 'ignored', reason: 'Post does not identify a permitted entity.' }

    const entityIds = matchedEntities.map(entity => entity.id).sort()
    const bucket = Math.floor(publishedAtMs / (12 * 60 * 60_000))
    const clusterKey = eventType + ':' + entityIds.join(',') + ':' + bucket
    const targetMarkets = [...new Set(matchedEntities.flatMap(entity => entity.hyperliquidMarkets))].sort()
    const isOfficial = source.tier === 'official_project'
    const existing = this.clusters.get(clusterKey)
    if (!existing) {
      const event: LolahNewsEvent = {
        schema: 'lolah-news-event-v1',
        eventId: 'evt_' + eventHash(clusterKey),
        headline: post.text.replace(/\s+/g, ' ').trim().slice(0, 300),
        publisher: '@' + post.username,
        sourceUrl: post.sourceUrl,
        publishedAt: new Date(publishedAtMs).toISOString(),
        detectedAt: detectedAt.toISOString(),
        entities: matchedEntities.map(entity => entity.name),
        eventType,
        verification: {
          status: isOfficial ? 'official_source' : 'unverified',
          supportingSources: [],
        },
      }
      this.clusters.set(clusterKey, {
        event,
        entityIds,
        targetMarkets,
        postIds: new Set([post.postId]),
        sourceIds: new Set([source.authorId]),
        sourceUrls: new Set([post.sourceUrl]),
        official: isOfficial,
      })
      if (this.clusters.size > 5_000) this.clusters.delete(this.clusters.keys().next().value!)
      return { status: 'new_event', event, entityIds, targetMarkets }
    }

    if (existing.postIds.has(post.postId)) return { status: 'duplicate', reason: 'Post was already included in the event.' }
    existing.postIds.add(post.postId)
    existing.sourceIds.add(source.authorId)
    existing.sourceUrls.add(post.sourceUrl)
    existing.targetMarkets = [...new Set([...existing.targetMarkets, ...targetMarkets])].sort()
    if (isOfficial && !existing.official) {
      existing.official = true
      existing.event = {
        ...existing.event,
        headline: post.text.replace(/\s+/g, ' ').trim().slice(0, 300),
        publisher: '@' + post.username,
        sourceUrl: post.sourceUrl,
        publishedAt: new Date(publishedAtMs).toISOString(),
      }
    }
    const supportingSources = [...existing.sourceUrls].filter(url => url !== existing.event.sourceUrl).sort()
    existing.event = {
      ...existing.event,
      detectedAt: detectedAt.toISOString(),
      verification: {
        status: existing.official ? 'official_source' : existing.sourceIds.size >= 2 ? 'corroborated' : 'unverified',
        supportingSources,
      },
    }
    return {
      status: 'updated_event',
      event: existing.event,
      entityIds: [...existing.entityIds],
      targetMarkets: existing.targetMarkets,
    }
  }
}
