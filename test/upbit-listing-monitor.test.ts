import assert from 'node:assert/strict'
import test from 'node:test'
import { UpbitListingMonitor } from '../src/upbit-listing-monitor.js'

const title = 'BTC, USDT 마켓 신규 거래지원 안내 (CYS, ICNT, XAN, EDEN, AIOZ, ALLO)'

function page(listedAt = '2026-08-10T11:05:54+09:00', updated = false) {
  return {
    success: true,
    data: {
      notices: [{
        id: 6458,
        title: updated ? title + ' (거래지원 개시 시점 변경 안내)' : title,
        category: '거래',
        listed_at: listedAt,
        first_listed_at: '2026-08-10T11:05:54+09:00',
        need_update_badge: updated,
      }],
    },
  }
}

function detail(body: string) {
  return { success: true, data: { body } }
}

function mockFetcher(pages: unknown[], details: unknown[]) {
  let pageIndex = 0
  let detailIndex = 0
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/announcements?')) {
      const payload = pages[Math.min(pageIndex++, pages.length - 1)]
      if (payload === '304') return new Response(null, { status: 304 })
      return new Response(JSON.stringify(payload), { status: 200, headers: { etag: '"revision-' + pageIndex + '"' } })
    }
    assert.equal(url, 'https://pub-info.upbit.com/api/v1/announcements/6458')
    assert.equal(init?.headers && (init.headers as Record<string, string>).Accept, 'application/json')
    return new Response(JSON.stringify(details[Math.min(detailIndex++, details.length - 1)]), { status: 200 })
  }
}

test('emits the first official Upbit listing with measured sub-15-second freshness', async () => {
  const fetcher = mockFetcher(
    [page()],
    [detail('거래지원 개시 시점 : 2026-08-10 14:00 KST')],
  )
  const monitor = new UpbitListingMonitor(fetcher as typeof fetch)
  const result = await monitor.poll(new Date('2026-08-10T02:06:04Z'))
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].status, 'new_listing')
  assert.equal(result.events[0].freshness, 'fresh')
  assert.equal(result.events[0].detectionLatencyMs, 10_000)
  assert.deepEqual(result.events[0].symbols, ['CYS', 'ICNT', 'XAN', 'EDEN', 'AIOZ', 'ALLO'])
  assert.deepEqual(result.events[0].quoteMarkets, ['BTC', 'USDT'])
  assert.equal(result.events[0].tradingStartsAt, '2026-08-10T05:00:00.000Z')
  assert.equal(result.events[0].executionAllowed, false)
})

test('emits an amended trading time as a new revision and does not replay it', async () => {
  const originalBody = '거래지원 개시 시점 : 2026-08-10 14:00 KST'
  const updatedBody = '변경된 거래지원 개시 시점 : 2026-08-10 17:00 KST'
  const fetcher = mockFetcher(
    [page(), page('2026-08-10T13:35:02+09:00', true), page('2026-08-10T13:35:02+09:00', true)],
    [detail(originalBody), detail(updatedBody), detail(updatedBody)],
  )
  const monitor = new UpbitListingMonitor(fetcher as typeof fetch)
  await monitor.poll(new Date('2026-08-10T02:06:04Z'))
  const update = await monitor.poll(new Date('2026-08-10T04:35:05Z'))
  assert.equal(update.events[0].status, 'listing_update')
  assert.equal(update.events[0].freshness, 'fresh')
  assert.equal(update.events[0].tradingStartsAt, '2026-08-10T08:00:00.000Z')
  const replay = await monitor.poll(new Date('2026-08-10T04:35:06Z'))
  assert.equal(replay.events.length, 0)
})

test('uses ETag revalidation and returns immediately on 304', async () => {
  const fetcher = mockFetcher([page(), '304'], [detail('거래지원 개시 시점 : 2026-08-10 14:00 KST')])
  const monitor = new UpbitListingMonitor(fetcher as typeof fetch)
  await monitor.poll(new Date('2026-08-10T02:06:04Z'))
  const result = await monitor.poll(new Date('2026-08-10T02:06:05Z'))
  assert.deepEqual(result, { status: 'unchanged', events: [], nextPollInMs: 1_000 })
})

test('marks a delayed observation late instead of presenting stale alpha', async () => {
  const fetcher = mockFetcher([page()], [detail('거래지원 개시 시점 : 2026-08-10 14:00 KST')])
  const monitor = new UpbitListingMonitor(fetcher as typeof fetch)
  const result = await monitor.poll(new Date('2026-08-10T02:07:00Z'))
  assert.equal(result.events[0].freshness, 'late')
})

test('ignores non-listing trade notices', async () => {
  const fetcher = async () => new Response(JSON.stringify({
    success: true,
    data: { notices: [{ ...page().data.notices[0], title: '신세틱스(SNX) 거래 유의 종목 지정 안내' }] },
  }), { status: 200 })
  const monitor = new UpbitListingMonitor(fetcher as typeof fetch)
  const result = await monitor.poll(new Date('2026-08-10T02:06:04Z'))
  assert.equal(result.events.length, 0)
})

test('parses the alternate single-token title with quote markets at the end', async () => {
  const alternate = {
    ...page().data.notices[0],
    id: 6446,
    title: '캡(CAP) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
  }
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/announcements?')) {
      return new Response(JSON.stringify({ success: true, data: { notices: [alternate] } }), { status: 200 })
    }
    assert.equal(url, 'https://pub-info.upbit.com/api/v1/announcements/6446')
    return new Response(JSON.stringify(detail('거래지원 개시 시점 : 2026-08-10 14:00 KST')), { status: 200 })
  }
  const monitor = new UpbitListingMonitor(fetcher as typeof fetch)
  const result = await monitor.poll(new Date('2026-08-10T02:06:04Z'))
  assert.deepEqual(result.events[0].symbols, ['CAP'])
  assert.deepEqual(result.events[0].quoteMarkets, ['KRW', 'BTC', 'USDT'])
})
