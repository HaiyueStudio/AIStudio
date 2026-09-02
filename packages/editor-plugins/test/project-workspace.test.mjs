import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EditorDocumentHost,
  EditorHistoryService,
  EditorProjectSessionState,
  EditorTaskCoordinator,
} from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, OperationLog, sha256 } from '@haiyue/ai-studio-operation-log';
import {
  ProjectDocument,
  ProjectPathError,
  ProjectRepository,
  ProjectRevisionError,
  ProjectWorkspace,
  RecentProjectStore,
} from '../dist/index.js';

async function temp(name) { return mkdtemp(path.join(tmpdir(), `haiyue-${name}-`)); }

async function fixture(options = {}) {
  const projectRoot = await temp('project');
  const userDataRoot = await temp('userdata');
  const operationLog = await OperationLog.open({
    rootDirectory: path.join(userDataRoot, 'operation-log'), appVersion: '0.0.0-test',
    clock: () => new Date('2026-08-19T01:00:00.000Z'), eventId: (sequence) => asStableId(`event:workspace:${sequence}`),
  });
  const resources = {
    documents: new EditorDocumentHost(),
    history: new EditorHistoryService(),
    tasks: new EditorTaskCoordinator(),
    projectSession: new EditorProjectSessionState(),
    operationLog,
    recentProjects: new RecentProjectStore(userDataRoot),
    ...(options.transactionFaultInjector ? { transactionFaultInjector: options.transactionFaultInjector } : {}),
  };
  return { projectRoot, userDataRoot, operationLog, resources, workspace: new ProjectWorkspace(resources) };
}

test('scene transaction commits one revision and History entry and replays the durable receipt idempotently', async () => {
  const value = await fixture();
  await value.workspace.newProject(value.projectRoot, 'Transaction fixture');
  const input = {
    id: asStableId('command:transaction-fixture'),
    transactionId: asStableId('transaction:fixture'),
    idempotencyKey: asStableId('idempotency:fixture'),
    label: 'Atomic scene edit',
    baseRevision: 1,
    memberNodeIds: [asStableId('node:first'), asStableId('node:second')],
    operations: [
      { op: 'setting.set', key: 'fixture.first', value: 1 },
      { op: 'setting.set', key: 'fixture.second', value: 2 },
    ],
  };
  const committed = await value.workspace.executeTransaction(input);
  assert.equal(committed.replayed, false);
  assert.equal(committed.snapshot.document.revision, 2);
  assert.equal(committed.snapshot.history.entries.length, 1);
  assert.equal(committed.receipt.beforeRevision, 1);
  assert.equal(committed.receipt.afterRevision, 2);
  assert.equal(committed.receipt.historyEntryId, committed.snapshot.history.entries[0].id);
  assert.equal(committed.receipt.sceneDiffTransactionId, input.transactionId);
  assert.deepEqual(committed.receipt.resultArtifactIds, [committed.receipt.sceneDiffArtifactId]);
  const storedDiff = await value.operationLog.readArtifact(committed.receipt.sceneDiffArtifactId);
  assert.equal(storedDiff.value.transactionId, input.transactionId);
  assert.equal(storedDiff.value.beforeRevision, 1); assert.equal(storedDiff.value.afterRevision, 2);
  const replayed = await value.workspace.executeTransaction(input);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.snapshot.document.revision, 2);
  assert.equal(replayed.snapshot.history.entries.length, 1);
  assert.equal(replayed.receipt.artifactId, committed.receipt.artifactId);
  assert.deepEqual(replayed.receipt, committed.receipt);
  assert.equal(sha256(canonicalStringify(replayed.snapshot.document.settings)), sha256(canonicalStringify(committed.snapshot.document.settings)));
  assert.deepEqual(await value.workspace.reconcileTransaction(input), { status: 'committed', receipt: committed.receipt });
  assert.deepEqual(await value.workspace.reconcileTransactionMember(asStableId('node:second'), 1), { status: 'committed', receipt: committed.receipt });
  assert.equal((await value.workspace.reconcileTransactionMember(asStableId('node:missing'), 1)).status, 'ambiguous');
  await assert.rejects(value.workspace.executeTransaction({ ...input, operations: [{ op: 'setting.set', key: 'fixture.first', value: 9 }] }), (error) => error.code === 'transaction-idempotency-conflict');
  await assert.rejects(value.workspace.executeTransaction({ ...input, id: asStableId('command:transaction-other'), transactionId: asStableId('transaction:other'), baseRevision: 2, operations: [{ op: 'setting.set', key: 'fixture.other', value: true }] }), (error) => error.code === 'transaction-idempotency-conflict');
  assert.equal(value.workspace.snapshot().document.revision, 2); assert.equal(value.workspace.snapshot().document.settings['fixture.other'], undefined);
  const facts = await value.operationLog.query({ transactionId: input.transactionId, limit: 20, traverseCorrelation: false });
  assert.deepEqual(facts.events.map((event) => event.kind), ['document/transaction-requested', 'document/transaction-receipt-written', 'document/transaction-committed']);
  await disposeFixture(value);
});

test('transaction undo and redo retain the authoritative receipt and Scene diff provenance', async () => {
  const value = await fixture();
  await value.workspace.newProject(value.projectRoot, 'Transaction provenance fixture');
  const input = {
    id: asStableId('command:transaction-provenance'), transactionId: asStableId('transaction:provenance'), idempotencyKey: asStableId('idempotency:provenance'),
    label: 'Provenance edit', baseRevision: 1, memberNodeIds: [asStableId('node:provenance')], operations: [{ op: 'setting.set', key: 'fixture.provenance', value: 'retained' }],
  };
  const committed = await value.workspace.executeTransaction(input);
  const originalReceiptArtifact = committed.receipt.artifactId; const originalDiffArtifact = committed.receipt.sceneDiffArtifactId;
  let diff = value.workspace.diffScene({ fromRevision: 1, toRevision: 2 });
  assert.deepEqual(diff.diff.transactionIds, [input.transactionId]);
  assert.equal(diff.diff.provenanceOpIds.length, 1);
  await value.workspace.undo(2, asStableId('command:undo-transaction-provenance'));
  assert.equal(value.workspace.snapshot().document.settings['fixture.provenance'], undefined);
  await value.workspace.redo(3, asStableId('command:redo-transaction-provenance'));
  assert.equal(value.workspace.snapshot().document.settings['fixture.provenance'], 'retained');
  diff = value.workspace.diffScene({ fromRevision: 1, toRevision: 4 });
  assert.equal(diff.diff.transactionIds.length, 3); assert.equal(diff.diff.transactionIds.includes(input.transactionId), true);
  assert.equal(diff.diff.transactionIds.some((id) => /^transaction:undo:/.test(id)), true); assert.equal(diff.diff.transactionIds.some((id) => /^transaction:redo:/.test(id)), true);
  assert.equal(diff.diff.provenanceOpIds.length, 3);
  const reconciled = await value.workspace.reconcileTransaction(input);
  assert.equal(reconciled.status, 'committed'); assert.equal(reconciled.receipt.artifactId, originalReceiptArtifact); assert.equal(reconciled.receipt.sceneDiffArtifactId, originalDiffArtifact);
  assert.equal((await value.operationLog.readArtifact(originalDiffArtifact)).value.transactionId, input.transactionId);
  await disposeFixture(value);
});

test('missing and corrupt transaction receipt artifacts fail closed', async () => {
  const value = await fixture();
  await value.workspace.newProject(value.projectRoot, 'Receipt corruption fixture');
  const document = value.workspace.snapshot().document;
  const missingInput = { id: asStableId('command:receipt-missing'), transactionId: asStableId('transaction:receipt-missing'), idempotencyKey: asStableId('idempotency:receipt-missing'), label: 'Missing receipt', baseRevision: 1, operations: [{ op: 'setting.set', key: 'fixture.missing', value: true }] };
  await value.operationLog.append({ kind: 'document/transaction-receipt-written', severity: 'warning', source: asStableId('studio.document'), correlation: { projectId: document.projectId, documentId: document.documentId, transactionId: missingInput.transactionId }, payload: { fixture: 'missing-artifact-reference' } });
  await assert.rejects(value.workspace.reconcileTransaction(missingInput), (error) => error.code === 'transaction-receipt-duplicate');
  const corruptInput = { ...missingInput, id: asStableId('command:receipt-corrupt'), transactionId: asStableId('transaction:receipt-corrupt'), idempotencyKey: asStableId('idempotency:receipt-corrupt') };
  const corrupt = await value.operationLog.putArtifact({ schemaVersion: 1, transactionId: corruptInput.transactionId, receiptDigest: `sha256:${'0'.repeat(64)}` });
  await value.operationLog.append({ kind: 'document/transaction-receipt-written', severity: 'warning', source: asStableId('studio.document'), correlation: { projectId: document.projectId, documentId: document.documentId, transactionId: corruptInput.transactionId }, artifactRefs: [corrupt.id], payload: { fixture: 'corrupt-receipt' } });
  await assert.rejects(value.workspace.reconcileTransaction(corruptInput), (error) => error.code === 'transaction-receipt-invalid');
  assert.equal(value.workspace.snapshot().document.revision, 1); assert.equal(value.workspace.snapshot().history.entries.length, 0);
  await disposeFixture(value);
});

test('scene transaction rolls back partial apply and classifies a crash after History write as ambiguous', async () => {
  let injected = false;
  const value = await fixture({ transactionFaultInjector: (point) => { if (!injected && point === 'after-history-write') { injected = true; throw new Error('injected crash after history write'); } } });
  await value.workspace.newProject(value.projectRoot, 'Transaction fault fixture');
  await assert.rejects(value.workspace.executeTransaction({
    id: asStableId('command:invalid-transaction'), transactionId: asStableId('transaction:invalid'), idempotencyKey: asStableId('idempotency:invalid'),
    label: 'Invalid atomic edit', baseRevision: 1,
    operations: [{ op: 'setting.set', key: 'fixture.valid', value: true }, { op: 'setting.set', key: '../invalid', value: true }],
  }), /Invalid project setting key/);
  assert.equal(value.workspace.snapshot().document.revision, 1);
  assert.equal(value.workspace.snapshot().history.entries.length, 0);
  const crashInput = {
    id: asStableId('command:crash-transaction'), transactionId: asStableId('transaction:crash'), idempotencyKey: asStableId('idempotency:crash'),
    label: 'Crash boundary edit', baseRevision: 1, operations: [{ op: 'setting.set', key: 'fixture.crash', value: true }],
  };
  await assert.rejects(value.workspace.executeTransaction(crashInput), /injected crash/);
  assert.equal(value.workspace.snapshot().document.revision, 2);
  assert.deepEqual(await value.workspace.reconcileTransaction(crashInput), { status: 'ambiguous', documentId: value.workspace.snapshot().document.documentId, revision: 2, reason: 'Document advanced from base revision 1 without a matching durable transaction receipt.' });
  await disposeFixture(value);
});

test('receipt written before acknowledgement proves committed state without a second History write', async () => {
  let injected = false;
  const value = await fixture({ transactionFaultInjector: (point) => { if (!injected && point === 'after-receipt-write') { injected = true; throw new Error('injected crash after receipt write'); } } });
  await value.workspace.newProject(value.projectRoot, 'Receipt recovery fixture');
  const input = { id: asStableId('command:receipt-crash'), transactionId: asStableId('transaction:receipt-crash'), idempotencyKey: asStableId('idempotency:receipt-crash'), label: 'Receipt crash edit', baseRevision: 1, memberNodeIds: [asStableId('node:receipt-crash')], operations: [{ op: 'setting.set', key: 'fixture.receipt-crash', value: true }] };
  await assert.rejects(value.workspace.executeTransaction(input), /injected crash/);
  const reconciled = await value.workspace.reconcileTransaction(input);
  assert.equal(reconciled.status, 'committed'); assert.equal(reconciled.receipt.afterRevision, 2);
  const replayed = await value.workspace.executeTransaction(input);
  assert.equal(replayed.replayed, true); assert.equal(replayed.snapshot.history.entries.length, 1); assert.equal(replayed.snapshot.document.revision, 2);
  await disposeFixture(value);
});

test('new, command, stale rejection, undo/redo, save and reopen share one revision/history path', async () => {
  const value = await fixture();
  let snapshot = await value.workspace.newProject(value.projectRoot, 'Fixture');
  assert.equal(snapshot.document.revision, 1);
  assert.equal(snapshot.document.dirty, true);
  const commandId = asStableId('command:set-grid');
  snapshot = await value.workspace.execute({ id: commandId, label: 'Set grid', baseRevision: 1, key: 'grid.size', value: 16 });
  assert.equal(snapshot.document.settings['grid.size'], 16);
  assert.equal(snapshot.document.revision, 2);
  assert.equal(snapshot.history.canUndo, true);
  await assert.rejects(
    value.workspace.execute({ id: asStableId('command:stale'), label: 'Stale', baseRevision: 1, key: 'grid.size', value: 32 }),
    (error) => error instanceof ProjectRevisionError && error.actualRevision === 2,
  );
  snapshot = await value.workspace.undo(2);
  assert.equal(snapshot.document.settings['grid.size'], undefined);
  assert.equal(snapshot.document.revision, 3);
  snapshot = await value.workspace.redo(3);
  assert.equal(snapshot.document.settings['grid.size'], 16);
  assert.equal(snapshot.document.revision, 4);
  snapshot = await value.workspace.save();
  assert.equal(snapshot.document.dirty, false);
  assert.equal(snapshot.document.savedRevision, 4);
  await value.workspace.closeProject();
  snapshot = await value.workspace.openProject(value.projectRoot);
  assert.equal(snapshot.document.revision, 4);
  assert.equal(snapshot.document.settings['grid.size'], 16);
  const commandFacts = await value.operationLog.query({ commandId, limit: 20, traverseCorrelation: false });
  assert.deepEqual(commandFacts.events.map((item) => item.kind), ['document/command-requested', 'document/command-committed']);
  const chain = await value.operationLog.query({ commandId, limit: 20, traverseCorrelation: true });
  assert.ok(chain.events.some((item) => item.kind === 'project/created'));
  assert.ok(chain.events.some((item) => item.kind === 'history/undo-committed'));
  assert.ok(chain.events.some((item) => item.kind === 'project/opened'));
  await disposeFixture(value);
});

test('untitled projects edit in memory and bind a directory on first save', async () => {
  const value = await fixture();
  let snapshot = await value.workspace.newProject(null, 'Untitled game');
  assert.equal(snapshot.projectRoot, null);
  assert.equal(snapshot.document.dirty, true);
  snapshot = await value.workspace.execute({
    id: asStableId('command:untitled-grid'), label: 'Set grid', baseRevision: 1, key: 'grid.size', value: 12,
  });
  assert.equal(snapshot.projectRoot, null);
  await assert.rejects(value.workspace.save(), /repository/i);
  snapshot = await value.workspace.saveAs(value.projectRoot);
  assert.equal(snapshot.projectRoot, await realpath(value.projectRoot));
  assert.equal(snapshot.document.dirty, false);
  const saved = JSON.parse(await readFile(path.join(value.projectRoot, '.haiyue-project.json'), 'utf8'));
  assert.equal(saved.document.settings['grid.size'], 12);
  await disposeFixture(value);
});

test('group cancel rolls document state back while appending a new revision fact', async () => {
  const value = await fixture();
  await value.workspace.newProject(value.projectRoot, 'Fixture');
  const transactionId = asStableId('transaction:cancel-fixture');
  await value.workspace.beginGroup('Cancelled edit', transactionId);
  await value.workspace.execute({
    id: asStableId('command:inside-group'), transactionId, label: 'Temporary setting', baseRevision: 1, key: 'temporary.value', value: true,
  });
  await value.workspace.cancelGroup(transactionId);
  const snapshot = value.workspace.snapshot();
  assert.equal(snapshot.document.settings['temporary.value'], undefined);
  assert.equal(snapshot.document.revision, 3);
  assert.equal(snapshot.history.canUndo, false);
  const facts = await value.operationLog.query({ transactionId, limit: 20, traverseCorrelation: false });
  assert.deepEqual(facts.events.map((item) => item.kind), [
    'history/group-started', 'document/command-requested', 'document/command-committed', 'history/group-cancelled',
  ]);
  await disposeFixture(value);
});

test('command failure does not enter History and save failure preserves the previous authoritative file', async () => {
  const value = await fixture();
  await value.workspace.newProject(value.projectRoot, 'Fixture');
  await assert.rejects(value.workspace.execute({
    id: asStableId('command:invalid'), label: 'Invalid', baseRevision: 1, key: '../escape', value: true,
  }), /Invalid project setting key/);
  assert.equal(value.workspace.snapshot().document.revision, 1);
  assert.equal(value.workspace.snapshot().history.canUndo, false);
  await value.workspace.save();
  const before = await readFile(path.join(value.projectRoot, '.haiyue-project.json'), 'utf8');
  const failing = await ProjectRepository.open(value.projectRoot, { beforeRename: () => { throw new Error('injected save failure'); } });
  const changed = new ProjectDocument(asStableId('project:failure'), 'Failure', asStableId('document:failure'), { value: 2 }, 2, 1);
  await assert.rejects(failing.save(changed.serializeForSave()), (error) => error instanceof ProjectPathError && error.code === 'project-save-failed');
  assert.equal(await readFile(path.join(value.projectRoot, '.haiyue-project.json'), 'utf8'), before);
  assert.equal((await readdir(value.projectRoot)).some((name) => name.startsWith('.haiyue-project.json.tmp-')), false);
  await disposeFixture(value);
});

test('project paths reject traversal and crash temp files are cleaned on reopen', async () => {
  const root = await temp('path-policy');
  await writeFile(path.join(root, '.haiyue-project.json.tmp-crash'), 'partial');
  const repository = await ProjectRepository.open(root);
  assert.equal((await readdir(root)).length, 0);
  assert.throws(() => repository.resolveProjectPath('../outside.json'), (error) => error instanceof ProjectPathError && error.code === 'project-path-escape');
  assert.throws(() => repository.resolveProjectPath('C:\\outside.json'), (error) => error instanceof ProjectPathError);
});

test('document replacement cancels active tasks and leaves no task or document owner behind', async () => {
  const value = await fixture();
  await value.workspace.newProject(value.projectRoot, 'First');
  await value.workspace.save();
  const secondRoot = await temp('project-second');
  const secondRepo = await ProjectRepository.open(secondRoot);
  await secondRepo.save(new ProjectDocument(asStableId('project:second'), 'Second', asStableId('document:second')).serializeForSave());
  const pending = value.resources.tasks.run('fixture', {
    async prepare(context) {
      await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
      context.assertCurrent();
    },
    commit() { throw new Error('late commit must not run'); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await value.workspace.openProject(secondRoot);
  assert.equal((await pending).status, 'cancelled');
  assert.equal(value.resources.tasks.activeCount, 0);
  assert.equal(value.resources.documents.snapshot().documents.length, 1);
  await disposeFixture(value);
  assert.equal(value.resources.documents.snapshot().documents.length, 0);
});

async function disposeFixture(value) {
  await value.workspace.dispose();
  value.resources.tasks.dispose();
  await value.resources.documents.dispose();
  value.resources.history.dispose();
  value.resources.projectSession.dispose();
  await value.operationLog.close();
}
