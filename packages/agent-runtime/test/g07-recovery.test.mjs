import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableSessionRecoveryCoordinator, DurableSessionRuntime } from '../dist/index.js';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

async function fixture(name) {
  const root = await mkdtemp(path.join(tmpdir(), `haiyue-g07-recovery-${name}-`));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
  const runtime = new DurableSessionRuntime(log, { queryWindow: 20 });
  const handle = await runtime.create({ id: `session:g07:${name}`, projectId: 'project:g07', documentId: 'document:g07', activeGoal: 'recover', taskBudgetId: 'budget:g07' });
  return { root, log, runtime, handle };
}

async function startOpenTool(value, nodeId, payload) {
  const turnId = `turn:${nodeId}`; const batchId = `batch:${nodeId}`;
  await value.handle.append({ kind: 'turn.started', turnId, payload: {} });
  await value.handle.append({ kind: 'tool-batch.started', turnId, batchId, payload: {} });
  await value.handle.append({ kind: 'tool.started', turnId, batchId, nodeId, projectRevision: 4, payload });
  return { turnId, batchId };
}

test('committed-no-ack is reconciled into one synthesized completion without retry', async () => {
  const value = await fixture('committed');
  const receipt = await value.log.putArtifact({ schemaVersion: 1, kind: 'fixture-receipt', transactionId: 'transaction:g07:committed' });
  await startOpenTool(value, 'node:g07:committed', {
    toolCallId: 'call:g07:committed', toolId: 'camera.set', executionClass: 'exclusive-mutation', effects: ['document-mutation'],
    transactionId: 'transaction:g07:committed', idempotencyKey: 'idempotency:g07:committed', baseRevision: 4, operationDigest: `sha256:${'a'.repeat(64)}`,
  });
  let reconciliations = 0;
  const coordinator = new DurableSessionRecoveryCoordinator({ async reconcileMutation(intent) {
    reconciliations += 1; assert.equal(intent.transactionId, 'transaction:g07:committed');
    return { status: 'committed', transactionId: intent.transactionId, beforeRevision: 4, afterRevision: 5, receiptDigest: `sha256:${'b'.repeat(64)}`, receiptArtifactId: receipt.id };
  } });
  const run = await coordinator.recover(value.handle, 'claim:g07:committed');
  assert.equal(run.actions[0].decision, 'synthesized-completion');
  assert.equal(run.snapshot.ops.filter((op) => op.kind === 'document.committed').length, 1);
  assert.equal(run.snapshot.ops.filter((op) => op.kind === 'tool.completed' && op.payload.synthesized === true).length, 1);
  assert.deepEqual(run.snapshot.recovery.outcomeUnknownNodeIds, []);
  assert.deepEqual(run.snapshot.recovery.openToolNodeIds, []);
  assert.deepEqual(run.snapshot.recovery.openBatchIds, []);
  assert.deepEqual(run.snapshot.recovery.openTurnIds, []);
  const repeated = await coordinator.recover(value.handle, 'claim:g07:repeated');
  assert.equal(repeated.actions.length, 0); assert.equal(reconciliations, 1);
  await dispose(value);
});

test('a planned tool that crashed before tool.started is durably classified for retry', async () => {
  const value = await fixture('before-start');
  const turnId = 'turn:g07:before-start'; const batchId = 'batch:g07:before-start'; const nodeId = 'node:g07:before-start';
  await value.handle.append({ kind: 'turn.started', turnId, payload: {} });
  await value.handle.append({ kind: 'tool-batch.planned', turnId, batchId, nodeId, projectRevision: 4, payload: { profile: 'tool-node-plan/1', toolCallId: 'call:g07:before-start', toolId: 'scene.query', executionClass: 'parallel-read', effects: ['observe'] } });
  await value.handle.append({ kind: 'tool-batch.started', turnId, batchId, payload: {} });
  const coordinator = new DurableSessionRecoveryCoordinator({ async reconcileMutation() { throw new Error('mutation authority must not run'); } });
  const run = await coordinator.recover(value.handle, 'claim:g07:before-start');
  assert.deepEqual(run.actions, [{ nodeId, decision: 'retry-not-started', transactionId: null, diagnostic: 'session.tool-not-started' }]);
  const completed = run.snapshot.ops.find((op) => op.kind === 'tool-batch.completed');
  assert.equal(completed.payload.resumable, true); assert.deepEqual(completed.payload.resumableNodeIds, [nodeId]);
  assert.deepEqual(run.snapshot.recovery.openBatchIds, []); assert.deepEqual(run.snapshot.recovery.openTurnIds, []);
  await dispose(value);
});

test('receipt discovery by member closes the crash window before transaction identity reached Session', async () => {
  const value = await fixture('member-discovery');
  const receipt = await value.log.putArtifact({ schemaVersion: 1, kind: 'fixture-receipt', transactionId: 'transaction:g07:discovered' });
  await startOpenTool(value, 'node:g07:discovered', { toolCallId: 'call:g07:discovered', toolId: 'entity.create', executionClass: 'exclusive-mutation', effects: ['document-mutation'], expectedRevision: 4 });
  let discoveries = 0;
  const coordinator = new DurableSessionRecoveryCoordinator({
    async reconcileMutation() { throw new Error('identity reconciliation must not run'); },
    async discoverMutation(intent) { discoveries += 1; assert.equal(intent.nodeId, 'node:g07:discovered'); return { status: 'committed', transactionId: 'transaction:g07:discovered', beforeRevision: 4, afterRevision: 5, receiptDigest: `sha256:${'e'.repeat(64)}`, receiptArtifactId: receipt.id }; },
  });
  const run = await coordinator.recover(value.handle, 'claim:g07:discovered');
  assert.equal(discoveries, 1); assert.equal(run.actions[0].decision, 'synthesized-completion');
  assert.equal(run.snapshot.ops.some((op) => op.kind === 'tool.outcome-unknown' && op.payload.discoveredByMember === true), true);
  assert.deepEqual(run.snapshot.recovery.openToolNodeIds, []);
  await dispose(value);
});

test('a prepared mutation that crashed before commit is discovered as not committed and safely re-prepared', async () => {
  const value = await fixture('prepared-no-commit');
  await startOpenTool(value, 'node:g07:prepared-no-commit', { toolCallId: 'call:g07:prepared-no-commit', toolId: 'entity.create', executionClass: 'exclusive-mutation', effects: ['document-mutation'], expectedRevision: 4, preparationId: 'preparation:g07:prepared-no-commit' });
  let discoveries = 0;
  const coordinator = new DurableSessionRecoveryCoordinator({
    async reconcileMutation() { throw new Error('identity reconciliation must not run'); },
    async discoverMutation(intent) { discoveries += 1; return { status: 'not-committed', transactionId: 'transaction:g07:prepared-no-commit', currentRevision: intent.baseRevision }; },
  });
  const run = await coordinator.recover(value.handle, 'claim:g07:prepared-no-commit');
  assert.equal(discoveries, 1);
  assert.deepEqual(run.actions, [{ nodeId: 'node:g07:prepared-no-commit', decision: 'retry-not-committed', transactionId: 'transaction:g07:prepared-no-commit', diagnostic: 'session.not-committed' }]);
  assert.equal(run.snapshot.ops.some((op) => op.kind === 'document.committed'), false);
  assert.equal(run.snapshot.session.status, 'interrupted');
  await dispose(value);
});

test('read interruption and confirmed not-committed mutation are resumable but never auto-commit', async () => {
  const value = await fixture('retry');
  const turnId = 'turn:g07:retry'; const batchId = 'batch:g07:retry';
  await value.handle.append({ kind: 'turn.started', turnId, payload: {} });
  await value.handle.append({ kind: 'tool-batch.started', turnId, batchId, payload: {} });
  await value.handle.append({ kind: 'tool.started', turnId, batchId, nodeId: 'node:g07:read', projectRevision: 4, payload: { toolCallId: 'call:g07:read', toolId: 'scene.query', executionClass: 'parallel-read', effects: ['observe'] } });
  await value.handle.append({ kind: 'tool.started', turnId, batchId, nodeId: 'node:g07:not-committed', projectRevision: 4, payload: { toolCallId: 'call:g07:not-committed', toolId: 'camera.set', executionClass: 'exclusive-mutation', effects: ['document-mutation'], transactionId: 'transaction:g07:not-committed', idempotencyKey: 'idempotency:g07:not-committed', baseRevision: 4, operationDigest: `sha256:${'c'.repeat(64)}` } });
  const coordinator = new DurableSessionRecoveryCoordinator({ async reconcileMutation(intent) { return { status: 'not-committed', transactionId: intent.transactionId, currentRevision: 4 }; } });
  const run = await coordinator.recover(value.handle, 'claim:g07:retry');
  assert.deepEqual(run.actions.map((action) => action.decision), ['retry-read', 'retry-not-committed']);
  assert.equal(run.snapshot.ops.some((op) => op.kind === 'document.committed'), false);
  assert.equal(run.snapshot.session.status, 'interrupted');
  assert.deepEqual(run.snapshot.recovery.openBatchIds, []);
  assert.deepEqual(run.snapshot.recovery.openTurnIds, []);
  assert.deepEqual(run.snapshot.recovery.outcomeUnknownNodeIds, ['node:g07:not-committed', 'node:g07:read']);
  await dispose(value);
});

test('ambiguous mutation creates a durable non-expiring takeover barrier and repeated recovery preserves it', async () => {
  const value = await fixture('ambiguous');
  await startOpenTool(value, 'node:g07:ambiguous', { toolCallId: 'call:g07:ambiguous', toolId: 'camera.set', executionClass: 'exclusive-mutation', effects: ['document-mutation'], transactionId: 'transaction:g07:ambiguous', idempotencyKey: 'idempotency:g07:ambiguous', baseRevision: 4, operationDigest: `sha256:${'d'.repeat(64)}` });
  let calls = 0;
  const coordinator = new DurableSessionRecoveryCoordinator({ async reconcileMutation(intent) { calls += 1; return { status: 'ambiguous', transactionId: intent.transactionId, currentRevision: 5, reason: 'Revision advanced without a matching receipt.' }; } });
  const first = await coordinator.recover(value.handle, 'claim:g07:ambiguous');
  assert.equal(first.actions[0].decision, 'manual-barrier');
  assert.deepEqual(first.barrierIds, ['barrier:recovery:node:g07:ambiguous']);
  assert.equal(first.snapshot.session.status, 'waiting-user');
  assert.deepEqual(first.snapshot.recovery.unresolvedBarrierIds, first.barrierIds);
  const question = first.snapshot.ops.find((op) => op.kind === 'question.requested');
  assert.equal(question.payload.expiresAt, null);
  const before = first.snapshot.ops.length;
  const repeated = await coordinator.recover(value.handle, 'claim:g07:ambiguous-repeat');
  assert.equal(repeated.snapshot.ops.length, before);
  assert.equal(repeated.actions.length, 0); assert.equal(calls, 1);
  await dispose(value);
});

test('two recovery hosts serialize the durable claim and reconcile an open mutation only once', async () => {
  const value = await fixture('dual-host');
  const receipt = await value.log.putArtifact({ schemaVersion: 1, kind: 'fixture-receipt', transactionId: 'transaction:g07:dual-host' });
  await startOpenTool(value, 'node:g07:dual-host', { toolCallId: 'call:g07:dual-host', toolId: 'entity.rename', executionClass: 'exclusive-mutation', effects: ['document-mutation'], transactionId: 'transaction:g07:dual-host', idempotencyKey: 'idempotency:g07:dual-host', baseRevision: 4, operationDigest: `sha256:${'f'.repeat(64)}` });
  let calls = 0;
  const authority = { async reconcileMutation(intent) {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 'committed', transactionId: intent.transactionId, beforeRevision: 4, afterRevision: 5, receiptDigest: `sha256:${'1'.repeat(64)}`, receiptArtifactId: receipt.id };
  } };
  const first = new DurableSessionRecoveryCoordinator(authority);
  const second = new DurableSessionRecoveryCoordinator(authority);
  const runs = await Promise.all([first.recover(value.handle, 'claim:g07:host-a'), second.recover(value.handle, 'claim:g07:host-b')]);
  assert.equal(calls, 1);
  assert.deepEqual(runs.map((run) => run.actions.length).sort(), [0, 1]);
  const snapshot = await value.handle.snapshot();
  assert.equal(snapshot.ops.filter((op) => op.kind === 'document.committed').length, 1);
  assert.equal(snapshot.ops.filter((op) => op.kind === 'tool.completed' && op.payload.synthesized === true).length, 1);
  await dispose(value);
});

test('a checkpoint freezes a Surface snapshot copy without freezing later Session appends', async () => {
  const value = await fixture('checkpoint-copy');
  await value.handle.appendMessage({ role: 'user', content: 'before checkpoint' });
  await value.handle.checkpoint();
  await value.handle.appendMessage({ role: 'assistant', content: 'after checkpoint' });
  const snapshot = await value.handle.snapshot();
  assert.deepEqual(snapshot.transcript.map((entry) => entry.content), ['before checkpoint', 'after checkpoint']);
  assert.equal(snapshot.surface.nodes.length, 2);
  await dispose(value);
});

test('crash after document acknowledgement but before tool completion reuses the existing commit projection', async () => {
  const value = await fixture('after-ack-before-checkpoint');
  const receipt = await value.log.putArtifact({ schemaVersion: 1, kind: 'fixture-receipt', transactionId: 'transaction:g07:after-ack' });
  const { turnId, batchId } = await startOpenTool(value, 'node:g07:after-ack', { toolCallId: 'call:g07:after-ack', toolId: 'entity.rename', executionClass: 'exclusive-mutation', effects: ['document-mutation'], transactionId: 'transaction:g07:after-ack', idempotencyKey: 'idempotency:g07:after-ack', baseRevision: 4, operationDigest: `sha256:${'2'.repeat(64)}` });
  await value.handle.append({ kind: 'document.committed', turnId, batchId, projectRevision: 5, artifactRefs: [receipt.id], payload: { transactionId: 'transaction:g07:after-ack', beforeRevision: 4, afterRevision: 5, receiptDigest: `sha256:${'3'.repeat(64)}`, receiptArtifactId: receipt.id, memberNodeIds: ['node:g07:after-ack'] } });
  const coordinator = new DurableSessionRecoveryCoordinator({ async reconcileMutation(intent) { return { status: 'committed', transactionId: intent.transactionId, beforeRevision: 4, afterRevision: 5, receiptDigest: `sha256:${'3'.repeat(64)}`, receiptArtifactId: receipt.id }; } });
  const run = await coordinator.recover(value.handle, 'claim:g07:after-ack');
  assert.equal(run.snapshot.ops.filter((op) => op.kind === 'document.committed').length, 1);
  assert.equal(run.snapshot.ops.filter((op) => op.kind === 'tool.completed' && op.payload.synthesized === true).length, 1);
  assert.equal(run.actions[0].decision, 'synthesized-completion'); assert.deepEqual(run.snapshot.recovery.openToolNodeIds, []);
  await dispose(value);
});

async function dispose(value) { await value.handle.dispose(); await value.runtime.dispose(); await value.log.close(); await rm(value.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
