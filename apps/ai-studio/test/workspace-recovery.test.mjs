import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { DurableSessionRuntime } from '@haiyue/ai-studio-agent-runtime';
import { StudioSessionOrchestrator } from '@haiyue/ai-studio-agent-orchestration';
import { ProjectWorkspace, RecentProjectStore } from '@haiyue/ai-studio-editor-plugins';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { RecoveryClaimStore } from '../dist/session-orchestrator/index.js';
import { createWorkspaceRecoveryAuthority } from '../dist/session-orchestrator/workspace-recovery.js';

for (const identityRecorded of [true, false]) test(`app recovery adapter reconciles real History ${identityRecorded ? 'by transaction identity' : 'by member discovery'} without repeating the edit`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-app-recovery-'));
  const log = await OperationLog.open({ rootDirectory: path.join(root, 'log'), appVersion: 'adapter-test', flushPolicy: 'always' });
  const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog: log, recentProjects: new RecentProjectStore(root) };
  const workspace = new ProjectWorkspace(resources);
  const sessions = new DurableSessionRuntime(log);
  try {
    const projectRoot = path.join(root, 'project'); await mkdir(projectRoot);
    await workspace.newProject(projectRoot, 'Recovery adapter integration');
    const project = workspace.snapshot().document;
    const session = await sessions.create({ id: 'session:adapter', projectId: project.projectId, documentId: project.documentId, activeGoal: 'recover', taskBudgetId: 'budget:adapter' });
    const { receipt } = await workspace.executeTransaction({ id: 'command:adapter', label: 'Add once', baseRevision: project.revision, transactionId: 'transaction:adapter', idempotencyKey: 'idempotency:adapter', memberNodeIds: ['node:adapter'], operations: [
      { op: 'entity.add', entity: { id: 'entity:adapter', sceneId: workspace.primarySceneId(), name: 'Single entity', parentId: null, order: 0, componentIds: [] } },
    ] });
    await session.append({ kind: 'turn.started', turnId: 'turn:adapter', payload: {} });
    await session.append({ kind: 'tool-batch.started', turnId: 'turn:adapter', batchId: 'batch:adapter', payload: {} });
    await session.append({ kind: 'tool.started', turnId: 'turn:adapter', batchId: 'batch:adapter', nodeId: 'node:adapter', projectRevision: project.revision, payload: {
      toolCallId: 'call:adapter', toolId: 'entity.create', executionClass: 'exclusive-mutation', effects: ['document-mutation'], baseRevision: project.revision,
      ...(identityRecorded ? { transactionId: receipt.transactionId, idempotencyKey: receipt.idempotencyKey, operationDigest: receipt.operationDigest } : {}),
    } });
    const before = workspace.snapshot();
    const claims = new RecoveryClaimStore(path.join(root, 'claims'));
    const orchestrator = new StudioSessionOrchestrator(createWorkspaceRecoveryAuthority(workspace), log, claims);
    const recovered = await orchestrator.recover(session, 'claim:adapter');
    assert.equal(recovered.actions[0].decision, 'synthesized-completion');
    const acknowledgement = recovered.snapshot.ops.find(op => op.kind === 'document.committed');
    assert.equal(acknowledgement.projectRevision, receipt.afterRevision);
    assert.equal(acknowledgement.payload.receiptDigest, receipt.receiptDigest);
    assert.deepEqual((await orchestrator.recover(session, 'claim:adapter-repeat')).actions, []);
    assert.deepEqual(workspace.snapshot().document, before.document);
    assert.deepEqual(workspace.snapshot().history, before.history);
    const nextLease = await claims.acquire(session.id, 'claim:next-owner'); assert.ok(nextLease); await nextLease.release();
    await session.dispose();
  } finally {
    await sessions.dispose(); await workspace.dispose(); resources.tasks.dispose(); await resources.documents.dispose(); resources.history.dispose(); resources.projectSession.dispose(); await log.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
