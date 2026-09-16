import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_AUTHORING_TOOL_DEFINITIONS as definitions } from '@haiyue/ai-studio-game-authoring-tools';
import { toolSetSignature } from '@haiyue/ai-studio-agent-runtime';
import { toolConcurrencyHint, invocationConcurrencyHint } from '../dist/tool-concurrency.js';
import { StudioConversationHost } from '../dist/conversation-host.js';

test('only registry-approved observations get parallel hints, including omitted invoke targets', () => {
  const byId = id => definitions.find(item => item.id === id);
  for (const id of ['scene.query', 'engine.docs.search', 'component.describe', 'project.snapshot']) assert.equal(toolConcurrencyHint(byId(id)).mode, 'parallel-read');
  for (const id of ['entity.create', 'script.get', 'script.propose', 'script.apply', 'play.start', 'play.inspect', 'play.input', 'studio.plan.propose', 'missing.tool']) assert.equal(toolConcurrencyHint(byId(id)).mode, 'exclusive');
  for (const patch of [{ requiresApproval: true }, { concurrencySafe: false }, { effect: 'trusted-code' }]) assert.equal(toolConcurrencyHint({ ...byId('scene.query'), ...patch }).mode, 'exclusive');
  const invoke = invocationConcurrencyHint(definitions);
  assert.ok(invoke.targets.some(item => item.toolId === 'scene.query' && item.toolVersion === '1.0.0'));
  assert.ok(!invoke.targets.some(item => item.toolId === 'script.apply' || item.toolId === 'play.inspect'));
  assert.deepEqual(invocationConcurrencyHint([...definitions].reverse()), invoke);
});

test('Host regenerates safety hints from current registry and safety changes invalidate the session contract', async () => {
  let current = definitions;
  const host = new StudioConversationHost({ runtime: {}, operationLog: { async append() {} }, tools: { definitions: () => current, selectDefinitions: () => ({ definitions: definitions.filter(tool => tool.id === 'tool.search') }) } });
  try {
    const before = await host.taskModelTools('task:concurrency', 'backend:concurrency', 'inspect');
    assert.equal(before.find(tool => tool.id === 'studio.plan.propose').concurrency.mode, 'exclusive');
    assert.equal(before.find(tool => tool.id === 'studio.tool.invoke').concurrency.mode, 'invoke');
    current = definitions.map(tool => tool.id === 'scene.query' ? { ...tool, concurrencySafe: false } : tool);
    const after = await host.taskModelTools('task:concurrency', 'backend:concurrency', 'continue');
    assert.notEqual(toolSetSignature(before), toolSetSignature(after), 'omitted target safety changes must also rebind');
    assert.ok(!after.find(tool => tool.id === 'studio.tool.invoke').concurrency.targets.some(target => target.toolId === 'scene.query'));
  } finally { await host.dispose(); }
});
