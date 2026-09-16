import test from 'node:test';
import assert from 'node:assert/strict';
import { projectToolModelResult, compactNativeToolSchemas } from '../dist/conversation-presentation.js';

const schema = { type: 'object', properties: { entityId: { type: 'string', description: 'Native contract detail. '.repeat(100) } } };
const match = (id, inputSchema = schema) => ({ kind: 'tool', id, version: '1.0.0', inputSchema, nextTool: id, invocation: { tool: 'tool.invoke', toolId: id, toolVersion: '1.0.0' } });
test('catalog projection removes only identical native schemas and keeps discovery invocation and pagination', () => {
  const result = { status: 'completed', documentId: 'document:w4', beforeRevision: 7, afterRevision: 7, value: { matches: [match('scene.query'), match('entity.create'), match('script.get', { type: 'object' })], nextCursor: 'cursor:next', total: 3 } };
  const compacted = compactNativeToolSchemas(result, 'tool.search', [{ id: 'scene.query', inputSchema: schema }, { id: 'script.get', inputSchema: schema }]);
  assert.equal(compacted.value.matches[0].inputSchema, undefined);
  assert.equal(compacted.value.matches[0].schemaSource, 'native-tool');
  assert.deepEqual(compacted.value.matches[0].invocation, result.value.matches[0].invocation);
  assert.deepEqual(compacted.value.matches[1], result.value.matches[1], 'omitted tools still need complete schemas');
  assert.deepEqual(compacted.value.matches[2], result.value.matches[2], 'schema drift must remain explicit');
  assert.equal(compacted.value.nextCursor, 'cursor:next'); assert.equal(compacted.afterRevision, 7);
  assert.ok(JSON.stringify(compacted).length < JSON.stringify(result).length * .7);
  assert.equal(compactNativeToolSchemas(result, 'tool.search', []), result);
  assert.equal(compactNativeToolSchemas(result, 'scene.query', [{ id: 'scene.query', inputSchema: schema }]), result);
});

test('projection hints preserve the complete next-step contract, source, evidence and diagnostics', () => {
  const cases = [
    ['entity.create', { entity: { id: 'entity:new', parentId: 'entity:parent', transform: { position: [1, 2, 3] } }, revision: 8 }],
    ['scene.query', { entities: [{ id: 'entity:one' }], nextCursor: 'cursor:2', truncated: true, revision: 8 }],
    ['script.propose', { proposalId: 'proposal:new', scriptId: 'script:one', entityId: 'entity:one', baseRevision: 8, canApply: false, diagnostics: [{ line: 42, code: 'syntax', message: 'Fix this line.' }] }],
    ['script.get', { script: { id: 'script:one', text: 'const source = 42;\n'.repeat(1000), textRevision: 3 }, digest: 'digest:source' }],
    ['play.inspect', { observation: { id: 'artifact:evidence' }, projection: { state: { entities: [{ id: 'entity:one' }] } }, projectionTruncated: false }],
    ['custom.unknown', { identity: 'must-retain', futureRequiredField: ['exact', 'values'] }],
  ];
  for (const [toolId, value] of cases) for (const projection of ['summary', 'digest-only']) {
    const original = { status: 'completed', documentId: 'document:w4', beforeRevision: 7, afterRevision: 8, value, transaction: { receiptArtifactId: 'artifact:receipt', transactionId: 'transaction:w4' } };
    assert.deepEqual(projectToolModelResult(original, projection, toolId), original);
  }
});
