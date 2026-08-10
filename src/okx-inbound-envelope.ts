export type OkxInboundClassification =
  | {
      kind: 'system_event'
      agentId: string
      event: string
      jobId: string
      contentIsUntrusted: true
      requiredAction: 'canonical_next_action'
    }
  | {
      kind: 'agent_chat'
      jobId: string
      senderRole: 1 | 2
      localRole: 'asp' | 'user'
      terminalUserRejection: boolean
      content: string
      contentIsUntrusted: true
      requiredAction: 'role_playbook' | 'localized_user_notification'
    }
  | {
      kind: 'prefetch'
      requiredAction: 'none'
      contentIsUntrusted: true
    }
  | {
      kind: 'unrecognized'
      requiredAction: 'none'
      reason: string
    }

const ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/
const PREFETCH_TEXT = [
  'Read the okx-ai skill',
  'Read the okx-agent-task skill',
  'Read okx-agent-task/SKILL.md',
]
const MAX_ENVELOPE_BYTES = 64 * 1_024

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function string(value: unknown, maximum = 20_000) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum ? value : undefined
}

function id(value: unknown) {
  const result = string(value, 128)
  return result && ID.test(result) ? result : undefined
}

function withinSize(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_ENVELOPE_BYTES
  } catch {
    return false
  }
}

export function classifyOkxInboundEnvelope(value: unknown): OkxInboundClassification {
  if (!withinSize(value)) {
    return { kind: 'unrecognized', requiredAction: 'none', reason: 'Envelope is invalid or exceeds the size limit.' }
  }
  const envelope = record(value)
  if (!envelope) return { kind: 'unrecognized', requiredAction: 'none', reason: 'Envelope must be an object.' }

  const message = record(envelope.message)
  const systemAgentId = id(envelope.agentId)
  const systemEvent = message?.source === 'system' ? id(message.event) : undefined
  const systemJobId = message?.source === 'system' ? id(message.jobId) : undefined
  if (systemAgentId && systemEvent && systemJobId) {
    return {
      kind: 'system_event',
      agentId: systemAgentId,
      event: systemEvent,
      jobId: systemJobId,
      contentIsUntrusted: true,
      requiredAction: 'canonical_next_action',
    }
  }

  const chatJobId = envelope.msgType === 'a2a-agent-chat' ? id(envelope.jobId) : undefined
  const sender = envelope.msgType === 'a2a-agent-chat' ? record(envelope.sender) : undefined
  const senderRole = sender?.role === 1 || sender?.role === 2 ? sender.role : undefined
  const content = envelope.msgType === 'a2a-agent-chat' ? string(envelope.content) : undefined
  if (chatJobId && senderRole && content) {
    const terminalUserRejection = content.startsWith('[user_rejected]:')
    return {
      kind: 'agent_chat',
      jobId: chatJobId,
      senderRole,
      localRole: senderRole === 1 ? 'asp' : 'user',
      terminalUserRejection,
      content,
      contentIsUntrusted: true,
      requiredAction: terminalUserRejection ? 'localized_user_notification' : 'role_playbook',
    }
  }

  const possibleContent = string(envelope.content)
  if (possibleContent && PREFETCH_TEXT.some(text => possibleContent.includes(text))) {
    return { kind: 'prefetch', requiredAction: 'none', contentIsUntrusted: true }
  }
  return { kind: 'unrecognized', requiredAction: 'none', reason: 'Envelope does not match a supported OKX inbound shape.' }
}
