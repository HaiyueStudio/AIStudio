import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableSessionRuntime } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioSessionOrchestrator } from '@haiyue/ai-studio-agent-orchestration';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-orchestration-'));
  const log = await OperationLog.open({ rootDirectory: directory, appVersion: 'orchestration-test', flushPolicy: 'always' });
  const runtime = new DurableSessionRuntime(log);
  const session = await runtime.create({ id: 'session:orchestration', projectId: 'project:orchestration', documentId: 'document:orchestration', activeGoal: 'recover', taskBudgetId: 'budget:orchestration' });
  t.after(async () => { await session.dispose(); await runtime.dispose(); await log.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  await session.append({ kind: 'turn.started', turnId: 'turn:orchestration', payload: {} });
  await session.append({ kind: 'tool-batch.started', turnId: 'turn:orchestration', batchId: 'batch:orchestration', payload: {} });
  await session.append({ kind: 'tool.started', turnId: 'turn:orchestration', batchId: 'batch:orchestration', nodeId: 'node:orchestration', projectRevision: 4, payload: {
    toolCallId: 'call:orchestration', toolId: 'entity.create', executionClass: 'exclusive-mutation', effects: ['document-mutation'],
    transactionId: 'transaction:orchestration', idempotencyKey: 'idempotency:orchestration', baseRevision: 4, operationDigest: `sha256:${'a'.repeat(64)}`,
  } });
  return { log, session };
}

test('headless recovery accepts a receipt authority and a claim port, synthesizes one completion and releases ownership', async t => {
  const { log, session } = await fixture(t);
  const receipt = await log.putArtifact({ kind: 'test-receipt', transactionId: 'transaction:orchestration' });
  let claimed = false; let calls = 0; let releases = 0;
  const authority = { async reconcileMutation(intent) {
    assert.equal(claimed, true); calls += 1;
    assert.equal(intent.baseRevision, 4);
    return { status: 'committed', transactionId: intent.transactionId, beforeRevision: 4, afterRevision: 5, receiptDigest: receipt.digest, receiptArtifactId: receipt.id };
  } };
  const claims = { async acquire(sessionId, claimId) {
    assert.equal(sessionId, session.id); assert.ok(claimId); assert.equal(claimed, false); claimed = true;
    return { async release() { claimed = false; releases += 1; } };
  } };
  const service = new StudioSessionOrchestrator(authority, log, claims);
  const first = await service.recover(session, 'claim:first');
  assert.equal(first.actions[0].decision, 'synthesized-completion');
  const repeated = await service.recover(session, 'claim:second');
  assert.equal(repeated.actions.length, 0); assert.equal(calls, 1); assert.equal(releases, 2); assert.equal(claimed, false);
  assert.equal(repeated.snapshot.ops.filter(op => op.kind === 'document.committed').length, 1);
  assert.equal(repeated.snapshot.ops.filter(op => op.kind === 'tool.completed').length, 1);
  const audit = await log.query({ kinds: ['agent/session-recovery'], limit: 10 });
  assert.deepEqual(audit.events.map(event => event.payload.claimId), ['claim:first', 'claim:second']);
});

test('a contended injected claim leaves the interrupted session untouched and never calls the authority', async t => {
  const { log, session } = await fixture(t);
  const before = await session.snapshot();
  const service = new StudioSessionOrchestrator({ async reconcileMutation() { assert.fail('contender must not reconcile'); } }, log, { async acquire() { return null; } });
  const run = await service.recover(session, 'claim:contender');
  assert.deepEqual(run.actions, []); assert.deepEqual((await session.snapshot()).ops, before.ops);
  assert.equal((await log.query({ kinds: ['agent/session-recovery-claim-contended'], limit: 10 })).events.length, 1);
});

test('authority failure releases the claim and allows a later recovery to reach the manual barrier', async t => {
  const { log, session } = await fixture(t);
  let released = 0;
  const claims = { async acquire() { return { async release() { released += 1; } }; } };
  const failure = new Error('receipt store unavailable');
  const failing = new StudioSessionOrchestrator({ async reconcileMutation() { throw failure; } }, log, claims);
  await assert.rejects(failing.recover(session, 'claim:failed'), error => error === failure);
  assert.equal(released, 1);
  const retry = new StudioSessionOrchestrator({ async reconcileMutation(intent) { return { status: 'ambiguous', transactionId: intent.transactionId, currentRevision: 5, reason: 'Missing receipt' }; } }, log, claims);
  const run = await retry.recover(session, 'claim:retry');
  assert.equal(run.actions[0].decision, 'manual-barrier'); assert.equal(run.barrierIds.length, 1); assert.equal(released, 2);
  assert.equal(run.snapshot.ops.some(op => op.kind === 'document.committed'), false);
});
