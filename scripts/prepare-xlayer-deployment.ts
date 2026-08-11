import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  buildXLayerDeployment,
  XLAYER_CREATE2_FACTORY_RUNTIME,
} from '../src/xlayer-deployment.js'

const artifactPath = resolve('artifacts/LolahSignalProofRegistry.json')
const outputPath = resolve('artifacts/LolahSignalProofDeployment.json')
const operator = String(process.env.LOLAH_XLAYER_OPERATOR ?? '').trim()
const salt = String(process.env.LOLAH_XLAYER_DEPLOYMENT_SALT ?? '').trim() || undefined
const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
  bytecode?: unknown
  deployedBytecode?: unknown
  chain?: { chainId?: unknown }
}
if (artifact.chain?.chainId !== 196 || typeof artifact.bytecode !== 'string'
  || typeof artifact.deployedBytecode !== 'string') {
  throw new Error('Compiled Lolah X Layer artifact is invalid.')
}
const deployment = buildXLayerDeployment({ bytecode: artifact.bytecode, operator, salt })
const rpc = 'https://rpc.xlayer.tech'
async function rpcCall(method: string, params: unknown[]) {
  const response = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('X Layer RPC is unavailable.')
  const body = await response.json() as { result?: unknown; error?: unknown }
  if (body.error || typeof body.result !== 'string') throw new Error('X Layer RPC response is invalid.')
  return body.result.toLowerCase()
}
const factoryCode = await rpcCall('eth_getCode', [deployment.factory, 'latest'])
if (factoryCode !== XLAYER_CREATE2_FACTORY_RUNTIME) {
  throw new Error('Canonical X Layer CREATE2 factory bytecode does not match.')
}
const existingCode = await rpcCall('eth_getCode', [deployment.predictedAddress, 'latest'])
const state = existingCode === '0x' ? 'ready' : 'already_deployed'
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify({
  ...deployment,
  rpc,
  factoryVerified: true,
  state,
}, null, 2) + '\n')
console.log(JSON.stringify({
  ok: true,
  chainId: deployment.chainId,
  factory: deployment.factory,
  operator: deployment.operator,
  predictedAddress: deployment.predictedAddress,
  state,
  outputPath,
}))
