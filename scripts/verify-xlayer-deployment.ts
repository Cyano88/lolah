import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sha3 from 'js-sha3'

const artifactPath = resolve('artifacts/LolahSignalProofRegistry.json')
const manifestPath = resolve('artifacts/LolahSignalProofDeployment.json')
const outputPath = resolve('artifacts/LolahSignalProofDeploymentReceipt.json')
const txHash = String(process.env.LOLAH_XLAYER_DEPLOYMENT_TX ?? '').trim().toLowerCase()
if (!/^0x[a-f0-9]{64}$/.test(txHash)) throw new Error('Deployment transaction hash is invalid.')
const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as { deployedBytecode?: unknown }
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  factory?: unknown
  operator?: unknown
  predictedAddress?: unknown
}
if (typeof artifact.deployedBytecode !== 'string' || typeof manifest.factory !== 'string'
  || typeof manifest.operator !== 'string' || typeof manifest.predictedAddress !== 'string') {
  throw new Error('Lolah deployment artifacts are invalid.')
}
const rpc = 'https://rpc.xlayer.tech'
async function rpcCall(method: string, params: unknown[]) {
  const response = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('X Layer RPC is unavailable.')
  const body = await response.json() as { result?: unknown; error?: unknown }
  if (body.error || body.result === undefined || body.result === null) {
    throw new Error('X Layer RPC response is invalid.')
  }
  return body.result
}
const [receiptValue, codeValue, operatorValue] = await Promise.all([
  rpcCall('eth_getTransactionReceipt', [txHash]),
  rpcCall('eth_getCode', [manifest.predictedAddress, 'latest']),
  rpcCall('eth_call', [{
    to: manifest.predictedAddress,
    data: '0x' + sha3.keccak256('operator()').slice(0, 8),
  }, 'latest']),
])
const receipt = receiptValue as {
  status?: unknown
  transactionHash?: unknown
  blockNumber?: unknown
}
const code = String(codeValue).toLowerCase()
const operatorWord = String(operatorValue).toLowerCase()
const operator = '0x' + operatorWord.slice(-40)
if (receipt.status !== '0x1' || String(receipt.transactionHash).toLowerCase() !== txHash) {
  throw new Error('Deployment transaction receipt does not match the prepared manifest.')
}
if (code !== artifact.deployedBytecode.toLowerCase()) {
  throw new Error('Deployed Lolah runtime bytecode does not match the compiled artifact.')
}
if (operator !== manifest.operator.toLowerCase()) {
  throw new Error('Deployed Lolah operator does not match the prepared manifest.')
}
const verified = {
  schema: 'lolah-xlayer-deployment-receipt-v1',
  chainId: 196,
  transactionHash: txHash,
  contractAddress: manifest.predictedAddress.toLowerCase(),
  operator,
  blockNumber: String(receipt.blockNumber),
  runtimeBytecodeMatch: true,
  operatorMatch: true,
}
await writeFile(outputPath, JSON.stringify(verified, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, ...verified, outputPath }))
