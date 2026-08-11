import sha3 from 'js-sha3'

const { keccak256 } = sha3

export const XLAYER_CREATE2_FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c'
export const XLAYER_CREATE2_FACTORY_RUNTIME =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'

function hex(value: string, label: string, bytes?: number) {
  const normalized = String(value).trim().toLowerCase()
  if (!/^0x[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0
    || (bytes !== undefined && normalized.length !== 2 + bytes * 2)) {
    throw new Error(label + ' is invalid.')
  }
  return normalized
}

export function buildXLayerDeployment(input: {
  bytecode: string
  operator: string
  salt?: string
}) {
  const bytecode = hex(input.bytecode, 'Contract bytecode')
  if (bytecode === '0x') throw new Error('Contract bytecode is empty.')
  const operator = hex(input.operator, 'Operator address', 20)
  if (operator === '0x' + '0'.repeat(40)) throw new Error('Operator address is zero.')
  const salt = input.salt
    ? hex(input.salt, 'Deployment salt', 32)
    : '0x' + keccak256('lolah-signal-proof-registry-v1')
  const constructorWord = operator.slice(2).padStart(64, '0')
  const initCode = bytecode + constructorWord
  const initCodeHash = '0x' + keccak256(Buffer.from(initCode.slice(2), 'hex'))
  const create2Input = Buffer.from(
    'ff' + XLAYER_CREATE2_FACTORY.slice(2) + salt.slice(2) + initCodeHash.slice(2),
    'hex',
  )
  const predictedAddress = '0x' + keccak256(create2Input).slice(-40)
  return {
    schema: 'lolah-xlayer-deployment-v1' as const,
    chainId: 196 as const,
    factory: XLAYER_CREATE2_FACTORY,
    operator,
    salt,
    initCodeHash,
    predictedAddress,
    calldata: salt + initCode.slice(2),
  }
}
