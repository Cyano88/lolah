import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import solc from 'solc'

const sourcePath = resolve('contracts/LolahSignalProofRegistry.sol')
const outputPath = resolve('artifacts/LolahSignalProofRegistry.json')
const input = {
  language: 'Solidity',
  sources: {
    'LolahSignalProofRegistry.sol': { content: await readFile(sourcePath, 'utf8') },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
}
const compiled = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: Array<{ severity: string; formattedMessage: string }>
  contracts?: Record<string, Record<string, {
    abi: unknown[]
    evm: { bytecode: { object: string }; deployedBytecode: { object: string } }
  }>>
}
const failures = compiled.errors?.filter(error => error.severity === 'error') ?? []
if (failures.length) throw new Error(failures.map(error => error.formattedMessage).join('\n'))
const contract = compiled.contracts?.['LolahSignalProofRegistry.sol']?.LolahSignalProofRegistry
if (!contract?.evm.bytecode.object) throw new Error('Lolah contract output is unavailable.')
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify({
  contractName: 'LolahSignalProofRegistry',
  compiler: solc.version(),
  chain: { name: 'X Layer', chainId: 196 },
  abi: contract.abi,
  bytecode: '0x' + contract.evm.bytecode.object,
  deployedBytecode: '0x' + contract.evm.deployedBytecode.object,
}, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, outputPath, compiler: solc.version(), chainId: 196 }))
