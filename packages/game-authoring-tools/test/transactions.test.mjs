import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { ProjectWorkspace, RecentProjectStore } from '@haiyue/ai-studio-editor-plugins';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { SceneTransactionCoordinator } from '../dist/index.js';

async function fixture(transactionFaultInjector) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-transaction-project-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-transaction-user-'));
  const operationLog = await OperationLog.open({ rootDirectory: path.join(userDataRoot, 'operation-log'), appVersion: '0.0.0-test', eventId: (sequence) => asStableId(`event:g07-transaction:${sequence}`) });
  const resources = {
    documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(userDataRoot),
    ...(transactionFaultInjector ? { transactionFaultInjector } : {}),
  };
  const workspace = new ProjectWorkspace(resources);
  await workspace.newProject(projectRoot, 'G07 transaction fixture');
  return { projectRoot, userDataRoot, operationLog, resources, workspace, coordinator: new SceneTransactionCoordinator(workspace, operationLog) };
}

function input(documentId, members = 7) {
  return {
    sessionId: asStableId('session:g07-transaction'), turnId: asStableId('turn:g07-transaction'), batchId: asStableId('batch:g07-transaction'), documentId, baseRevision: 1, label: 'Seven member scene transaction',
    members: Array.from({ length: members }, (_, index) => ({
      nodeId: asStableId(`node:g07:${index}`), toolCallId: asStableId(`call:g07:${index}`), toolId: asStableId('camera.set'), toolVersion: '1.0.0', effectKeys: [asStableId(`entity:g07:${index}`)],
      operations: [{ op: 'setting.set', key: `g07.member.${index}`, value: index }],
    })),
  };
}

test('coordinator prepares without mutation and commits 7 members as one idempotent History transaction', async () => {
  const value = await fixture();
  const documentId = value.workspace.snapshot().document.documentId;
  const plan = await value.coordinator.prepare(input(documentId));
  assert.equal(plan.operationCount, 7);
  assert.equal(value.workspace.snapshot().document.revision, 1);
  assert.equal(value.workspace.snapshot().history.entries.length, 0);
  const first = await value.coordinator.commit(plan.id);
  assert.equal(first.commit.replayed, false);
  assert.equal(first.commit.snapshot.document.revision, 2);
  assert.equal(first.commit.snapshot.history.entries.length, 1);
  assert.equal(first.commit.receipt.memberNodeIds.length, 7);
  const second = await value.coordinator.commit(plan.id);
  assert.equal(second.commit.replayed, true);
  assert.equal(second.commit.snapshot.document.revision, 2);
  assert.equal(second.commit.snapshot.history.entries.length, 1);
  assert.equal((await value.coordinator.reconcile(plan.id)).status, 'committed');
  const metrics = value.coordinator.snapshot().metrics;
  assert.deepEqual({ prepareAttempts: metrics.prepareAttempts, prepared: metrics.prepared, commitAttempts: metrics.commitAttempts, committed: metrics.committed, duplicatesPrevented: metrics.duplicatesPrevented, reconciliations: metrics.reconciliations }, { prepareAttempts: 1, prepared: 1, commitAttempts: 2, committed: 1, duplicatesPrevented: 1, reconciliations: 1 });
  for (const field of ['prepareLatencyMs', 'commitLatencyMs', 'reconcileLatencyMs', 'lockWaitMs']) assert.equal(Number.isSafeInteger(metrics[field]) && metrics[field] >= 0, true, `${field} must be a non-negative metric`);
  await dispose(value);
});

test('coordinator commits the 100-member boundary as one revision and one History entry', async () => {
  const value = await fixture();
  const plan = await value.coordinator.prepare(input(value.workspace.snapshot().document.documentId, 100));
  assert.equal(plan.operationCount, 100);
  const result = await value.coordinator.commit(plan.id);
  assert.equal(result.commit.snapshot.document.revision, 2);
  assert.equal(result.commit.snapshot.history.entries.length, 1);
  assert.equal(result.commit.receipt.memberNodeIds.length, 100);
  assert.equal(Object.keys(result.commit.snapshot.document.settings).filter((key) => key.startsWith('g07.member.')).length, 100);
  await dispose(value);
});

test('disjoint entity transactions prepare concurrently from one frozen revision without acquiring commit locks', async () => {
  const value = await fixture();
  const documentId = value.workspace.snapshot().document.documentId;
  const leftInput = input(documentId, 1);
  const rightInput = { ...input(documentId, 1), turnId: asStableId('turn:g07-transaction-disjoint'), batchId: asStableId('batch:g07-transaction-disjoint'), members: [{ ...input(documentId, 1).members[0], nodeId: asStableId('node:g07:disjoint'), toolCallId: asStableId('call:g07:disjoint'), effectKeys: [asStableId('entity:g07:disjoint')], operations: [{ op: 'setting.set', key: 'g07.disjoint', value: true }] }] };
  const [left, right] = await Promise.all([value.coordinator.prepare(leftInput), value.coordinator.prepare(rightInput)]);
  assert.notEqual(left.id, right.id); assert.deepEqual(left.effectKeys, ['document:current', 'entity:g07:0']); assert.deepEqual(right.effectKeys, ['document:current', 'entity:g07:disjoint']);
  assert.equal(value.workspace.snapshot().document.revision, 1); assert.equal(value.workspace.snapshot().history.entries.length, 0);
  assert.equal(value.coordinator.snapshot().locks.heldOwners, 0); assert.equal(value.coordinator.snapshot().metrics.prepared, 2);
  await dispose(value);
});

test('stale revision introduced between prepare and commit rejects without a partial transaction', async () => {
  const value = await fixture();
  const documentId = value.workspace.snapshot().document.documentId;
  const plan = await value.coordinator.prepare(input(documentId, 2));
  await value.workspace.execute({ id: asStableId('command:g07-racing-edit'), label: 'Racing edit', baseRevision: 1, key: 'g07.racing', value: true });
  await assert.rejects(value.coordinator.commit(plan.id), (error) => error?.code === 'stale-project-revision');
  const snapshot = value.workspace.snapshot();
  assert.equal(snapshot.document.revision, 2);
  assert.equal(snapshot.document.settings['g07.racing'], true);
  assert.equal(snapshot.document.settings['g07.member.0'], undefined);
  assert.equal(snapshot.document.settings['g07.member.1'], undefined);
  assert.equal(snapshot.history.entries.length, 1);
  assert.equal((await value.coordinator.reconcile(plan.id)).status, 'ambiguous');
  assert.equal(value.coordinator.snapshot().metrics.staleRevisions, 1);
  assert.equal(value.coordinator.snapshot().metrics.ambiguous, 2);
  await dispose(value);
});

test('stale base is rejected during prepare before any plan, mutation or History entry exists', async () => {
  const value = await fixture();
  const transactionInput = input(value.workspace.snapshot().document.documentId, 2); transactionInput.baseRevision = 0;
  await assert.rejects(value.coordinator.prepare(transactionInput), (error) => error?.code === 'scene-transaction.stale-revision');
  assert.equal(value.coordinator.snapshot().plans, 0); assert.equal(value.coordinator.snapshot().metrics.prepareFailures, 1); assert.equal(value.coordinator.snapshot().metrics.staleRevisions, 1);
  assert.equal(value.workspace.snapshot().document.revision, 1); assert.equal(value.workspace.snapshot().history.entries.length, 0);
  await dispose(value);
});

test('coordinator synthesizes committed-no-ack and never submits the transaction twice', async () => {
  let injected = false;
  const value = await fixture((point) => { if (!injected && point === 'after-commit-event') { injected = true; throw new Error('lost ack after commit event'); } });
  const plan = await value.coordinator.prepare(input(value.workspace.snapshot().document.documentId, 2));
  const result = await value.coordinator.commit(plan.id);
  assert.equal(result.commit.replayed, true);
  assert.equal(result.commit.snapshot.document.revision, 2);
  assert.equal(result.commit.snapshot.history.entries.length, 1);
  const facts = await value.operationLog.query({ transactionId: plan.id, limit: 20, traverseCorrelation: false });
  assert.ok(facts.events.some((event) => event.kind === 'scene-transaction/reconciled'));
  assert.equal(facts.events.filter((event) => event.kind === 'document/transaction-committed').length, 1);
  await dispose(value);
});

test('failure before History write preserves prepared artifacts and leaves the document untouched', async () => {
  let injected = false;
  const value = await fixture((point) => { if (!injected && point === 'before-history-write') { injected = true; throw new Error('injected failure before History write'); } });
  const preparedArtifact = await value.operationLog.putArtifact({ schemaVersion: 1, kind: 'g07-prepared-output', value: 'retained' });
  const plan = await value.coordinator.prepare(input(value.workspace.snapshot().document.documentId, 2));
  await assert.rejects(value.coordinator.commit(plan.id), /injected failure before History write/);
  assert.equal(value.workspace.snapshot().document.revision, 1);
  assert.equal(value.workspace.snapshot().history.entries.length, 0);
  assert.equal((await value.coordinator.reconcile(plan.id)).status, 'not-committed');
  assert.equal((await value.operationLog.readArtifact(preparedArtifact.id)).value.value, 'retained');
  await dispose(value);
});

test('invalid member operations fail during prepare and leave no partial Scene state or History entry', async () => {
  const value = await fixture();
  const transactionInput = input(value.workspace.snapshot().document.documentId, 2);
  transactionInput.members[1].operations[0] = { op: 'setting.set', key: '../invalid', value: true };
  await assert.rejects(value.coordinator.prepare(transactionInput), /Invalid project setting key/);
  assert.equal(value.workspace.snapshot().document.revision, 1);
  assert.equal(value.workspace.snapshot().document.settings['g07.member.0'], undefined);
  assert.equal(value.workspace.snapshot().history.entries.length, 0);
  assert.equal(value.coordinator.snapshot().plans, 0); assert.equal(value.coordinator.snapshot().metrics.prepareFailures, 1);
  await dispose(value);
});

async function dispose(value) {
  await value.workspace.dispose(); value.resources.tasks.dispose(); await value.resources.documents.dispose(); value.resources.history.dispose(); value.resources.projectSession.dispose(); await value.operationLog.close();
}
