import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OfficialOkxSubscriptionDirectory,
  OfficialOkxSubscriptionMessenger,
  type JsonCommandRunner,
} from '../src/official-okx-subscription.js'

test('intersects active jobs with exact provider subscription metadata', async () => {
  const calls: string[][] = []
  const run: JsonCommandRunner = async (_executable, args) => {
    calls.push(args)
    if (args.includes('subscribe-active')) {
      return { ok: true, data: [
        { jobId: 'job_live', status: 1 },
        { jobId: 'job_closed', status: 6 },
      ] }
    }
    return { ok: true, data: { list: [
      {
        jobId: 'job_live', providerAgentId: '9001', buyerAgentId: '7001',
        serviceName: 'Lolah Market Watch',
      },
      {
        jobId: 'job_unrelated', providerAgentId: '9001', buyerAgentId: '7002',
        serviceName: 'Lolah Market Watch',
      },
      {
        jobId: 'job_live', providerAgentId: '5427', buyerAgentId: '7003',
        serviceName: 'Lolah Market Watch',
      },
    ] } }
  }
  const directory = new OfficialOkxSubscriptionDirectory(run, 'onchainos-fixture')
  assert.deepEqual(await directory.listActive('9001', 'Lolah Market Watch'), [{
    jobId: 'job_live', providerAgentId: '9001', buyerAgentId: '7001',
    serviceName: 'Lolah Market Watch',
  }])
  assert.deepEqual(calls, [
    ['agent', 'subscribe-active', '--agent-id', '9001'],
    ['agent', 'my-subscriptions', '--role', 'provider', '--status', 'ACTIVE'],
  ])
})

test('fails closed when official subscription responses are malformed', async () => {
  const run: JsonCommandRunner = async (_executable, args) => args.includes('subscribe-active')
    ? { ok: true, data: { unexpected: true } }
    : { ok: true, data: { list: [] } }
  const directory = new OfficialOkxSubscriptionDirectory(run)
  await assert.rejects(() => directory.listActive('9001', 'Lolah Market Watch'), /active subscription list/)
})

test('uses the official xmtp-send job and recipient eligibility path', async () => {
  const calls: Array<{ executable: string; args: string[] }> = []
  const run: JsonCommandRunner = async (executable, args) => {
    calls.push({ executable, args })
    return { ok: true, messageId: 'message_123' }
  }
  const messenger = new OfficialOkxSubscriptionMessenger(run, 'okx-a2a-fixture')
  assert.deepEqual(await messenger.send({
    jobId: 'job_123', toAgentId: '7001', message: 'Verified intelligence only.',
  }), { messageId: 'message_123' })
  assert.deepEqual(calls, [{
    executable: 'okx-a2a-fixture',
    args: [
      'xmtp-send', '--job-id', 'job_123', '--to-agent-id', '7001',
      '--message', 'Verified intelligence only.', '--json',
    ],
  }])
})
