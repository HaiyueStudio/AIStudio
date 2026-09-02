import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContextFrameRuntime, ContextRouterError, ContextRouterRuntime, DurableSessionRuntime, fullSceneRetransmissionReduction, operationLogContextDeltaSources } from '../dist/index.js';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

test('exact, durable and semantic routes keep fixed precedence and capture one immutable ContextFrame', async () => {
  const fixture = await openFixture('frame');
  try {
    const sessions = new DurableSessionRuntime(fixture.log); const handle = await session(sessions, 'session:g05-router');
    const durable = await fixture.log.putArtifact({ schemaVersion: 1, decisions: ['Use fixed-step play.'] });
    const knowledge = await fixture.log.putArtifact(knowledgeProjection());
    const sources = fakeSources(); const router = new ContextRouterRuntime(fixture.log, sources);
    const routed = await router.route({ sessionId: handle.id, turnId: 'turn:g05-router', projectRevision: 7, previousProjectRevision: null, durableMemoryArtifactIds: [durable.id], knowledgeHitArtifactIds: [knowledge.id], knowledgePolicy: { allowedPermissionScopes: ['knowledge:engine-local'], packageVersions: ['1.0.0'], projectRevision: 7 } });
    assert.equal(routed.sceneMode, 'snapshot'); assert.equal(routed.metrics.fullSceneTransmissions, 1);
    assert.deepEqual(routed.inputs.map((entry) => entry.kind), ['scene-snapshot', 'diagnostics-delta', 'evidence-delta', 'evidence-delta', 'durable-memory', 'knowledge-hit']);
    const frameRuntime = new ContextFrameRuntime(fixture.log, sessions);
    const captured = await frameRuntime.capture({ sessionId: handle.id, turnId: 'turn:g05-router', backendBindingId: 'binding:g05', projectRevision: 7, reservedOutputTokens: 1_000, reservedSafetyTokens: 500, inputs: routed.inputs });
    assert.deepEqual(captured.frame.inputs.slice(1).map((entry) => entry.kind), routed.inputs.map((entry) => entry.kind));
    assert.equal(captured.frame.projectRevision, 7); assert.ok(Object.isFrozen(captured.frame));
    const readable = await frameRuntime.assertReadable(captured.artifactId); assert.equal(readable.cachePrefixDigest, captured.frame.cachePrefixDigest);
    frameRuntime.dispose(); router.dispose(); await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('after one baseline every later turn uses revision/cursor deltas and exceeds the 80% retransmission gate', async () => {
  const fixture = await openFixture('reduction');
  try {
    const sources = fakeSources(); const router = new ContextRouterRuntime(fixture.log, sources); const results = [];
    results.push(await router.route({ sessionId: 'session:g05-reduction', turnId: 'turn:g05-0', projectRevision: 1, previousProjectRevision: null }));
    for (let revision = 2; revision <= 7; revision += 1) results.push(await router.route({ sessionId: 'session:g05-reduction', turnId: `turn:g05-${revision}`, projectRevision: revision, previousProjectRevision: revision - 1, cursors: results.at(-1).cursors }));
    assert.equal(sources.counts.query, 1); assert.equal(sources.counts.diff, 6);
    assert.equal(fullSceneRetransmissionReduction(results), 1); assert.ok(fullSceneRetransmissionReduction(results) >= 0.8);
    assert.deepEqual(results.slice(1).map((entry) => entry.sceneMode), Array(6).fill('diff'));
    router.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('recoverable Scene history gaps produce an explicit bounded snapshot recovery, while other failures remain fail-closed', async () => {
  const fixture = await openFixture('recovery');
  try {
    let failure = { code: 'scene.history-pruned', recoverable: true, message: 'History was pruned.' };
    const scene = { query: ({ revision }) => ({ schemaVersion: 1, revision, items: [] }), diff: () => { const error = new Error(failure.message); Object.assign(error, failure); throw error; } };
    const router = new ContextRouterRuntime(fixture.log, { scene });
    const recovered = await router.route({ sessionId: 'session:g05-recovery', turnId: 'turn:g05-recovery', projectRevision: 9, previousProjectRevision: 2 });
    assert.equal(recovered.sceneMode, 'snapshot-recovery'); assert.equal(recovered.recoveryDiagnostic.code, 'scene.history-pruned'); assert.equal(recovered.metrics.fullSceneTransmissions, 1);
    failure = { code: 'scene.corrupt', recoverable: false, message: 'Corrupt exact source.' };
    await assert.rejects(router.route({ sessionId: 'session:g05-recovery', turnId: 'turn:g05-fail', projectRevision: 10, previousProjectRevision: 9 }), /Corrupt exact source/u);
    router.dispose(); await assert.rejects(router.route({ sessionId: 'session:g05-recovery', turnId: 'turn:g05-late', projectRevision: 10, previousProjectRevision: null }), (error) => error instanceof ContextRouterError && error.code === 'context.router-disposed');
    await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('Operation Log diagnostics, evidence and play trace feeds advance redacted high-water cursors without sparse-event loss', async () => {
  const fixture = await openFixture('op-deltas');
  try {
    await fixture.log.append({ kind: 'project/opened', severity: 'info', source: 'studio.fixture', payload: { raw: 'not projected' } });
    await fixture.log.append({ kind: 'preview/runtime-error', severity: 'error', source: 'studio.preview', payload: { message: 'bounded failure' } });
    const evidence = await fixture.log.putArtifact({ schemaVersion: 1, state: 'ready' });
    await fixture.log.append({ kind: 'observation/persisted', severity: 'info', source: 'studio.play-observation', payload: { artifactId: evidence.id }, artifactRefs: [evidence.id] });
    const sources = operationLogContextDeltaSources(fixture.log);
    const diagnostics = await sources.diagnostics.read({ cursor: null, limit: 100 });
    assert.deepEqual(diagnostics.items.map((item) => item.kind), ['preview/runtime-error']); assert.equal(Object.hasOwn(diagnostics.items[0], 'payload'), false);
    const observed = await sources.evidence.read({ cursor: null, limit: 100 }); assert.deepEqual(observed.items[0].artifactRefs, [evidence.id]);
    const trace = await sources.playTrace.read({ cursor: null, limit: 100 }); assert.deepEqual(trace.items.map((item) => item.kind), ['preview/runtime-error', 'observation/persisted']);
    await fixture.log.append({ kind: 'preview/start-failed', severity: 'error', source: 'studio.preview', payload: { message: 'later' } });
    const later = await sources.diagnostics.read({ cursor: diagnostics.nextCursor, limit: 100 }); assert.deepEqual(later.items.map((item) => item.kind), ['preview/start-failed']);
    await assert.rejects(sources.diagnostics.read({ cursor: `${later.nextCursor}tampered`, limit: 100 }), (error) => error instanceof ContextRouterError && error.code === 'context.delta-cursor-invalid' && error.recoverable);
    await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('Context Router independently rejects stale, unauthorized and mismatched knowledge citations', async () => {
  const fixture = await openFixture('knowledge-policy');
  try {
    const router = new ContextRouterRuntime(fixture.log, fakeSources());
    const policy = { allowedPermissionScopes: ['knowledge:engine-local'], packageVersions: ['1.0.0'], projectRevision: 7 };
    const stale = await fixture.log.putArtifact(knowledgeProjection({ stale: true }));
    await assert.rejects(router.route({ sessionId: 'session:g05-policy', turnId: 'turn:g05-stale', projectRevision: 7, previousProjectRevision: null, knowledgeHitArtifactIds: [stale.id], knowledgePolicy: policy }), (error) => error instanceof ContextRouterError && error.code === 'context.knowledge-hit-stale');
    const forbidden = await fixture.log.putArtifact(knowledgeProjection({ permissionScope: 'knowledge:project:forbidden' }));
    await assert.rejects(router.route({ sessionId: 'session:g05-policy', turnId: 'turn:g05-forbidden', projectRevision: 7, previousProjectRevision: null, knowledgeHitArtifactIds: [forbidden.id], knowledgePolicy: policy }), (error) => error instanceof ContextRouterError && error.code === 'context.knowledge-hit-permission');
    const mismatch = knowledgeProjection(); mismatch.citation.contentDigest = digest('other');
    const badCitation = await fixture.log.putArtifact(mismatch);
    await assert.rejects(router.route({ sessionId: 'session:g05-policy', turnId: 'turn:g05-citation', projectRevision: 7, previousProjectRevision: null, knowledgeHitArtifactIds: [badCitation.id], knowledgePolicy: policy }), (error) => error instanceof ContextRouterError && error.code === 'context.knowledge-hit-citation');
    router.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

function fakeSources() {
  const counts = { query: 0, diff: 0 };
  const scene = {
    query: ({ revision, request }) => { counts.query += 1; return { schemaVersion: 1, documentId: 'document:g05', revision, request, items: [{ kind: 'entity', id: 'entity:root' }] }; },
    diff: ({ fromRevision, toRevision, request }) => { counts.diff += 1; return { schemaVersion: 1, documentId: 'document:g05', fromRevision, toRevision, request, changedEntities: [{ entityId: 'entity:root', paths: ['name'] }] }; },
  };
  const delta = (channel) => ({ read: ({ cursor }) => ({ items: cursor ? [] : [{ channel, sequence: 1, digest: digest(channel) }], nextCursor: cursor ?? `${channel}:1`, sourceRevision: 7, truncated: false }) });
  return { counts, scene, diagnostics: delta('diagnostics'), evidence: delta('evidence'), playTrace: delta('play-trace') };
}
async function session(sessions, id) { const handle = await sessions.create({ id, projectId: 'project:g05', documentId: 'document:g05', activeGoal: 'Route exact Scene deltas.', taskBudgetId: null }); await handle.bindBackend({ bindingId: 'binding:g05', backendId: 'backend:g05', provider: 'fixture', model: 'model:g05', remoteSessionId: 'remote:g05', generation: 1, status: 'active', capabilities: { maxInputTokens: 100_000, nativeCompaction: false, parallelToolCalls: true, codeMode: false, providerUsage: 'reported', providerCache: 'reported' }, lastConfirmedOpId: null }); await handle.appendMessage({ role: 'user', content: 'Inspect the exact current Scene.', projectRevision: 7 }); return handle; }
async function openFixture(name) { const root = await mkdtemp(path.join(tmpdir(), `haiyue-g05-router-${name}-`)); const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g05-test', flushPolicy: 'always' }); return { root, log, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }; }
function digest(value) { return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`; }
function knowledgeProjection(overrides = {}) {
  const contentDigest = digest('knowledge');
  const hit = { schemaVersion: 1, id: 'knowledge-hit:g05', source: 'engine://components/transform', sourceKind: 'component-schema', packageVersion: '1.0.0', projectRevision: null, contentDigest, chunk: { start: 0, end: 9 }, retrieval: 'hybrid', score: 0.9, reason: 'authorized', permissionScope: 'knowledge:engine-local', stale: false, ...overrides };
  return { schemaVersion: 1, hit, citation: { source: hit.source, sourceKind: hit.sourceKind, packageVersion: hit.packageVersion, projectRevision: hit.projectRevision, contentDigest: hit.contentDigest, start: hit.chunk.start, end: hit.chunk.end, startLine: 1, endLine: 1 }, excerpt: 'transform', estimatedTokens: 3, capabilityIds: ['document.v2'] };
}
