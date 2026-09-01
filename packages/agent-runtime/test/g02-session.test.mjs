import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableSessionRuntime, AgentSessionError, sessionPayloadDigest } from '../dist/index.js';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

const sessionInput = { projectId: 'project:g02', documentId: 'document:g02', activeGoal: 'Build and verify a game.', taskBudgetId: 'budget:g02' };

test('append/replace replay keeps the complete append-origin Transcript across restart', async () => {
  const fixture = await openFixture('surface-replay');
  try {
    const runtime = runtimeFor(fixture.log);
    const handle = await runtime.create({ ...sessionInput, id: 'session:g02-surface' });
    await handle.appendMessage({ role: 'user', content: 'Create a game.', turnId: 'turn:g02-one' });
    await handle.appendMessage({ role: 'assistant', content: 'I will inspect the scene.', turnId: 'turn:g02-one' });
    await handle.appendMessage({ role: 'user', content: 'Add scoring.', turnId: 'turn:g02-two' });
    let snapshot = await handle.appendMessage({ role: 'assistant', content: 'Scoring is implemented.', turnId: 'turn:g02-two' });
    const originalTranscript = snapshot.transcript.map((entry) => entry.content);
    snapshot = await handle.replaceSurface({ startNodeId: snapshot.surface.nodes[0].id, endNodeId: snapshot.surface.nodes[1].id, summary: 'The user requested a game and the scene was inspected.', reason: 'compaction' });
    snapshot = await handle.replaceSurface({ startNodeId: snapshot.surface.nodes[0].id, endNodeId: snapshot.surface.nodes[1].id, summary: 'The game request, inspection and scoring request are retained.', reason: 'compaction' });
    snapshot = await handle.checkpoint();
    assert.equal(snapshot.surface.generation, 2);
    assert.equal(snapshot.surface.nodes.length, 2);
    assert.deepEqual(snapshot.transcript.map((entry) => entry.content), originalTranscript);
    assert.ok(snapshot.transcript.every((entry) => entry.source === 'append-origin'));
    const digest = snapshot.surface.digest;
    const ops = snapshot.ops;
    await handle.flush(); await runtime.dispose(); await fixture.log.close();

    const reopenedLog = await openLog(fixture.root);
    const reopenedRuntime = new DurableSessionRuntime(reopenedLog, { queryWindow: 3 });
    const reopened = await reopenedRuntime.open('session:g02-surface');
    const replayed = await reopened.snapshot();
    assert.equal(replayed.surface.digest, digest);
    assert.deepEqual(replayed.ops, ops);
    assert.deepEqual(replayed.transcript.map((entry) => entry.content), originalTranscript);
    assert.equal(replayed.session.checkpoint.digest, snapshot.session.checkpoint.digest);
    await reopened.dispose(); await reopenedRuntime.dispose(); await reopenedLog.close();
  } finally { await fixture.cleanup(); }
});

test('every retained SessionOp prefix deterministically produces the same Surface digest', async () => {
  const fixture = await openFixture('prefix-property');
  try {
    const runtime = runtimeFor(fixture.log);
    const handle = await runtime.create({ ...sessionInput, id: 'session:g02-prefix' });
    const expected = new Map([[0, (await handle.snapshot()).surface.digest]]);
    for (let index = 0; index < 24; index += 1) {
      const snapshot = await handle.appendMessage({ role: index % 2 === 0 ? 'user' : 'assistant', content: `Visible message ${index}`, turnId: `turn:g02-${Math.floor(index / 2)}` });
      expected.set(snapshot.ops.at(-1).sequence, snapshot.surface.digest);
    }
    await runtime.dispose(); await fixture.log.close();
    const reopenedLog = await openLog(fixture.root);
    const replay = new DurableSessionRuntime(reopenedLog, { queryWindow: 5 });
    for (const [sequence, digest] of expected) assert.equal((await replay.replay('session:g02-prefix', sequence)).surface.digest, digest, `prefix ${sequence}`);
    await replay.dispose(); await reopenedLog.close();
  } finally { await fixture.cleanup(); }
});

test('fork preserves parent Transcript and Surface projection without copying backend binding truth', async () => {
  const fixture = await openFixture('fork');
  try {
    const runtime = runtimeFor(fixture.log);
    const parent = await runtime.create({ ...sessionInput, id: 'session:g02-parent' });
    await parent.appendMessage({ role: 'user', content: 'Parent request.' });
    await parent.appendMessage({ role: 'assistant', content: 'Parent answer.' });
    let parentSnapshot = await parent.snapshot();
    await parent.replaceSurface({ startNodeId: parentSnapshot.surface.nodes[0].id, endNodeId: parentSnapshot.surface.nodes[1].id, summary: 'Parent summary.', reason: 'compaction' });
    await parent.bindBackend(binding(1));
    parentSnapshot = await parent.snapshot();

    const child = await parent.fork({ id: 'session:g02-child', activeGoal: 'Continue in a branch.' });
    let childSnapshot = await child.snapshot();
    assert.deepEqual(childSnapshot.transcript.map((entry) => entry.content), parentSnapshot.transcript.map((entry) => entry.content));
    assert.deepEqual(childSnapshot.surface.nodes.map((node) => node.messageArtifactId), parentSnapshot.surface.nodes.map((node) => node.messageArtifactId));
    assert.equal(childSnapshot.session.backendBindings.length, 0);
    assert.equal(childSnapshot.session.activeGoal, 'Continue in a branch.');
    childSnapshot = await child.appendMessage({ role: 'user', content: 'Child-only request.' });
    assert.equal(childSnapshot.transcript.length, 3);
    assert.equal((await parent.snapshot()).transcript.length, 2);
    await child.dispose(); await parent.dispose(); await runtime.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('reload marks open effectful tools outcome-unknown, interrupts their turn and checkpoints without retry', async () => {
  const fixture = await openFixture('crash-repair');
  try {
    const runtime = runtimeFor(fixture.log);
    const handle = await runtime.create({ ...sessionInput, id: 'session:g02-crash' });
    await handle.append({ kind: 'turn.started', turnId: 'turn:g02-crash', payload: {} });
    await handle.append({ kind: 'tool-batch.started', turnId: 'turn:g02-crash', batchId: 'batch:g02-crash', payload: {} });
    await handle.append({ kind: 'tool.started', turnId: 'turn:g02-crash', batchId: 'batch:g02-crash', nodeId: 'node:g02-effect', payload: { effect: 'document-mutation', toolId: 'scene.transaction' } });
    await runtime.dispose(); await fixture.log.close();

    const reopenedLog = await openLog(fixture.root);
    const recoveredRuntime = runtimeFor(reopenedLog);
    const recovered = await recoveredRuntime.open('session:g02-crash');
    const snapshot = await recovered.snapshot();
    assert.equal(snapshot.session.status, 'interrupted');
    assert.deepEqual(snapshot.recovery.openTurnIds, []);
    assert.deepEqual(snapshot.recovery.openToolNodeIds, []);
    assert.deepEqual(snapshot.recovery.openBatchIds, []);
    assert.deepEqual(snapshot.recovery.outcomeUnknownNodeIds, ['node:g02-effect']);
    const unknown = snapshot.ops.find((op) => op.kind === 'tool.outcome-unknown');
    assert.equal(unknown.payload.retryAllowed, false);
    assert.equal(unknown.payload.diagnostic, 'session.outcome-unknown');
    assert.equal(snapshot.ops.filter((op) => op.kind === 'tool.started').length, 1, 'recovery must not retry the tool');
    assert.equal(snapshot.session.checkpoint.throughSequence, snapshot.ops.at(-1).sequence);
    await recoveredRuntime.dispose(); await reopenedLog.close();
  } finally { await fixture.cleanup(); }
});

test('a durable approval barrier survives reload without being converted into a crash failure', async () => {
  const fixture = await openFixture('approval-barrier');
  try {
    const runtime = runtimeFor(fixture.log);
    const handle = await runtime.create({ ...sessionInput, id: 'session:g02-approval' });
    await handle.append({ kind: 'turn.started', turnId: 'turn:g02-approval', payload: {} });
    await handle.append({ kind: 'approval.requested', turnId: 'turn:g02-approval', nodeId: 'node:g02-approval', payload: { approvalId: 'approval:g02-long', effect: 'trusted-code' } });
    const beforeCount = (await handle.snapshot()).ops.length;
    await runtime.dispose(); await fixture.log.close();
    const reopenedLog = await openLog(fixture.root);
    const reopenedRuntime = runtimeFor(reopenedLog);
    const reopened = await reopenedRuntime.open('session:g02-approval');
    const snapshot = await reopened.snapshot();
    assert.equal(snapshot.ops.length, beforeCount);
    assert.equal(snapshot.session.status, 'waiting-approval');
    assert.deepEqual(snapshot.recovery.openTurnIds, ['turn:g02-approval']);
    assert.deepEqual(snapshot.recovery.unresolvedBarrierIds, ['approval:g02-long']);
    assert.equal(snapshot.ops.some((op) => op.kind === 'tool.outcome-unknown'), false);
    await reopenedRuntime.dispose(); await reopenedLog.close();
  } finally { await fixture.cleanup(); }
});

test('bad replace, duplicate op and unknown Studio Session events fail closed without valid projection drift', async () => {
  const fixture = await openFixture('fail-closed');
  try {
    const runtime = runtimeFor(fixture.log);
    const handle = await runtime.create({ ...sessionInput, id: 'session:g02-invalid' });
    await handle.appendMessage({ role: 'user', content: 'Keep this message.' });
    const before = await handle.snapshot();
    await assert.rejects(handle.replaceSurface({ startNodeId: before.surface.nodes[0].id, endNodeId: 'surface:missing', summary: 'Invalid', reason: 'compaction' }), hasSessionCode('surface.replace-range-invalid'));
    await assert.rejects(handle.append({ id: before.ops[0].id, kind: 'session.status-changed', payload: { status: 'idle' } }), hasSessionCode('session.sequence-gap'));
    assert.deepEqual((await handle.snapshot()).ops, before.ops);
    await fixture.log.append({ kind: 'agent/session-future', severity: 'info', source: 'studio.agent-session', correlation: { sessionId: 'session:g02-invalid' }, payload: { schemaVersion: 2 } });
    await assert.rejects(handle.snapshot(), hasSessionCode('session.version-unsupported'));
    await runtime.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('partial journal tail recovery retains committed Session ops and repairs the open turn', async () => {
  const fixture = await openFixture('partial-tail');
  try {
    const runtime = runtimeFor(fixture.log);
    const handle = await runtime.create({ ...sessionInput, id: 'session:g02-partial' });
    await handle.append({ kind: 'turn.started', turnId: 'turn:g02-partial', payload: {} });
    await runtime.dispose(); await fixture.log.close();
    await appendFile(path.join(fixture.root, 'journal', 'segment-000001.jsonl'), '{"recordVersion":1,"event":');
    const reopenedLog = await openLog(fixture.root);
    assert.equal(reopenedLog.status().health, 'recovered');
    const reopenedRuntime = runtimeFor(reopenedLog);
    const handle2 = await reopenedRuntime.open('session:g02-partial');
    const snapshot = await handle2.snapshot();
    assert.equal(snapshot.session.status, 'interrupted');
    assert.ok(snapshot.ops.some((op) => op.kind === 'turn.completed' && op.payload.recoveredAfterRestart === true));
    await reopenedRuntime.dispose(); await reopenedLog.close();
  } finally { await fixture.cleanup(); }
});

test('a schema-shaped but semantically corrupt fork seed fails closed', async () => {
  const fixture = await openFixture('corrupt-seed');
  try {
    const seed = await fixture.log.putArtifact({
      schemaVersion: 1, kind: 'agent-session-fork-seed', parentSessionId: 'session:g02-parent-seed', parentThroughSequence: 0,
      parentSurface: { schemaVersion: 1, sessionId: 'session:g02-wrong-parent', generation: 0, throughSequence: 0, nodes: [], lastOperation: null, digest: `sha256:${'0'.repeat(64)}` },
      parentTranscript: [],
    });
    const payload = { projectId: 'project:g02', documentId: 'document:g02', activeGoal: null, taskBudgetId: null, parentSessionId: 'session:g02-parent-seed', forkSeedArtifactId: seed.id };
    const op = { schemaVersion: 1, id: 'op:g02-corrupt-seed', sessionId: 'session:g02-corrupt-seed', sequence: 0, kind: 'session.created', timestamp: '2026-09-01T00:00:00.000Z', turnId: null, stepId: null, batchId: null, nodeId: null, parentOpId: null, dependsOn: [], projectRevision: null, artifactRefs: [seed.id], payload, payloadDigest: sessionPayloadDigest(payload) };
    await fixture.log.append({ eventId: op.id, timestamp: op.timestamp, kind: 'agent/session-op', severity: 'info', source: 'studio.agent-session', correlation: { sessionId: op.sessionId }, payload: { sessionOp: op }, artifactRefs: [seed.id] });
    const runtime = runtimeFor(fixture.log);
    await assert.rejects(runtime.replay(op.sessionId), hasSessionCode('session.fork-seed-invalid'));
    await runtime.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('disposed handles and runtimes reject late writes', async () => {
  const fixture = await openFixture('dispose');
  try {
    const runtime = runtimeFor(fixture.log);
    const handle = await runtime.create({ ...sessionInput, id: 'session:g02-dispose' });
    await handle.dispose();
    assert.throws(() => handle.appendMessage({ role: 'user', content: 'late' }), hasSessionCode('session.handle-disposed'));
    await runtime.dispose();
    await assert.rejects(runtime.replay('session:g02-dispose'), hasSessionCode('session.runtime-disposed'));
    await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('disposing rejects new calls before an already-started append is allowed to finish', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g02-disposing-'));
  let block = false; let releaseWrite; let enteredWrite;
  const entered = new Promise((resolve) => { enteredWrite = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g02-test', flushPolicy: 'always', async faultInjector(point) { if (block && point === 'before-journal-write') { enteredWrite(); await gate; } } });
  try {
    const runtime = runtimeFor(log);
    const handle = await runtime.create({ ...sessionInput, id: 'session:g02-disposing' });
    block = true;
    const pending = handle.append({ kind: 'session.status-changed', payload: { status: 'running' } });
    await entered;
    const disposing = runtime.dispose();
    await assert.rejects(runtime.replay(handle.id), hasSessionCode('session.runtime-disposed'));
    releaseWrite();
    assert.equal((await pending).session.status, 'running');
    await disposing;
    await log.close();
  } finally { releaseWrite?.(); await log.close().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

function binding(generation) {
  return { bindingId: 'binding:g02', backendId: 'backend:harness', provider: 'deepseek', model: 'deepseek-chat', remoteSessionId: 'remote:g02', generation, status: 'active', capabilities: { maxInputTokens: 131072, nativeCompaction: true, parallelToolCalls: true, codeMode: true, providerUsage: 'reported', providerCache: 'reported' }, lastConfirmedOpId: null };
}
function runtimeFor(log) { let index = 0; return new DurableSessionRuntime(log, { clock: () => new Date(`2026-09-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`), idFactory: (kind) => `${kind}:g02:${index++}`, queryWindow: 7 }); }
async function openFixture(name) { const root = await mkdtemp(path.join(tmpdir(), `haiyue-g02-${name}-`)); const log = await openLog(root); return { root, log, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }; }
function openLog(root) { return OperationLog.open({ rootDirectory: root, appVersion: 'g02-test', flushPolicy: 'always' }); }
function hasSessionCode(code) { return (error) => { assert.ok(error instanceof AgentSessionError); assert.equal(error.code, code); return true; }; }
