import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { normalizeConversationNode } from '@haiyue/ai-studio-shell/conversation';
import { StudioConversationHost } from '../dist/conversation-host.js';

const provenance = { backendId: 'backend:w5', sessionId: 'session:w5', turnId: 'turn:w5' };
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'w5-projections-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'test', flushPolicy: 'always' });
  const host = new StudioConversationHost({ runtime: {}, tools: {}, operationLog: log, ...options });
  t.after(async () => { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); });
  return { host, log };
}

test('identical TaskRun patches have no revision, notification or durable-write cost; timeline facts remain', async t => {
  const { host, log } = await fixture(t);
  host.taskRuns.set('task:w5', { taskId: 'task:w5', schemaVersion: 1, revision: 1, sessionId: null, turnId: null, status: 'running', phase: 'planning', evidence: [], timeline: [] });
  let changes = 0; host.subscribe(() => changes++);
  for (let i = 0; i < 100; i++) host.updateTaskRun('task:w5', { sessionId: 'session:w5', turnId: 'turn:w5', evidence: [] });
  await host.flushRecords();
  assert.equal(changes, 1); assert.equal(host.taskRuns.get('task:w5').revision, 2);
  assert.equal((await log.query({ kinds: ['conversation/task-projected'], limit: 100 })).events.length, 1);
  host.updateTaskRun('task:w5', {}, { phase: 'planning', status: 'warning', title: 'Budget checkpoint', detail: 'Must remain durable.' });
  await host.flushRecords();
  assert.equal((await log.query({ kinds: ['conversation/task-projected'], limit: 100 })).events.length, 2);
});

test('100 live text updates use two durable projections with terminal recovery and full execution data', async t => {
  const { host, log } = await fixture(t, { recordProjectId: 'project:w5' });
  for (let i = 1; i <= 100; i++) host.project('text:w5', 'text', 'streaming', provenance, { text: '字'.repeat(i), role: 'assistant' });
  assert.equal(host.events.length, 100);
  host.project('text:w5', 'text', 'completed', provenance, { text: '字'.repeat(100), role: 'assistant' });
  await host.flushRecords();
  const page = await log.query({ kinds: ['conversation/node-projected', 'agent/execution-record'], limit: 100 });
  assert.equal(page.events.filter(e => e.kind === 'conversation/node-projected').length, 2);
  assert.equal(page.events.filter(e => e.kind === 'agent/execution-record').length, 2);
  const restored = new StudioConversationHost({ runtime: {}, tools: {}, operationLog: log });
  await restored.restoreProjection();
  assert.equal(restored.nodes.get('text:w5').content.text, '字'.repeat(100));
  assert.equal(restored.nodes.get('text:w5').status, 'completed');
  await restored.dispose();
});

test('dispose flushes an unfinished text checkpoint and fallback persists every delta', async t => {
  for (const batchTextWrites of [true, false]) {
    const { host, log } = await fixture(t, { batchTextWrites });
    for (let i = 1; i <= 4; i++) host.project('text:w5', 'text', 'streaming', provenance, { text: 'x'.repeat(i) });
    await host.dispose();
    const page = await log.query({ kinds: ['conversation/node-projected'], limit: 100 });
    assert.equal(page.events.length, batchTextWrites ? 2 : 5);
    const terminal = (await log.readArtifact(page.events.at(-1).artifactRefs[0])).value;
    assert.equal(terminal.content.text, 'xxxx'); assert.equal(terminal.status, 'cancelled');
  }
});

test('only a successful changed document revision marks a result for editor refresh', async t => {
  const { host } = await fixture(t);
  for (const [status, beforeRevision, afterRevision, expected] of [
    ['completed', 4, 4, false], ['completed', 4, 5, true], ['failed', 4, 5, false], ['completed', undefined, undefined, false],
  ]) {
    const body = { backendResult: { status, beforeRevision, afterRevision, documentId: 'document:w5' } };
    const content = host.executionContent({}, body, { toolCallId: 'call:w5' });
    const projected = normalizeConversationNode({ schemaVersion: 1, id: 'result:w5', kind: 'tool-result', status, createdAt: new Date().toISOString(), provenance, content });
    assert.equal(projected.content.documentChanged, expected);
    if (typeof afterRevision === 'number') assert.equal(projected.content.documentRevision, afterRevision);
    assert.equal(content.documentId, 'document:w5');
  }
});

test('tool boundaries wait for text checkpoints only, without joining unrelated history writes', async t => {
  const { host } = await fixture(t);
  let release;
  host.projectionWriteTail = new Promise(resolve => { release = resolve; });
  try {
    let settled = false;
    void host.flushTextRecords().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'a tool with no text must not wait for the history queue');
    host.project('text:boundary', 'text', 'streaming', provenance, { text: 'Checkpoint before tool.' });
    settled = false;
    const boundary = host.flushTextRecords().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'pending text still requires durable ordering');
    release(); await boundary;
  } finally { release(); }
});
