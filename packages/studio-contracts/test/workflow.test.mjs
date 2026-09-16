import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlanTaskV1, isToolBatchInputV1, isAcyclicTaskGraph } from '../dist/index.js';
const task = { schemaVersion: 1, id: 'task:first', dependsOn: [], inputs: ['artifact:known'], artifacts: ['entity:expected'], readScopes: ['document:one'], writeScopes: [], verification: ['inspect:state'], budget: { toolCalls: 4, wallTimeMs: 2000 }, estimatedWorkMs: 100 };
const member = { id: 'read:first', toolId: 'scene.query', toolVersion: '1.0.0', arguments: {}, dependsOn: [], estimatedWorkMs: 100, onFailure: 'cancel-dependents' };
test('workflow contracts validate versions, bounded budgets, graph identity and secret-bearing extra fields', () => {
  assert.ok(isPlanTaskV1(task));
  for (const invalid of [{ ...task, schemaVersion: 2 }, { ...task, apiKey: 'fixture-secret' }, { ...task, budget: { ...task.budget, toolCalls: -1 } }, { ...task, dependsOn: ['task:x', 'task:x'] }]) assert.equal(isPlanTaskV1(invalid), false);
  const batch = { schemaVersion: 1, nodes: [member] }; assert.ok(isToolBatchInputV1(batch));
  for (const invalid of [{ ...batch, schemaVersion: 2 }, { ...batch, authorization: 'fixture-secret' }, { ...batch, nodes: [{ ...member, executionClass: 'parallel-read' }] }, { ...batch, nodes: [member, member] }, { ...batch, nodes: [{ ...member, dependsOn: ['read:missing'] }] }]) assert.equal(isToolBatchInputV1(invalid), false);
  assert.ok(isAcyclicTaskGraph([{ id: 'first', dependsOn: ['last'] }, { id: 'last', dependsOn: [] }]));
  assert.equal(isAcyclicTaskGraph([{ id: 'first', dependsOn: ['last'] }, { id: 'last', dependsOn: ['first'] }]), false);
});

test('published workflow schemas stay identical to the provider schemas', async () => {
  const { readFile } = await import('node:fs/promises');
  const { PLAN_TASK_SCHEMA, TOOL_BATCH_INPUT_SCHEMA } = await import('../dist/index.js');
  for (const [name, expected] of [['plan-task', PLAN_TASK_SCHEMA], ['tool-batch-input', TOOL_BATCH_INPUT_SCHEMA]]) {
    const { $id, $schema, ...actual } = JSON.parse(await readFile(new URL(`../../../config/contracts/schemas/w6-${name}.schema.json`, import.meta.url), 'utf8'));
    assert.deepEqual(actual, expected); assert.equal($id, `haiyue://contracts/${name}/v1`);
  }
});
