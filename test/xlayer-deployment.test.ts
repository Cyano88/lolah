import assert from 'node:assert/strict'
import test from 'node:test'
import { buildXLayerDeployment, XLAYER_CREATE2_FACTORY } from '../src/xlayer-deployment.js'

test('prepares deterministic factory calldata with the operator constructor argument', () => {
  const operator = '0x1111111111111111111111111111111111111111'
  const deployment = buildXLayerDeployment({ bytecode: '0x60006000', operator })
  assert.equal(deployment.chainId, 196)
  assert.equal(deployment.factory, XLAYER_CREATE2_FACTORY)
  assert.match(deployment.salt, /^0x[a-f0-9]{64}$/)
  assert.match(deployment.initCodeHash, /^0x[a-f0-9]{64}$/)
  assert.match(deployment.predictedAddress, /^0x[a-f0-9]{40}$/)
  assert.equal(deployment.calldata.endsWith(operator.slice(2).padStart(64, '0')), true)
})

test('changes the predicted address when constructor ownership changes', () => {
  const first = buildXLayerDeployment({
    bytecode: '0x60006000', operator: '0x1111111111111111111111111111111111111111',
  })
  const second = buildXLayerDeployment({
    bytecode: '0x60006000', operator: '0x2222222222222222222222222222222222222222',
  })
  assert.notEqual(first.predictedAddress, second.predictedAddress)
})
