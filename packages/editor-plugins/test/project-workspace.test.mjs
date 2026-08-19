import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EditorDocumentHost,
  EditorHistoryService,
  EditorProjectSessionState,
  EditorTaskCoordinator,
} from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import {
  ProjectDocument,
  ProjectPathError,
  ProjectRepository,
  ProjectRevisionError,
  ProjectWorkspace,
  RecentProjectStore,
} from '../dist/index.js';

async function temp(name) { return mkdtemp(path.join(tmpdir(), `haiyue-${name}-`)); }

async function fixture() {
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
  };
  return { projectRoot, userDataRoot, operationLog, resources, workspace: new ProjectWorkspace(resources) };
}

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
