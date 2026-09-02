import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BackendSessionRuntime, DurableSessionRuntime } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

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
