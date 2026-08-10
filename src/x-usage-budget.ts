import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type XUsageState = {
  schema: 'lolah-x-usage-v1'
  utcDay: string
  postIds: string[]
}

export type XUsageSnapshot = {
  dailyPostCap: number
  uniquePostsRead: number
  remainingPosts: number
  retryAfterMs: number
}

function utcDay(now: Date) {
  return now.toISOString().slice(0, 10)
}

function untilNextUtcDay(now: Date) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1_000, next - now.getTime())
}

export class XDailyUsageBudget {
  constructor(private readonly path: string, readonly dailyPostCap: number) {
    if (!Number.isInteger(dailyPostCap) || dailyPostCap < 10 || dailyPostCap > 10_000) {
      throw new Error('X daily post cap must be 10 through 10000.')
    }
  }

  private async read(now: Date): Promise<XUsageState> {
    try {
      const raw = await readFile(this.path, 'utf8')
      if (raw.length < 2 || raw.length > 512 * 1_024) throw new Error('X usage state is invalid.')
      const state = JSON.parse(raw) as Partial<XUsageState>
      if (state.schema !== 'lolah-x-usage-v1' || typeof state.utcDay !== 'string' || !Array.isArray(state.postIds)
        || state.postIds.length > this.dailyPostCap || state.postIds.some(id => !/^\d+$/.test(id))) {
        throw new Error('X usage state is invalid.')
      }
      return state.utcDay === utcDay(now)
        ? state as XUsageState
        : { schema: 'lolah-x-usage-v1', utcDay: utcDay(now), postIds: [] }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { schema: 'lolah-x-usage-v1', utcDay: utcDay(now), postIds: [] }
      }
      throw error
    }
  }

  private snapshotFor(state: XUsageState, now: Date): XUsageSnapshot {
    const remainingPosts = this.dailyPostCap - state.postIds.length
    return {
      dailyPostCap: this.dailyPostCap,
      uniquePostsRead: state.postIds.length,
      remainingPosts,
      retryAfterMs: remainingPosts >= 10 ? 0 : untilNextUtcDay(now),
    }
  }

  async snapshot(now = new Date()) {
    return this.snapshotFor(await this.read(now), now)
  }

  async record(postIds: string[], now = new Date()) {
    if (!Array.isArray(postIds) || postIds.some(id => !/^\d+$/.test(id))) {
      throw new Error('X usage receipt is invalid.')
    }
    const state = await this.read(now)
    const ids = new Set(state.postIds)
    for (const postId of postIds) ids.add(postId)
    if (ids.size > this.dailyPostCap) throw new Error('X response exceeded the remaining daily post budget.')
    const next: XUsageState = { schema: 'lolah-x-usage-v1', utcDay: utcDay(now), postIds: [...ids] }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = this.path + '.' + process.pid + '.' + Date.now() + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      })
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    return this.snapshotFor(next, now)
  }
}
