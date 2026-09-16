import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { GAME_AUTHORING_TOOL_DEFINITIONS, ToolCatalogRuntime } from '@haiyue/ai-studio-game-authoring-tools';
import { PromptContextRuntime, toolSetSignature } from '@haiyue/ai-studio-agent-runtime';
import { StudioConversationHost } from '../dist/conversation-host.js';
import { approvedPlanRequest } from '../dist/plan-policy.js';

test('task tools survive plan/repair/reload without reranking; registry changes still invalidate provider reuse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-w1-tools-'));
  let log = await OperationLog.open({ rootDirectory: root, appVersion: 'w1-test' });
  let definitions = GAME_AUTHORING_TOOL_DEFINITIONS;
  const catalog = new ToolCatalogRuntime(definitions, () => []);
  const queries = [];
  const tools = { definitions: () => definitions, selectDefinitions(request) { queries.push(request); return catalog.selectDefinitions(request); } };
  const host = () => new StudioConversationHost({ runtime: {}, tools, operationLog: log });
  const backendId = 'backend:w1';
  let first = host(); let restarted;
  try {
    for (const [index, goal] of ['把选中的立方体改成蓝色', '给按钮加一个自身呼吸动画', '修复拖拽物体时相机也跟随旋转的问题'].entries()) {
      const taskId = `task:w1:${index}`;
      const initial = await first.taskModelTools(taskId, backendId, goal);
      const plan = approvedPlanRequest({ title: goal, summary: goal, items: [{ id: 'step:w1', label: goal, details: goal }], attempts: 0, mutationCount: 0 }, true);
      const continued = await first.taskModelTools(taskId, backendId, plan);
      assert.equal(toolSetSignature(continued), toolSetSignature(initial));
      assert.ok(continued.some(tool => tool.id === 'studio.tool.invoke'));
      assert.ok(!continued.find(tool => tool.id === 'project.snapshot').description.includes('Inspect this before planning'));
    }
    assert.deepEqual(queries, ['把选中的立方体改成蓝色', '给按钮加一个自身呼吸动画', '修复拖拽物体时相机也跟随旋转的问题']);
    const before = await first.taskModelTools('task:w1:1', backendId, 'ignored repair guidance');
    await first.dispose(); await log.close();
    log = await OperationLog.open({ rootDirectory: root, appVersion: 'w1-test' });
    restarted = host();
    restarted.taskRuns.set('task:w1:1', { taskId: 'task:w1:1' });
    await restarted.restoreTaskToolSelections();
    const recovered = await restarted.taskModelTools('task:w1:1', backendId, 'truncated original request');
    assert.equal(toolSetSignature(recovered), toolSetSignature(before));
    assert.equal(queries.length, 3, 'restart uses durable IDs rather than shortened task text');
    definitions = [...definitions].reverse();
    assert.equal(toolSetSignature(await restarted.taskModelTools('task:w1:1', backendId, 'ignored')), toolSetSignature(before), 'native names must remain stable when registry enumeration order changes');
    const context = new PromptContextRuntime(log);
    const input = { conversationKey: 'conversation:w1', backendId, taskId: 'task:w1:1', request: 'continue', tools: recovered, project: null };
    await context.prepare(input);
    await context.commit({ ...input, sessionId: 'session:w1', turnId: 'turn:w1', projectId: null });
    assert.equal((await context.prepare(input)).reusedSessionId, 'session:w1');
    definitions = definitions.map(definition => definition.id === 'project.snapshot' ? { ...definition, version: '2.0.0' } : definition);
    const upgraded = await restarted.taskModelTools('task:w1:1', backendId, 'ignored');
    assert.notEqual(toolSetSignature(upgraded), toolSetSignature(recovered));
    assert.equal((await context.prepare({ ...input, tools: upgraded })).reusedSessionId, null);
    definitions = definitions.filter(definition => definition.id !== 'project.snapshot');
    const removed = await restarted.taskModelTools('task:w1:1', backendId, 'ignored');
    assert.ok(!removed.some(tool => tool.id === 'project.snapshot'), 'durable IDs cannot resurrect removed tools');
    await restarted.taskModelTools('task:w1:new', backendId, 'new task');
    await restarted.taskModelTools('task:w1:1', 'backend:other', 'other backend');
    assert.deepEqual(queries.slice(-2), ['new task', 'other backend']);
  } finally { await first.dispose(); await restarted?.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});

test('unknown-version, duplicate and invalid durable selections do not override current selection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-w1-invalid-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'w1-test' });
  const host = new StudioConversationHost({ runtime: {}, tools: { definitions: () => GAME_AUTHORING_TOOL_DEFINITIONS }, operationLog: log });
  try {
    host.taskRuns.set('task:invalid', { taskId: 'task:invalid' });
    for (const payload of [
      { schemaVersion: 2, taskId: 'task:invalid', backendId: 'backend:w1', toolIds: ['project.snapshot'] },
      { schemaVersion: 1, taskId: 'task:invalid', backendId: 'backend:w1', toolIds: ['project.snapshot', 'project.snapshot'] },
      { schemaVersion: 1, taskId: 'task:invalid', backendId: 'backend:w1', toolIds: [null] },
      { schemaVersion: 1, taskId: 'task:invalid', backendId: 'backend:w1', toolIds: [] },
    ]) await log.append({ kind: 'conversation/task-tools-selected', severity: 'info', source: 'test:w1', payload });
    await host.restoreTaskToolSelections();
    assert.equal(host.taskToolSelections.size, 0);
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});
