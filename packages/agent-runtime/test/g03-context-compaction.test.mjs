import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ConservativeTokenEstimator,
  ContextCompactionError,
  ContextCompactionRuntime,
  ContextFrameRuntime,
  ContextPolicyError,
  ContextPressureCalculator,
  DurableSessionRuntime,
} from '../dist/index.js';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

const sessionInput = { projectId: 'project:g03', documentId: 'document:g03', activeGoal: 'Preserve the exact current goal.', taskBudgetId: 'budget:g03' };

test('model-aware pressure uses usable capacity and exact 65/75/80/92 boundaries', () => {
  const pressure = new ContextPressureCalculator();
  const states = [[6499, 'normal'], [6500, 'warning'], [7500, 'preparing'], [8000, 'compact-required'], [9200, 'emergency']];
  for (const [usedInputTokens, state] of states) assert.equal(pressure.calculate({ maxInputTokens: 10_000, reservedOutputTokens: 0, reservedSafetyTokens: 0, usedInputTokens, measurement: 'provider-reported' }).pressure.state, state);
  assert.equal(pressure.calculate({ maxInputTokens: 12_000, reservedOutputTokens: 1_000, reservedSafetyTokens: 1_000, usedInputTokens: 8_000, measurement: 'provider-reported' }).pressure.ratio, 0.8);
  const unknown = pressure.calculate({ maxInputTokens: null, reservedOutputTokens: 100, reservedSafetyTokens: 100, usedInputTokens: null, measurement: 'unavailable' }).pressure;
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.ratio, null);
  const overflow = pressure.calculate({ maxInputTokens: 10_000, reservedOutputTokens: 0, reservedSafetyTokens: 0, usedInputTokens: 12_000, measurement: 'provider-reported' }).pressure;
  assert.equal(overflow.ratio, 1); assert.equal(overflow.state, 'emergency');
  assert.ok(new ConservativeTokenEstimator().estimate('中文 context text', 'any-model') > 0);
});

test('79% does not auto compact; 80% records four phases, lands at 55%-65%, and keeps Transcript plus pins across restart', async () => {
  const fixture = await openFixture('threshold-replay');
  try {
    const sessions = runtimeFor(fixture.log);
    const handle = await seededSession(sessions, 'session:g03-threshold');
    const evidence = await fixture.log.putArtifact({ schemaVersion: 1, kind: 'evaluation-evidence', revision: 7 });
    await handle.append({ kind: 'evidence.captured', projectRevision: 7, artifactRefs: [evidence.id], payload: { evidenceKind: 'gameplay-evaluation' } });
    const compactor = compactorFor(fixture.log, sessions, async ({ targetSummaryTokens }) => ({ summary: `TOKENS:${targetSummaryTokens} durable decisions and tool results.` }));
    const common = { backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0, reason: 'automatic-threshold', pinnedFacts: [
      { kind: 'acceptance', content: 'The game must pass screenshot verification.' },
      { kind: 'blocker', content: 'The current physics defect remains unresolved.' },
    ] };
    let preview = await compactor.preview(handle.id, { ...common, providerUsedInputTokens: 7_900 });
    assert.equal(preview.pressure.state, 'preparing'); assert.equal(preview.decision, 'not-required');
    assert.equal((await compactor.compact(handle.id, { ...common, providerUsedInputTokens: 7_900 })).status, 'not-required');
    const transcriptBefore = (await handle.snapshot()).transcript.map((entry) => entry.content);
    preview = await compactor.preview(handle.id, { ...common, providerUsedInputTokens: 8_000 });
    assert.equal(preview.decision, 'ready'); assert.deepEqual(preview.protectedNodeIds, [(await handle.snapshot()).surface.nodes.at(-1).id]);
    const result = await compactor.compact(handle.id, { ...common, providerUsedInputTokens: 8_000 });
    assert.equal(result.status, 'completed'); assert.equal(result.record.validation, 'passed');
    assert.ok(result.record.after.ratio >= 0.55 && result.record.after.ratio <= 0.65);
    const snapshot = await handle.snapshot();
    assert.equal(snapshot.surface.generation, 1);
    assert.deepEqual(snapshot.transcript.map((entry) => entry.content), transcriptBefore);
    assert.deepEqual(snapshot.ops.filter((op) => op.nodeId === result.compactionId).map((op) => op.kind), ['compaction.requested', 'compaction.started', 'compaction.summary-created', 'compaction.completed']);
    const summaryArtifact = await fixture.log.readArtifact(result.record.summaryArtifactId);
    for (const digest of result.record.pinnedFactDigests) assert.match(summaryArtifact.value.content, new RegExp(digest.replace(':', '\\:')));
    assert.match(summaryArtifact.value.content, /Current project revision is 7/u);
    assert.match(summaryArtifact.value.content, new RegExp(evidence.id.replace(':', '\\:')));
    await sessions.dispose(); await fixture.log.close();

    const reopenedLog = await openLog(fixture.root);
    const reopenedSessions = runtimeFor(reopenedLog);
    const reopenedCompactor = compactorFor(reopenedLog, reopenedSessions, async () => ({ summary: 'unused' }));
    const replay = await reopenedSessions.replay(handle.id);
    assert.equal(replay.surface.digest, snapshot.surface.digest);
    assert.equal(replay.surface.generation, 1);
    assert.deepEqual(replay.transcript.map((entry) => entry.content), transcriptBefore);
    assert.equal((await reopenedCompactor.history(handle.id)).at(-1).phase, 'completed');
    await reopenedSessions.dispose(); await reopenedLog.close();
  } finally { await fixture.cleanup(); }
});

test('manual compaction runs below the automatic threshold and returns range/progress UI data', async () => {
  const fixture = await openFixture('manual');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await seededSession(sessions, 'session:g03-manual');
    const compactor = compactorFor(fixture.log, sessions, async ({ targetSummaryTokens }) => ({ summary: `TOKENS:${targetSummaryTokens} manual compact.` }));
    const preview = await compactor.preview(handle.id, { reason: 'manual', backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 7_000 });
    assert.equal(preview.pressure.state, 'warning'); assert.equal(preview.decision, 'ready');
    assert.ok(preview.range.nodeIds.length >= 2); assert.ok(preview.range.targetSummaryTokens > 0);
    const result = await compactor.compact(handle.id, { reason: 'manual', backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 7_000 });
    assert.equal(result.status, 'completed'); assert.equal(result.record.reason, 'manual');
    assert.equal(result.record.before.usedInputTokens, 7_000); assert.ok(result.record.after.usedInputTokens < 7_000);
    await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('open approval/tool boundaries defer automatic compaction without changing Surface generation', async () => {
  const fixture = await openFixture('barrier');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await seededSession(sessions, 'session:g03-barrier');
    await handle.append({ kind: 'turn.started', turnId: 'turn:g03-open', payload: {} });
    await handle.append({ kind: 'approval.requested', turnId: 'turn:g03-open', nodeId: 'node:g03-approval', payload: { approvalId: 'approval:g03-open' } });
    const compactor = compactorFor(fixture.log, sessions, async ({ targetSummaryTokens }) => ({ summary: `TOKENS:${targetSummaryTokens}` }));
    const input = { reason: 'automatic-threshold', backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 8_000 };
    const generation = (await handle.snapshot()).surface.generation;
    assert.equal((await compactor.preview(handle.id, input)).decision, 'deferred-open-boundary');
    assert.equal((await compactor.compact(handle.id, input)).status, 'deferred');
    assert.equal((await handle.snapshot()).surface.generation, generation);
    await handle.append({ kind: 'approval.resolved', turnId: 'turn:g03-open', nodeId: 'node:g03-approval', payload: { approvalId: 'approval:g03-open' } });
    await handle.append({ kind: 'turn.completed', turnId: 'turn:g03-open', payload: { status: 'completed' } });
    assert.equal((await compactor.preview(handle.id, input)).decision, 'ready');
    await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('cancellation and invalid summaries append failed evidence and never advance Surface generation', async () => {
  const fixture = await openFixture('failure');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await seededSession(sessions, 'session:g03-failure');
    let entered; const summarizerEntered = new Promise((resolve) => { entered = resolve; });
    const cancelling = compactorFor(fixture.log, sessions, async (_request, signal) => {
      entered();
      await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      return { summary: 'unreachable' };
    });
    const controller = new AbortController();
    const input = { reason: 'automatic-threshold', backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 8_000, signal: controller.signal };
    const generation = (await handle.snapshot()).surface.generation;
    const pending = cancelling.compact(handle.id, input); await summarizerEntered; controller.abort(new Error('cancel fixture'));
    const cancelled = await pending;
    assert.equal(cancelled.status, 'failed'); assert.equal(cancelled.record.diagnostic, 'context.compaction-unsafe');
    assert.equal((await handle.snapshot()).surface.generation, generation);
    assert.deepEqual((await cancelling.history(handle.id)).map((entry) => entry.phase), ['requested', 'started', 'failed']);

    const invalid = compactorFor(fixture.log, sessions, async () => ({ summary: '' }));
    const failed = await invalid.compact(handle.id, { ...input, signal: undefined });
    assert.equal(failed.status, 'failed'); assert.equal(failed.record.diagnostic, 'context.compaction-summary-invalid');
    assert.equal((await handle.snapshot()).surface.generation, generation);
    await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('restart recovery completes a published summary but fails an unpublished active compaction without rerunning the summarizer', async () => {
  const fixture = await openFixture('recovery');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await seededSession(sessions, 'session:g03-recovery');
    const append = sessions.append.bind(sessions); const replay = sessions.replay.bind(sessions);
    const interruptedSessions = { replay, append: async (sessionId, input) => { if (input.kind === 'compaction.completed') throw new Error('simulated crash after publish'); return append(sessionId, input); } };
    const interrupted = compactorFor(fixture.log, interruptedSessions, async ({ targetSummaryTokens }) => ({ summary: `TOKENS:${targetSummaryTokens} published.` }));
    await assert.rejects(interrupted.compact(handle.id, { reason: 'automatic-threshold', backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 8_000 }), /simulated crash/u);
    assert.equal((await handle.snapshot()).surface.generation, 1);
    assert.deepEqual((await interrupted.history(handle.id)).map((entry) => entry.phase), ['requested', 'started', 'summary-created']);
    let summaries = 0;
    const recovered = compactorFor(fixture.log, sessions, async () => { summaries += 1; return { summary: 'must not run' }; });
    const history = await recovered.recover(handle.id);
    assert.equal(history.at(-1).phase, 'completed'); assert.equal(summaries, 0);
    await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('ContextFrame binds the exact Surface generation and blocks new requests at emergency pressure', async () => {
  const fixture = await openFixture('frame');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await seededSession(sessions, 'session:g03-frame');
    const compactor = compactorFor(fixture.log, sessions, async ({ targetSummaryTokens }) => ({ summary: `TOKENS:${targetSummaryTokens} frame compact.` }));
    const external = await fixture.log.putArtifact({ schemaVersion: 1, kind: 'scene-diff', revision: 7 });
    const frames = new ContextFrameRuntime(fixture.log, sessions, compactor, { estimator: tokenEstimator });
    const captured = await frames.capture({
      id: 'context-frame:g03-exact', sessionId: handle.id, turnId: 'turn:g03-frame', backendBindingId: 'binding:g03', projectRevision: 7,
      reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 8_000,
      inputs: [{ kind: 'scene-diff', artifactId: external.id, digest: `sha256:${external.digest}`, sourceRevision: 7, estimatedTokens: 100, required: true }],
    });
    const snapshot = await handle.snapshot();
    assert.equal(snapshot.surface.generation, 1, 'ContextFrame capture must invoke automatic compaction at 80%');
    assert.equal(captured.frame.surfaceGeneration, snapshot.surface.generation);
    assert.equal(captured.frame.compaction.validation, 'passed');
    assert.equal((await frames.assertReadable(captured.artifactId)).id, captured.frame.id);
    const emergencyFrames = new ContextFrameRuntime(fixture.log, sessions, undefined, { estimator: tokenEstimator });
    await assert.rejects(emergencyFrames.capture({ sessionId: handle.id, turnId: 'turn:g03-emergency', backendBindingId: 'binding:g03', projectRevision: 7, reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 9_200 }), hasContextCode('context.emergency-request-blocked'));
    emergencyFrames.dispose(); frames.dispose(); await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('unknown model capacity fails closed and never pretends a byte limit is a token limit', async () => {
  const fixture = await openFixture('unknown-capacity');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await sessions.create({ ...sessionInput, id: 'session:g03-unknown' });
    await handle.bindBackend(binding(null));
    await handle.appendMessage({ role: 'assistant', content: 'TOKENS:9000 prior history.', projectRevision: 1 });
    await handle.appendMessage({ role: 'user', content: 'TOKENS:500 current request.', projectRevision: 1 });
    const compactor = compactorFor(fixture.log, sessions, async () => ({ summary: 'unused' }));
    const preview = await compactor.preview(handle.id, { reason: 'automatic-threshold', backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0 });
    assert.equal(preview.decision, 'capacity-unavailable'); assert.equal(preview.pressure.state, 'unknown');
    assert.equal((await compactor.compact(handle.id, { reason: 'automatic-threshold', backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0 })).status, 'deferred');
    await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('long sessions compact repeatedly while preserving every append-origin Transcript entry', async () => {
  const fixture = await openFixture('repeat');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await seededSession(sessions, 'session:g03-repeat');
    const compactor = compactorFor(fixture.log, sessions, async ({ targetSummaryTokens }) => ({ summary: `TOKENS:${targetSummaryTokens} repeated compact.` }));
    const input = { reason: 'automatic-threshold', backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0 };
    assert.equal((await compactor.compact(handle.id, { ...input, providerUsedInputTokens: 8_000 })).status, 'completed');
    await handle.appendMessage({ role: 'assistant', content: 'TOKENS:2500 later tools.', projectRevision: 8 });
    await handle.appendMessage({ role: 'assistant', content: 'TOKENS:2500 later evidence.', projectRevision: 8 });
    await handle.appendMessage({ role: 'user', content: 'TOKENS:500 newest request.', projectRevision: 8 });
    const before = await handle.snapshot();
    assert.equal((await compactor.compact(handle.id, { ...input, providerUsedInputTokens: 9_000 })).status, 'completed');
    const after = await handle.snapshot();
    assert.equal(after.surface.generation, 2);
    assert.deepEqual(after.transcript, before.transcript);
    assert.equal((await compactor.history(handle.id)).filter((entry) => entry.phase === 'completed').length, 2);
    await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('overlap is rejected during preview and disposal aborts then drains the owned compaction', async () => {
  const fixture = await openFixture('lifecycle');
  try {
    const sessions = runtimeFor(fixture.log); const handle = await seededSession(sessions, 'session:g03-lifecycle');
    let entered; const summarizerEntered = new Promise((resolve) => { entered = resolve; });
    const compactor = compactorFor(fixture.log, sessions, async (_request, signal) => {
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { summary: 'unreachable' };
    });
    const input = { reason: 'automatic-threshold', backendBindingId: 'binding:g03', reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 8_000 };
    const pending = compactor.compact(handle.id, input); await summarizerEntered;
    await assert.rejects(compactor.compact(handle.id, input), hasCompactionCode('context.compaction-overlap'));
    const disposing = compactor.dispose();
    assert.equal((await pending).status, 'failed');
    await disposing;
    await assert.rejects(compactor.preview(handle.id, input), hasCompactionCode('context.compaction-disposed'));
    assert.deepEqual((await handle.snapshot()).ops.filter((op) => op.kind.startsWith('compaction.')).map((op) => op.kind), ['compaction.requested', 'compaction.started', 'compaction.failed']);
    await sessions.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

const tokenEstimator = { estimate(text) { const match = /TOKENS:(\d+)/u.exec(text); return match ? Number(match[1]) : Math.max(1, Math.ceil(text.length / 4)); } };
function compactorFor(log, sessions, summarizer) { let index = 0; return new ContextCompactionRuntime(log, sessions, summarizer, { estimator: tokenEstimator, clock: () => new Date('2026-09-01T01:00:00.000Z'), idFactory: (kind) => `${kind}:g03:${index++}` }); }
async function seededSession(sessions, id) {
  const handle = await sessions.create({ ...sessionInput, id }); await handle.bindBackend(binding(10_000));
  await handle.appendMessage({ role: 'assistant', content: 'TOKENS:2500 old decisions.', projectRevision: 7 });
  await handle.appendMessage({ role: 'assistant', content: 'TOKENS:2500 old tool results.', projectRevision: 7 });
  await handle.appendMessage({ role: 'assistant', content: 'TOKENS:2500 old validation.', projectRevision: 7 });
  await handle.appendMessage({ role: 'user', content: 'TOKENS:500 current request.', projectRevision: 7 });
  return handle;
}
function binding(maxInputTokens) { return { bindingId: 'binding:g03', backendId: 'backend:g03', provider: 'provider:g03', model: 'model:g03-10k', remoteSessionId: 'remote:g03', generation: 1, status: 'active', capabilities: { maxInputTokens, nativeCompaction: true, parallelToolCalls: true, codeMode: true, providerUsage: 'reported', providerCache: 'reported' }, lastConfirmedOpId: null }; }
function runtimeFor(log) { let index = 0; return new DurableSessionRuntime(log, { clock: () => new Date(`2026-09-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`), idFactory: (kind) => `${kind}:g03-session:${index++}`, queryWindow: 7 }); }
async function openFixture(name) { const root = await mkdtemp(path.join(tmpdir(), `haiyue-g03-${name}-`)); const log = await openLog(root); return { root, log, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }; }
function openLog(root) { return OperationLog.open({ rootDirectory: root, appVersion: 'g03-test', flushPolicy: 'always' }); }
function hasContextCode(code) { return (error) => { assert.ok(error instanceof ContextPolicyError); assert.equal(error.code, code); return true; }; }
function hasCompactionCode(code) { return (error) => { assert.ok(error instanceof ContextCompactionError); assert.equal(error.code, code); return true; }; }
