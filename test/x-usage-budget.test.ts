import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { XDailyUsageBudget } from '../src/x-usage-budget.js'

test('durably deduplicates post reads and resets on the next UTC day', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-x-usage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'usage.json')
  const budget = new XDailyUsageBudget(path, 10)
  const firstDay = new Date('2026-08-10T12:00:00Z')
  const used = await budget.record(['100', '101', '100'], firstDay)
  assert.equal(used.uniquePostsRead, 2)
  assert.equal(used.remainingPosts, 8)
  assert.equal((await readFile(path, 'utf8')).includes('secret'), false)
  const nextDay = await budget.snapshot(new Date('2026-08-11T00:00:01Z'))
  assert.equal(nextDay.uniquePostsRead, 0)
  assert.equal(nextDay.remainingPosts, 10)
})

test('fails closed instead of recording beyond the configured daily cap', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lolah-x-usage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const budget = new XDailyUsageBudget(join(directory, 'usage.json'), 10)
  await budget.record(Array.from({ length: 9 }, (_, index) => String(1_000 + index)))
  await assert.rejects(() => budget.record(['2000', '2001']), /exceeded/)
})
