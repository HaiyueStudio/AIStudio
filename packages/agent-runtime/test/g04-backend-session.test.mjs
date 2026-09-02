import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BackendSessionRuntime,
  ContextCompactionRuntime,
  DurableSessionRuntime,
  projectBackendCacheEvidence,
} from '../dist/index.js';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

const sessionInput = { projectId: 'project:g04', documentId: 'document:g04', activeGoal: 'Verify Backend Session reconciliation.', taskBudgetId: 'budget:g04' };
const tools = [{ id: 'studio.scene.query', description: 'Query the Scene.', inputSchema: { type: 'object' } }];

test('new, resume, boundary confirmation and explicit detach keep one durable binding generation', async () => {
  const fixture = await openFixture('lifecycle');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await sessions.create({ ...sessionInput, id: 'session:g04-lifecycle' });
    const adapter = new FakeBackendSessionAdapter('backend:harness-api-key', 'deepseek-official');
    const runtime = new BackendSessionRuntime(sessions, [adapter]);
    const [created, concurrentReuse] = await Promise.all([
      runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools }),
      runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools }),
    ]);
    assert.equal(created.action, 'created'); assert.equal(created.binding.generation, 1); assert.equal(created.binding.status, 'active');
    assert.equal(concurrentReuse.action, 'reused'); assert.equal(adapter.opens, 1);
    assert.equal(created.binding.lastConfirmedOpId, (await handle.snapshot()).ops[0].id);
    const reused = await runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools });
    assert.equal(reused.action, 'reused'); assert.equal(reused.binding.generation, 1); assert.equal(adapter.opens, 1);
    const afterMessage = await handle.appendMessage({ role: 'user', content: 'Continue from the Studio Surface.' });
    const confirmed = await runtime.confirmBoundary(handle.id, created.binding.bindingId, afterMessage.ops.at(-1).id);
    assert.equal(confirmed.generation, 2); assert.equal(confirmed.lastConfirmedOpId, afterMessage.ops.at(-1).id);
    assert.equal((await runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools })).action, 'reused');
    const detached = await runtime.detach(handle.id, created.binding.bindingId);
    assert.equal(detached.status, 'detached');
    assert.deepEqual((await handle.snapshot()).ops.filter((op) => op.kind === 'backend.detached').length, 1);
    await runtime.dispose(); await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('remote missing or boundary mismatch detaches and rebuilds from the Studio checkpoint', async () => {
  const fixture = await openFixture('rebind');
  try {
    let sessions = runtimeFor(fixture.log); const handle = await sessions.create({ ...sessionInput, id: 'session:g04-rebind' });
    await handle.appendMessage({ role: 'user', content: 'Durable request retained by Studio.' }); await handle.checkpoint();
    const firstAdapter = new FakeBackendSessionAdapter('backend:codex-app-server', 'openai-codex');
    let runtime = new BackendSessionRuntime(sessions, [firstAdapter]);
    const first = await runtime.ensure(handle.id, { backendId: firstAdapter.backendId, model: 'gpt-5.6-sol', tools });
    const firstRemote = first.binding.remoteSessionId;
    await runtime.dispose(); await sessions.dispose(); await fixture.log.close();

    const reopenedLog = await openLog(fixture.root); sessions = runtimeFor(reopenedLog);
    const restartedAdapter = new FakeBackendSessionAdapter('backend:codex-app-server', 'openai-codex');
    runtime = new BackendSessionRuntime(sessions, [restartedAdapter]);
    const rebound = await runtime.ensure(handle.id, { backendId: restartedAdapter.backendId, model: 'gpt-5.6-sol', tools });
    assert.equal(rebound.action, 'rebound'); assert.equal(rebound.recovery, 'checkpoint-replay-required'); assert.equal(rebound.binding.generation, 2);
    assert.notEqual(rebound.binding.remoteSessionId, firstRemote);
    const snapshot = await sessions.replay(handle.id);
    assert.equal(snapshot.session.checkpoint.surfaceGeneration, 0);
    assert.deepEqual(snapshot.transcript.map((entry) => entry.content), ['Durable request retained by Studio.']);
    assert.equal(snapshot.ops.filter((op) => op.kind === 'backend.detached').length, 1);

    restartedAdapter.boundaries.set(rebound.binding.remoteSessionId, 'op:g04-wrong-boundary');
    const mismatch = await runtime.ensure(handle.id, { backendId: restartedAdapter.backendId, model: 'gpt-5.6-sol', tools });
    assert.equal(mismatch.action, 'rebound'); assert.equal(mismatch.binding.generation, 3); assert.equal(mismatch.diagnostic.code, 'backend.remote-boundary-mismatch');
    await runtime.dispose(); await sessions.dispose(); await reopenedLog.close();
  } finally { await fixture.cleanup(); }
});

test('provider disconnect becomes stale without discarding the remote id or opening duplicates', async () => {
  const fixture = await openFixture('stale');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await sessions.create({ ...sessionInput, id: 'session:g04-stale' });
    const adapter = new FakeBackendSessionAdapter('backend:harness-api-key', 'deepseek-official'); const runtime = new BackendSessionRuntime(sessions, [adapter]);
    const first = await runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools });
    adapter.inspection = 'unavailable';
    const stale = await runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools });
    assert.equal(stale.action, 'stale'); assert.equal(stale.recovery, 'provider-unavailable'); assert.equal(stale.binding.status, 'stale'); assert.equal(stale.binding.remoteSessionId, first.binding.remoteSessionId);
    const repeated = await runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools });
    assert.equal(repeated.binding.generation, stale.binding.generation); assert.equal(adapter.opens, 1);
    await runtime.dispose(); await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('new provider capacity evidence advances the binding without reopening its remote Session', async () => {
  const fixture = await openFixture('capacity-refresh');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await sessions.create({ ...sessionInput, id: 'session:g04-capacity' });
    const adapter = new FakeBackendSessionAdapter('backend:codex-app-server', 'openai-codex'); adapter.maxInputTokens = null;
    const runtime = new BackendSessionRuntime(sessions, [adapter]);
    const unknown = await runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'gpt-5.6-sol', tools });
    assert.equal(unknown.binding.capabilities.maxInputTokens, null);
    adapter.maxInputTokens = 200_000;
    const refreshed = await runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'gpt-5.6-sol', tools });
    assert.equal(refreshed.action, 'reused'); assert.equal(refreshed.binding.generation, 2); assert.equal(refreshed.binding.capabilities.maxInputTokens, 200_000); assert.equal(adapter.opens, 1);
    await runtime.dispose(); await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('failed remote rebuild preserves a detached binding and succeeds on a later retry', async () => {
  const fixture = await openFixture('failed-rebuild');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await sessions.create({ ...sessionInput, id: 'session:g04-failed-rebuild' });
    const adapter = new FakeBackendSessionAdapter('backend:harness-api-key', 'deepseek-official'); const runtime = new BackendSessionRuntime(sessions, [adapter]);
    const first = await runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools });
    adapter.remotes.clear(); adapter.openFailure = true;
    await assert.rejects(runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools }), /simulated open failure/u);
    const detached = (await handle.snapshot()).session.backendBindings.find((entry) => entry.bindingId === first.binding.bindingId);
    assert.equal(detached.status, 'detached'); assert.deepEqual((await handle.snapshot()).transcript, []);
    adapter.openFailure = false;
    const recovered = await runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'deepseek-v4-flash', tools });
    assert.equal(recovered.action, 'rebound'); assert.equal(recovered.binding.generation, 2); assert.equal(recovered.binding.status, 'active');
    await runtime.dispose(); await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('native compaction summaries flow through the Studio compactor and failures use the explicit fallback', async () => {
  for (const [mode, expectedSource] of [['completed', 'provider'], ['failed', 'fallback']]) {
    const fixture = await openFixture(`compaction-${mode}`);
    try {
      const sessions = runtimeFor(fixture.log); const handle = await sessions.create({ ...sessionInput, id: `session:g04-compact-${mode}` });
      for (let index = 0; index < 20; index += 1) await handle.appendMessage({ role: index % 2 ? 'assistant' : 'user', content: `Message ${index} ${'context '.repeat(100)}` });
      const adapter = new FakeBackendSessionAdapter('backend:fixture-native', 'fixture'); adapter.nativeCompaction = true; adapter.compaction = mode;
      const backendSessions = new BackendSessionRuntime(sessions, [adapter]);
      const ensured = await backendSessions.ensure(handle.id, { backendId: adapter.backendId, model: 'fixture-model', tools });
      let fallbackCalls = 0;
      const summarizer = backendSessions.compactionSummarizer(handle.id, ensured.binding.bindingId, async ({ targetSummaryTokens }) => { fallbackCalls += 1; return { summary: `TOKENS:${targetSummaryTokens} fallback summary.` }; });
      const compactor = new ContextCompactionRuntime(fixture.log, sessions, summarizer, { estimator: { estimate: (text) => Math.max(1, Math.ceil(text.length / 2)) } });
      const result = await compactor.compact(handle.id, { reason: 'automatic-threshold', backendBindingId: ensured.binding.bindingId, reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 8_000 });
      assert.equal(result.status, 'completed', JSON.stringify(result.preview)); assert.equal(result.record.validation, 'passed'); assert.equal((await handle.snapshot()).surface.generation, 1);
      assert.deepEqual((await handle.snapshot()).ops.filter((op) => op.nodeId === result.compactionId).map((op) => op.kind), ['compaction.requested', 'compaction.started', 'compaction.summary-created', 'compaction.completed']);
      assert.equal(adapter.compactions, 1); assert.equal(fallbackCalls, expectedSource === 'fallback' ? 1 : 0);
      await compactor.dispose(); await backendSessions.dispose(); await sessions.dispose(); await fixture.log.close();
    } finally { await fixture.cleanup(); }
  }
});

test('cache evidence never converts local CAS hits into provider hits', () => {
  const binding = { bindingId: 'binding:g04-cache', backendId: 'backend:g04-cache', provider: 'fixture', model: 'fixture', remoteSessionId: 'remote:g04-cache', generation: 1, status: 'active', capabilities: { maxInputTokens: 10_000, nativeCompaction: false, parallelToolCalls: false, codeMode: false, providerUsage: 'reported', providerCache: 'reported' }, lastConfirmedOpId: null };
  const context = { localArtifactHits: 7, localArtifactMisses: 1, deltaReuseBytes: 4096, providerCacheEligibleBytes: 2048, providerReportedHitTokens: null };
  const unknown = projectBackendCacheEvidence(binding, context, null);
  assert.deepEqual(unknown.localCas, { artifactHits: 7, artifactMisses: 1, deltaReuseBytes: 4096, source: 'studio-cas' });
  assert.deepEqual(unknown.provider, { status: 'unknown', hitTokens: null, writeTokens: null, eligiblePrefixBytes: 2048, source: 'provider-capability' });
  const reported = projectBackendCacheEvidence(binding, context, { cachedInputTokens: 321, cacheWriteTokens: 12 });
  assert.deepEqual(reported.provider, { status: 'reported', hitTokens: 321, writeTokens: 12, eligiblePrefixBytes: 2048, source: 'provider-usage' });
  const unavailable = projectBackendCacheEvidence({ ...binding, capabilities: { ...binding.capabilities, providerCache: 'unavailable' } }, context, null);
  assert.equal(unavailable.provider.status, 'unavailable'); assert.equal(unavailable.provider.hitTokens, null);
});

test('disposal rejects late Session work and drains an already-started provider open', async () => {
  const fixture = await openFixture('dispose');
  let release;
  try {
    const sessions = runtimeFor(fixture.log); const handle = await sessions.create({ ...sessionInput, id: 'session:g04-dispose' });
    const adapter = new FakeBackendSessionAdapter('backend:g04-dispose', 'fixture');
    let entered;
    const gate = new Promise((resolve) => { release = resolve; }); const started = new Promise((resolve) => { entered = resolve; });
    const open = adapter.open.bind(adapter); adapter.open = async (input) => { entered(); await gate; return open(input); };
    const runtime = new BackendSessionRuntime(sessions, [adapter]);
    const pending = runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'fixture-model', tools }); await started;
    const disposing = runtime.dispose();
    await assert.rejects(runtime.ensure(handle.id, { backendId: adapter.backendId, model: 'fixture-model', tools }), (error) => error.code === 'backend.session-runtime-disposed');
    release(); assert.equal((await pending).action, 'created'); await disposing;
    await sessions.dispose(); await fixture.log.close();
  } finally { release?.(); await fixture.cleanup(); }
});

class FakeBackendSessionAdapter {
  remotes = new Map(); boundaries = new Map(); opens = 0; compactions = 0; inspection = 'available'; compaction = 'completed'; nativeCompaction = false; maxInputTokens = 10_000; openFailure = false;
  constructor(backendId, provider) { this.backendId = backendId; this.provider = provider; }
  async capabilities() { return { maxInputTokens: this.maxInputTokens, nativeCompaction: this.nativeCompaction, parallelToolCalls: true, codeMode: false, providerUsage: 'reported', providerCache: 'reported', nativeCompactionTransport: this.nativeCompaction ? 'available' : 'unavailable', nativeCompactionMirror: this.nativeCompaction ? 'atomic-summary' : 'fallback-required', diagnostic: null }; }
  async open(input) { if (this.openFailure) throw new Error('simulated open failure'); this.opens += 1; const remoteSessionId = `remote:g04:${++remoteSerial}`; this.remotes.set(remoteSessionId, input.model); this.boundaries.set(remoteSessionId, input.lastConfirmedOpId); return { remoteSessionId, capabilities: await this.capabilities() }; }
  async inspect(remoteSessionId) {
    if (this.inspection === 'unavailable') return { state: 'unavailable', remoteSessionId, diagnostic: { code: 'fixture.disconnect', message: 'Provider is disconnected.' } };
    if (!this.remotes.has(remoteSessionId)) return { state: 'missing', remoteSessionId, diagnostic: { code: 'fixture.missing', message: 'Remote Session is missing.' } };
    return { state: 'available', remoteSessionId, model: this.remotes.get(remoteSessionId), lastConfirmedOpId: this.boundaries.get(remoteSessionId) ?? null };
  }
  async confirmBoundary(remoteSessionId, opId) { if (!this.remotes.has(remoteSessionId)) throw new Error('missing remote'); this.boundaries.set(remoteSessionId, opId); }
  async compact(_remoteSessionId, request) { this.compactions += 1; return this.compaction === 'completed' ? { status: 'completed', summary: `TOKENS:${request.targetSummaryTokens} provider summary.`, providerRecordId: `provider-record:${this.compactions}` } : { status: 'failed', diagnostic: { code: 'fixture.compaction-failed', message: 'Provider compaction failed.' } }; }
  async detach(remoteSessionId) { this.remotes.delete(remoteSessionId); this.boundaries.delete(remoteSessionId); }
}

let remoteSerial = 0;

function runtimeFor(log) { let index = 0; return new DurableSessionRuntime(log, { clock: () => new Date(`2026-09-01T02:00:${String(index % 60).padStart(2, '0')}.000Z`), idFactory: (kind) => `${kind}:g04:${index++}`, queryWindow: 7 }); }
async function openFixture(name) { const root = await mkdtemp(path.join(tmpdir(), `haiyue-g04-${name}-`)); const log = await openLog(root); return { root, log, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }; }
function openLog(root) { return OperationLog.open({ rootDirectory: root, appVersion: 'g04-test', flushPolicy: 'always' }); }
