import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  LolahActiveSubscriber,
  LolahSubscriptionDirectory,
  LolahSubscriptionMessenger,
} from './subscription-push.js'

const execFileAsync = promisify(execFile)
type JsonRecord = Record<string, unknown>

export type JsonCommandRunner = (executable: string, args: string[]) => Promise<unknown>

function record(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

export async function runJsonCommand(executable: string, args: string[]) {
  const result = await execFileAsync(executable, args, {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  })
  const parsed: unknown = JSON.parse(result.stdout)
  if (!record(parsed) || parsed.ok !== true) throw new Error('Official OKX command was unsuccessful.')
  return parsed
}

function data(value: unknown) {
  if (!record(value) || value.ok !== true || !record(value.data)) throw new Error('Official OKX response is invalid.')
  return value.data
}

function providerList(value: unknown) {
  const payload = data(value)
  if (!Array.isArray(payload.list)) throw new Error('Official provider subscription list is invalid.')
  return payload.list.filter(record)
}

function activeList(value: unknown) {
  if (!record(value) || value.ok !== true || !Array.isArray(value.data)) {
    throw new Error('Official active subscription list is invalid.')
  }
  return value.data.filter(record)
}

export class OfficialOkxSubscriptionDirectory implements LolahSubscriptionDirectory {
  constructor(
    private readonly run: JsonCommandRunner = runJsonCommand,
    private readonly onchainosExecutable = process.env.LOLAH_ONCHAINOS_BIN || 'onchainos',
  ) {}

  async listActive(providerAgentId: string, serviceName: string, serviceId?: string): Promise<LolahActiveSubscriber[]> {
    const [activeResponse, providedResponse] = await Promise.all([
      this.run(this.onchainosExecutable, ['agent', 'subscribe-active', '--agent-id', providerAgentId]),
      this.run(this.onchainosExecutable, ['agent', 'my-subscriptions', '--role', 'provider', '--status', 'ACTIVE']),
    ])
    const activeIds = new Set(activeList(activeResponse)
      .filter(item => Number(item.status) === 1)
      .map(item => text(item.jobId))
      .filter(Boolean))
    const result: LolahActiveSubscriber[] = []
    for (const item of providerList(providedResponse)) {
      const jobId = text(item.jobId ?? item.subId ?? item.id)
      const buyerAgentId = text(item.buyerAgentId ?? item.userAgentId)
      const title = text(item.serviceName ?? item.jobTitle ?? item.title)
      const returnedServiceId = text(item.serviceId)
      const returnedProviderId = text(item.providerAgentId ?? item.aspAgentId)
      const exactServiceId = Boolean(serviceId && returnedServiceId && returnedServiceId === serviceId)
      const exactKnownTitle = title === serviceName || title === serviceName + ' subscription'
      if (!activeIds.has(jobId) || !buyerAgentId || (!exactServiceId && !exactKnownTitle)) continue
      if (serviceId && returnedServiceId && returnedServiceId !== serviceId) continue
      if (returnedProviderId && returnedProviderId !== providerAgentId) continue
      result.push({
        jobId, buyerAgentId, providerAgentId, serviceName,
        ...(returnedServiceId ? { serviceId: returnedServiceId } : {}),
      })
    }
    return result
  }
}

export class OfficialOkxSubscriptionMessenger implements LolahSubscriptionMessenger {
  constructor(
    private readonly run: JsonCommandRunner = runJsonCommand,
    private readonly a2aExecutable = process.env.LOLAH_OKX_A2A_BIN || 'okx-a2a',
  ) {}

  async send(input: {
    jobId: string
    toAgentId: string
    providerAgentId: string
    message: string
  }) {
    const response = await this.run(this.a2aExecutable, [
      'xmtp-send', '--job-id', input.jobId, '--to-agent-id', input.toAgentId,
      '--session-agent-id', input.providerAgentId,
      '--message', input.message, '--json',
    ])
    if (!record(response)) throw new Error('Official OKX delivery response is invalid.')
    const messageId = text(response.messageId)
      || (record(response.data) ? text(response.data.messageId) : '')
    if (!messageId) throw new Error('Official OKX delivery did not return a messageId.')
    return { messageId }
  }
}
