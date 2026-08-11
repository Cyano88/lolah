import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildProofAnchorCalls } from '../src/xlayer-proof-anchors.js'

const evidence = JSON.parse(await readFile(resolve('artifacts/LolahProductionProofEvidence.json'), 'utf8')) as {
  ok?: unknown
  executionAllowed?: unknown
  signalProof?: {
    root?: unknown
    releaseHash?: unknown
    windowStart?: unknown
    windowEnd?: unknown
    signalCount?: unknown
    privacy?: unknown
  }
  deliveryProof?: { root?: unknown; deliveryCount?: unknown }
}
const deployment = JSON.parse(await readFile(
  resolve('artifacts/LolahSignalProofDeploymentReceipt.json'), 'utf8',
)) as { contractAddress?: unknown }
if (evidence.ok !== true || evidence.executionAllowed !== false
  || evidence.signalProof?.privacy !== 'no_recipient_or_message_content') {
  throw new Error('Production proof evidence is invalid.')
}
const calls = buildProofAnchorCalls({
  contractAddress: String(deployment.contractAddress ?? ''),
  signalRoot: String(evidence.signalProof.root ?? ''),
  releaseHash: String(evidence.signalProof.releaseHash ?? ''),
  windowStart: Number(evidence.signalProof.windowStart),
  windowEnd: Number(evidence.signalProof.windowEnd),
  signalCount: Number(evidence.signalProof.signalCount),
  deliveryRoot: String(evidence.deliveryProof?.root ?? ''),
  deliveryCount: Number(evidence.deliveryProof?.deliveryCount),
})
const outputPath = resolve('artifacts/LolahProofAnchorCalls.json')
await writeFile(outputPath, JSON.stringify(calls, null, 2) + '\n')
console.log(JSON.stringify({
  ok: true,
  chainId: calls.chainId,
  contractAddress: calls.contractAddress,
  signalRoot: calls.signal.root,
  deliveryRoot: calls.delivery.root,
  outputPath,
}))
