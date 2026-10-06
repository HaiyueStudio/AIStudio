import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BackendSessionRuntime, DurableSessionRuntime } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { createHarnessStudioRoot } from '@haiyue/ai-studio-harness-bridge';
import { createPinnedHarnessAgentTransport } from '@haiyue/ai-studio-harness-bridge/agent';
import { HarnessApiKeyBackend } from '@haiyue/ai-studio-agent-backends';

test('real pinned Harness rebinds after runtime loss without rewriting Studio history or replaying effects', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-harness-v4-reload-'));
  const cleanup = [];
  t.after(async () => { for (const dispose of cleanup.reverse()) await dispose(); await rm(directory, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Recovery must not replay model requests or tools.'));
  async function boot() {
    const owner = createHarnessStudioRoot(); cleanup.push(() => owner.dispose());
    const transport = await createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => 'fixture-only' });
    const backend = new HarnessApiKeyBackend({ transport, clearApiKey: async () => {} });
    const log = await openLog(directory); cleanup.push(() => log.close());
    const sessions = new DurableSessionRuntime(log); cleanup.push(() => sessions.dispose());
    const bindings = new BackendSessionRuntime(sessions, [backend]); cleanup.push(() => bindings.dispose());
    return { owner, transport, sessions, bindings, log };
  }
  const first = await boot();
  const session = await first.sessions.create({ id: 'session:harness-v4-recovery', projectId: 'project:v4', documentId: 'document:v4', activeGoal: 'Retain original constraints.', taskBudgetId: null });
  await session.appendMessage({ role: 'user', content: 'Inspect only; preserve the original selection and do not edit.' });
  await session.checkpoint();
  const before = await first.bindings.ensure(session.id, input('backend:harness-api-key', 'deepseek-flash'));
  const original = await first.sessions.replay(session.id);
  // Simulate lost provider memory rather than graceful binding detachment.
  await first.owner.dispose(); await first.sessions.dispose(); await first.log.close();
  const second = await boot();
  const after = await second.bindings.ensure(session.id, input('backend:harness-api-key', 'deepseek-flash'));
  assert.equal(after.action, 'rebound');
  assert.equal(after.recovery, 'checkpoint-replay-required');
  assert.notEqual(after.binding.remoteSessionId, before.binding.remoteSessionId);
  const replay = await second.sessions.replay(session.id);
  assert.deepEqual(replay.transcript, original.transcript);
  assert.deepEqual(replay.surface.nodes, original.surface.nodes);
  assert.equal(replay.surface.generation, original.surface.generation);
  assert.ok(replay.surface.throughSequence > original.surface.throughSequence, 'Rebinding appends facts without changing model-visible history.');
  assert.equal(replay.ops.filter(op => op.kind === 'tool.started').length, 0);
  assert.equal((await second.transport.inspectSession(after.binding.remoteSessionId)).state, 'available');
});

test('main process reload rebinds missing Harness/Codex remotes from one Studio Session truth', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g04-app-reload-'));
  try {
    let log = await openLog(root); let sessions = new DurableSessionRuntime(log);
    const session = await sessions.create({ id: 'session:g04-app', projectId: 'project:g04-app', documentId: 'document:g04-app', activeGoal: 'Keep Studio truth across providers.', taskBudgetId: null });
    await session.appendMessage({ role: 'user', content: 'This durable request must survive both provider processes.' }); await session.checkpoint();
    let harness = adapter('backend:harness-api-key', 'deepseek-official', harnessCapabilities());
    let codex = adapter('backend:codex-app-server', 'openai-codex', codexCapabilities());
    let bindings = new BackendSessionRuntime(sessions, [harness, codex]);
    const beforeHarness = await bindings.ensure(session.id, input(harness.backendId, 'deepseek-v4-flash'));
    const beforeCodex = await bindings.ensure(session.id, input(codex.backendId, 'gpt-5.6-sol'));
    assert.equal(beforeHarness.binding.capabilities.maxInputTokens, null); assert.equal(beforeCodex.binding.capabilities.maxInputTokens, null);
    assert.equal(beforeHarness.binding.capabilities.parallelToolCalls, false); assert.equal(beforeCodex.binding.capabilities.parallelToolCalls, true);
    assert.equal(beforeHarness.binding.capabilities.nativeCompactionTransport, undefined); assert.equal(beforeCodex.binding.capabilities.nativeCompactionTransport, undefined);
    await bindings.dispose(); await sessions.dispose(); await log.close();

    log = await openLog(root); sessions = new DurableSessionRuntime(log);
    harness = adapter('backend:harness-api-key', 'deepseek-official', harnessCapabilities());
    codex = adapter('backend:codex-app-server', 'openai-codex', codexCapabilities());
    bindings = new BackendSessionRuntime(sessions, [harness, codex]);
    const afterHarness = await bindings.ensure(session.id, input(harness.backendId, 'deepseek-v4-flash'));
    const afterCodex = await bindings.ensure(session.id, input(codex.backendId, 'gpt-5.6-sol'));
    assert.deepEqual([afterHarness.action, afterCodex.action], ['rebound', 'rebound']);
    assert.deepEqual([afterHarness.binding.generation, afterCodex.binding.generation], [2, 2]);
    assert.deepEqual([afterHarness.recovery, afterCodex.recovery], ['checkpoint-replay-required', 'checkpoint-replay-required']);
    const replay = await sessions.replay(session.id);
    assert.deepEqual(replay.transcript.map((entry) => entry.content), ['This durable request must survive both provider processes.']);
    assert.equal(replay.ops.filter((op) => op.kind === 'backend.detached').length, 2);
    await bindings.dispose(); await sessions.dispose(); await log.close();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

function adapter(backendId, provider, capabilities) {
  const remotes = new Map(); const boundaries = new Map();
  return {
    backendId, provider,
    capabilities: async () => capabilities,
    open: async (value) => { const remoteSessionId = `remote:g04-app:${++remoteSerial}`; remotes.set(remoteSessionId, value.model); boundaries.set(remoteSessionId, value.lastConfirmedOpId); return { remoteSessionId, capabilities }; },
    inspect: async (remoteSessionId) => remotes.has(remoteSessionId) ? { state: 'available', remoteSessionId, model: remotes.get(remoteSessionId), lastConfirmedOpId: boundaries.get(remoteSessionId) } : { state: 'missing', remoteSessionId, diagnostic: { code: 'fixture.remote-missing', message: 'Provider process lost its remote Session.' } },
    confirmBoundary: async (remoteSessionId, opId) => { boundaries.set(remoteSessionId, opId); },
    compact: async () => ({ status: 'unavailable', diagnostic: { code: 'fixture.compaction-fallback', message: 'Use Studio compaction.' } }),
    detach: async (remoteSessionId) => { remotes.delete(remoteSessionId); boundaries.delete(remoteSessionId); },
  };
}
function harnessCapabilities() { return { maxInputTokens: null, nativeCompaction: false, parallelToolCalls: false, codeMode: false, providerUsage: 'reported', providerCache: 'reported', nativeCompactionTransport: 'unavailable', nativeCompactionMirror: 'fallback-required', diagnostic: { code: 'harness.compaction-driver-unavailable', message: 'Input capacity is unknown; use Studio compaction after a trusted capacity source is available.' } }; }
function codexCapabilities() { return { maxInputTokens: null, nativeCompaction: false, parallelToolCalls: true, codeMode: false, providerUsage: 'reported', providerCache: 'reported', nativeCompactionTransport: 'available', nativeCompactionMirror: 'fallback-required', diagnostic: { code: 'codex.compaction-summary-unavailable', message: 'Use Studio compaction.' } }; }
function input(backendId, model) { return { backendId, model, tools: [{ id: 'studio.scene.query', description: 'Query Scene', inputSchema: { type: 'object' } }] }; }
function openLog(root) { return OperationLog.open({ rootDirectory: root, appVersion: 'g04-app-test', flushPolicy: 'always' }); }
let remoteSerial = 0;
