import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_AUTHORING_TOOL_DEFINITIONS, MODEL_TOOL_INVOKE_DEFINITION, ToolCatalogRuntime, resolveModelToolInvocation, normalizeToolBatchRequest } from '../dist/index.js';

const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => []);
const invocation = (toolId, args = {}) => ({ toolId, toolVersion: '1.0.0', arguments: args });

test('search returns an exact executable route for tools omitted from the initial native surface', () => {
  const selection = catalog.selectDefinitions('做一个俄罗斯方块游戏');
  for (const toolId of ['script.apply', 'play.start', 'play.input']) {
    assert.ok(!selection.selectedIds.includes(toolId));
    const match = catalog.search(toolId, { includeSchemas: true, limit: 1 })[0];
    assert.equal(match.id, toolId);
    assert.deepEqual(match.invocation, { tool: MODEL_TOOL_INVOKE_DEFINITION.id, toolId, toolVersion: match.version });
    assert.deepEqual(match.inputSchema, GAME_AUTHORING_TOOL_DEFINITIONS.find(tool => tool.id === toolId).inputSchema);
    if (toolId !== 'play.input') assert.ok(match.inputSchema.required.includes('baseRevision'));
    assert.equal(resolveModelToolInvocation(invocation(match.invocation.toolId), GAME_AUTHORING_TOOL_DEFINITIONS).toolId, toolId);
  }
  assert.equal(catalog.search('script.apply', { limit: 1 })[0].invocation, undefined, 'compact search must still require schema expansion');
});

test('invocation rejects unregistered, recursive, stale, malformed and policy-forging targets', () => {
  for (const toolId of ['shell.exec', 'studio.tool.invoke', 'studio.plan.propose']) {
    assert.throws(() => resolveModelToolInvocation(invocation(toolId), GAME_AUTHORING_TOOL_DEFINITIONS), { code: 'tool.not-found' });
  }
  assert.throws(() => resolveModelToolInvocation({ ...invocation('script.apply'), toolVersion: '9.0.0' }, GAME_AUTHORING_TOOL_DEFINITIONS), { code: 'tool.version-mismatch' });
  for (const value of [null, [], { ...invocation('script.apply'), effect: 'observe' }, { ...invocation('script.apply'), arguments: [] }, { toolId: 'script.apply', arguments: {} }, invocation('script.apply', { bad: Number.NaN })]) {
    assert.throws(() => resolveModelToolInvocation(value, GAME_AUTHORING_TOOL_DEFINITIONS), { code: 'tool.invocation-invalid' });
  }
});

test('resolved calls retain target revision, trusted-code/runtime barriers and immutable arguments', () => {
  const args = { baseRevision: 7, proposalId: 'script-proposal:fixture' };
  const resolved = resolveModelToolInvocation(invocation('script.apply', args), GAME_AUTHORING_TOOL_DEFINITIONS);
  args.baseRevision = 99;
  const batch = normalizeToolBatchRequest({ id: 'batch:invocation', sessionId: 'session:invocation', turnId: 'turn:invocation', calls: [{ toolCallId: 'call:apply', ...resolved }, { toolCallId: 'call:play', ...resolveModelToolInvocation(invocation('play.start', { baseRevision: 7, planId: 'preview-plan:fixture' }), GAME_AUTHORING_TOOL_DEFINITIONS) }] }, GAME_AUTHORING_TOOL_DEFINITIONS);
  assert.equal(batch.nodes[0].expectedRevision, 7);
  assert.equal(batch.nodes[0].executionClass, 'trusted-code-barrier');
  assert.ok(batch.nodes[0].effects.includes('approval'));
  assert.ok(batch.nodes[0].effects.includes('document-mutation'));
  assert.equal(batch.nodes[1].executionClass, 'runtime-barrier');
});
