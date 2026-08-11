import sha3 from 'js-sha3'

function bytes32(value: string, label: string) {
  const normalized = String(value).trim().toLowerCase()
  if (!/^0x[a-f0-9]{64}$/.test(normalized)) throw new Error(label + ' is invalid.')
  return normalized.slice(2)
}

function uintWord(value: number, bits: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) >= 1n << BigInt(bits)) {
    throw new Error(label + ' is invalid.')
  }
  return value.toString(16).padStart(64, '0')
}

function selector(signature: string) {
  return sha3.keccak256(signature).slice(0, 8)
}

export function buildProofAnchorCalls(input: {
  contractAddress: string
  signalRoot: string
  releaseHash: string
  windowStart: number
  windowEnd: number
  signalCount: number
  deliveryRoot: string
  deliveryCount: number
}) {
  const contractAddress = String(input.contractAddress).trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(contractAddress)) throw new Error('Contract address is invalid.')
  const signalRoot = bytes32(input.signalRoot, 'Signal root')
  const releaseHash = bytes32(input.releaseHash, 'Release hash')
  const deliveryRoot = bytes32(input.deliveryRoot, 'Delivery root')
  if (input.windowStart > input.windowEnd) throw new Error('Signal window is invalid.')
  return {
    schema: 'lolah-xlayer-proof-anchor-calls-v1' as const,
    chainId: 196 as const,
    contractAddress,
    signal: {
      root: '0x' + signalRoot,
      calldata: '0x' + selector('anchorSignalBatch(bytes32,uint64,uint64,uint32,bytes32)')
        + signalRoot
        + uintWord(input.windowStart, 64, 'Signal window start')
        + uintWord(input.windowEnd, 64, 'Signal window end')
        + uintWord(input.signalCount, 32, 'Signal count')
        + releaseHash,
    },
    delivery: {
      root: '0x' + deliveryRoot,
      signalRoot: '0x' + signalRoot,
      calldata: '0x' + selector('anchorDeliveryBatch(bytes32,bytes32,uint32)')
        + deliveryRoot
        + signalRoot
        + uintWord(input.deliveryCount, 32, 'Delivery count'),
    },
  }
}
