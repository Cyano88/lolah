export type RawXPost = {
  platform: 'x'
  postId: string
  authorId: string
  username: string
  text: string
  createdAt: string
  sourceUrl: string
}

export type XRecentSearchResult = {
  posts: RawXPost[]
  nextToken?: string
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export async function fetchRecentXPosts(
  query: string,
  bearerToken: string,
  fetcher: typeof fetch = fetch,
  nextToken?: string,
  sinceId?: string,
  startTime?: string,
): Promise<XRecentSearchResult> {
  const normalizedQuery = query.replace(/\s+/g, ' ').trim()
  if (normalizedQuery.length < 2 || normalizedQuery.length > 480) throw new Error('X query must contain 2 through 480 characters.')
  if (!bearerToken || bearerToken.length < 20) throw new Error('X API access is not configured.')
  const params = new URLSearchParams({
    query: normalizedQuery,
    max_results: '100',
    expansions: 'author_id',
    'tweet.fields': 'author_id,created_at,lang',
    'user.fields': 'username',
  })
  if (nextToken) params.set('next_token', nextToken)
  if (sinceId) {
    if (!/^\d+$/.test(sinceId)) throw new Error('X sinceId is invalid.')
    params.set('since_id', sinceId)
  }
  if (startTime) {
    const startTimeMs = Date.parse(startTime)
    if (!Number.isFinite(startTimeMs)) throw new Error('X startTime is invalid.')
    params.set('start_time', new Date(startTimeMs).toISOString())
  }
  const response = await fetcher('https://api.x.com/2/tweets/search/recent?' + params.toString(), {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearerToken },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('X recent search failed with HTTP ' + response.status + '.')
  const payload: unknown = await response.json()
  if (!isRecord(payload)) throw new Error('X returned an invalid recent-search response.')
  const users = isRecord(payload.includes) && Array.isArray(payload.includes.users) ? payload.includes.users : []
  const usernames = new Map<string, string>()
  for (const user of users) {
    if (!isRecord(user)) continue
    const id = text(user.id)
    const username = text(user.username)
    if (id && /^[a-z0-9_]{1,15}$/i.test(username)) usernames.set(id, username)
  }
  const posts: RawXPost[] = []
  const data = Array.isArray(payload.data) ? payload.data : []
  for (const item of data) {
    if (!isRecord(item)) continue
    const postId = text(item.id)
    const authorId = text(item.author_id)
    const username = usernames.get(authorId)
    const postText = text(item.text).replace(/\s+/g, ' ')
    const createdAtMs = Date.parse(text(item.created_at))
    if (!/^\d+$/.test(postId) || !/^\d+$/.test(authorId) || !username || postText.length < 4 || !Number.isFinite(createdAtMs)) {
      continue
    }
    posts.push({
      platform: 'x',
      postId,
      authorId,
      username,
      text: postText.slice(0, 1_000),
      createdAt: new Date(createdAtMs).toISOString(),
      sourceUrl: 'https://x.com/' + username + '/status/' + postId,
    })
  }
  const meta = isRecord(payload.meta) ? payload.meta : {}
  const resultNextToken = text(meta.next_token)
  return { posts, ...(resultNextToken ? { nextToken: resultNextToken } : {}) }
}
