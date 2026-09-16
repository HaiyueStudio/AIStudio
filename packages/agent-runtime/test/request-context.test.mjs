import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { PromptContextRuntime, RequestContextRuntime, DurableSessionRuntime } from '../dist/index.js';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'request-context-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'test' });
  t.after(async () => { await log.close(); await rm(root, { recursive: true, force: true }); });
  const prompts = new PromptContextRuntime(log);
  return { log, prompts, runtime: new RequestContextRuntime(log, prompts) };
}
const message = (id, role, text, toolCallIds = [], resultFor = null) => ({ id, role, text, toolCallIds, resultFor, toolName: role === 'tool' ? 'scene.query' : null });
const input = messages => ({ schemaVersion: 1, sessionId: 'session:request', turnId: 'turn:request', epoch: 0, model: 'fixture', maxInputTokens: 40_000, reservedOutputTokens: 1024, requestBytes: JSON.stringify(messages).length, previousUsage: null, messages, tools: [{ name: 'scene_query', parameters: { type: 'object' } }] });
const context = { conversationKey: 'conversation:request', backendId: 'backend:request', taskId: 'task:request', request: 'Keep target entity:one at revision 7; approval is required.', tools: [], project: null };

test('first request includes tool schemas, overhead and unknown capacity; 92% blocks before confirmation', async t => {
  const f = await fixture(t), port = f.runtime.port();
  await assert.rejects(port.prepare({ ...input([message('user:one', 'user', 'required '.repeat(30_000))]), maxInputTokens: 8000 }), /92%/);
  const unknown = await port.prepare({ ...input([message('user:unknown', 'user', 'required')]), maxInputTokens: null });
  await port.confirm(unknown.id);
  const records = await f.log.query({ kinds: ['agent/model-request-prepared'], limit: 10 });
  assert.equal(records.events.at(-1).payload.pressure.state, 'unknown');
  assert.equal(records.events.at(-1).payload.pressure.ratio, null);
  const artifact = await f.log.readArtifact(records.events.at(-1).payload.contextArtifactId);
  assert.ok(artifact.value.toolsArtifactId); assert.ok(artifact.value.messages[0].artifactId);
});
test('compaction hydrates references, retains current request and keeps native latest call/result pair outside replacement', async t => {
  const f = await fixture(t);
  const first = await f.prompts.prepare(context);
  await f.prompts.commit({ ...context, sessionId: 'session:request', turnId: 'turn:first', projectId: null });
  const next = await f.prompts.prepare({ ...context, request: 'Continue entity:one with exact revision 7.' });
  assert.match(next.prompt, /reference-only/);
  const messages = [message('user:initial', 'user', first.prompt), message('assistant:one', 'assistant', 'inspect', ['call:one']), message('tool:one', 'tool', 'old '.repeat(20_000), [], 'call:one'), message('user:next', 'user', next.prompt), message('assistant:two', 'assistant', 'latest', ['call:two']), message('tool:two', 'tool', 'entity:one revision=7', [], 'call:two')];
  const port = f.runtime.port();
  const prepared = await port.prepare(input(messages));
  assert.ok(prepared.replacement);
  assert.equal(prepared.replacement.throughMessageId, 'user:next');
  assert.doesNotMatch(prepared.replacement.summary, /reference-only/);
  assert.match(prepared.replacement.summary, /Work only through the supplied Studio tools/);
  assert.match(prepared.replacement.summary, /Continue entity:one/);
  const compacted = [message('user:summary', 'user', prepared.replacement.summary), ...messages.slice(-2)];
  const request = await port.prepare({ ...input(compacted), epoch: 1 });
  assert.equal(request.replacement, undefined);
  await port.confirm(request.id);
  const again = await f.prompts.prepare(context);
  assert.equal(again.reusedSessionId, 'session:request');
  assert.doesNotMatch(again.prompt, /reference-only/);
  const rebound = await f.prompts.prepare({ ...context, tools: [{ id: 'scene.query', description: 'new contract', inputSchema: { type: 'object' } }] });
  assert.equal(rebound.reusedSessionId, null); assert.match(rebound.prompt, /surfaceRecovery/);
  assert.equal((rebound.prompt.match(/Work only through the supplied Studio tools/g) ?? []).length, 1);
  const restarted = new PromptContextRuntime(f.log); await restarted.initialize();
  const recovered = await restarted.prepare(context);
  assert.match(recovered.prompt, /surfaceRecovery/); assert.doesNotMatch(recovered.prompt, /reference-only/);
});
test('usage calibrates the next request without treating billed history as context; failed preparation leaves reuse unchanged', async t => {
  const f = await fixture(t);
  const prepared = await f.prompts.prepare(context);
  await f.prompts.commit({ ...context, sessionId: 'session:request', turnId: 'turn:one', projectId: null });
  const request = input([message('user:one', 'user', prepared.prompt)]);
  const port = f.runtime.port();
  await assert.rejects(port.prepare({ ...request, previousUsage: { inputTokens: 38_000, requestBytes: request.requestBytes } }), /92%/);
  const next = await f.prompts.prepare(context); assert.match(next.prompt, /reference-only/);
  const safe = await port.prepare(request); await port.confirm(safe.id);
  const records = await f.log.query({ kinds: ['agent/model-request-prepared'], limit: 10 });
  assert.ok(records.events[0].payload.pressure.usedInputTokens >= 38_000);
  assert.ok(records.events[1].payload.pressure.usedInputTokens < 38_000);
});

test('manual Surface summary feeds the real request even below the automatic threshold', async t => {
  const f = await fixture(t), sessions = new DurableSessionRuntime(f.log);

  const handle = await sessions.create({ id: 'session:request', projectId: null, documentId: null, activeGoal: 'retain target', taskBudgetId: null });
  await handle.appendMessage({ role: 'user', content: 'original request' });
  await handle.appendMessage({ role: 'assistant', content: 'history '.repeat(1000) });
  const state = await handle.snapshot();
  await handle.replaceSurface({ startNodeId: state.surface.nodes[0].id, endNodeId: state.surface.nodes.at(-1).id, summary: 'MANUAL_SUMMARY: target entity:one; r7; approval still required.', reason: 'compaction' });
  const runtime = new RequestContextRuntime(f.log, f.prompts, sessions), port = runtime.port();
  const messages = [message('user:original', 'user', 'retain target'), message('assistant:old', 'assistant', 'old', ['call:old']), message('tool:old', 'tool', 'details '.repeat(5000), [], 'call:old'), message('assistant:new', 'assistant', 'new', ['call:new']), message('tool:new', 'tool', 'revision 7', [], 'call:new')];
  const prepared = await port.prepare({ ...input(messages), maxInputTokens: 1_000_000 });
  assert.ok(prepared.replacement); assert.match(prepared.replacement.summary, /MANUAL_SUMMARY/);
  assert.equal((await handle.snapshot()).surface.digest, (await sessions.replay('session:request')).surface.digest);
  const compacted = [message('user:summary', 'user', prepared.replacement.summary), ...messages.slice(-2)];
  const ready = await port.prepare({ ...input(compacted), maxInputTokens: 1_000_000, epoch: 1 });
  await port.confirm(ready.id);
  const next = await port.prepare({ ...input(compacted), maxInputTokens: 1_000_000, epoch: 1 });
  assert.equal(next.replacement, undefined);
  await sessions.dispose();
});

test('a later success for the same tool cannot erase the latest error for a different target', async t => {
  const f = await fixture(t);
  const messages = [message('user:request', 'user', 'Repair targets A and B.'),
    message('assistant:error', 'assistant', 'Inspect target A', ['call:error']), { ...message('tool:error', 'tool', 'TARGET_A_ERROR: missing required component at revision 7', [], 'call:error'), failed: true },
    message('assistant:old', 'assistant', 'Inspect target B', ['call:old']), message('tool:old', 'tool', 'olddata '.repeat(14000), [], 'call:old'),
    message('assistant:new', 'assistant', 'Inspect target B again', ['call:new']), message('tool:new', 'tool', 'Target B succeeded at revision 7', [], 'call:new')];
  const prepared = await f.runtime.port().prepare(input(messages));
  assert.ok(prepared.replacement); assert.match(prepared.replacement.summary, /TARGET_A_ERROR/); assert.match(prepared.replacement.summary, /Inspect target A/);
  const recovered = JSON.parse(prepared.replacement.summary.split('\n')[1]);
  assert.match(recovered.latestError.result, /TARGET_A_ERROR/);
});
