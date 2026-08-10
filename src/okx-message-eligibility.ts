export type OkxMessageEligibilityInput = {
  clientAgentId: string
  providerAgentId: string
  jobId: string
  groupId: string
  direction: 'client_to_provider' | 'provider_to_client'
  providerSecurityRate?: string
  clientCommunicationAddress: string
  providerCommunicationAddress: string
  isOfflineReplay?: boolean
}

export type OkxMessageEligibilityChecker = (
  input: OkxMessageEligibilityInput,
) => Promise<unknown>

const ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/
const ADDRESS = /^0x[a-fA-F0-9]{40}$/

function validateInput(input: OkxMessageEligibilityInput): OkxMessageEligibilityInput {
  if (!input || !ID.test(String(input.clientAgentId ?? ''))
    || !ID.test(String(input.providerAgentId ?? ''))
    || !ID.test(String(input.jobId ?? ''))
    || !ID.test(String(input.groupId ?? ''))
    || !['client_to_provider', 'provider_to_client'].includes(input.direction)
    || !ADDRESS.test(String(input.clientCommunicationAddress ?? ''))
    || !ADDRESS.test(String(input.providerCommunicationAddress ?? ''))
    || (input.isOfflineReplay !== undefined && typeof input.isOfflineReplay !== 'boolean')) {
    throw new Error('OKX message eligibility input is invalid.')
  }
  if (input.providerSecurityRate !== undefined) {
    const rate = Number(input.providerSecurityRate)
    if (!/^\d(?:\.\d+)?$/.test(input.providerSecurityRate)
      || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error('OKX message eligibility input is invalid.')
    }
  }
  return {
    clientAgentId: input.clientAgentId,
    providerAgentId: input.providerAgentId,
    jobId: input.jobId,
    groupId: input.groupId,
    direction: input.direction,
    ...(input.providerSecurityRate !== undefined ? { providerSecurityRate: input.providerSecurityRate } : {}),
    clientCommunicationAddress: input.clientCommunicationAddress,
    providerCommunicationAddress: input.providerCommunicationAddress,
    ...(input.isOfflineReplay !== undefined ? { isOfflineReplay: input.isOfflineReplay } : {}),
  }
}

export async function checkOkxMessageEligibility(
  input: OkxMessageEligibilityInput,
  checker: OkxMessageEligibilityChecker,
) {
  const normalized = validateInput(input)
  try {
    const result = await checker(normalized)
    if (!result || typeof result !== 'object' || typeof (result as { eligible?: unknown }).eligible !== 'boolean') {
      throw new Error('invalid result')
    }
    return {
      eligible: (result as { eligible: boolean }).eligible,
      checkedOfflineReplay: normalized.isOfflineReplay === true,
    }
  } catch {
    throw new Error('OKX message eligibility check failed.')
  }
}
