import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { EditorSelectionService } from '@haiyue/editor-platform';
import { UnifiedSceneSelectionService } from '@haiyue/ai-studio-editor-plugins';
import { ProjectEditorController } from '@haiyue/ai-studio-agent-orchestration';
import { resourceFixture, png, execute } from '../../../../packages/editor-plugins/test/resources/fixture.mjs';
import { seedResourceProject } from '../../../../packages/editor-plugins/test/resources/large-fixture.mjs';
import { createWorkspaceEditorPorts } from '../../dist/editor-adapters.js';
import { createWorkspaceBehaviorPorts } from '../../dist/behavior-adapters.js';
import { StudioIpcRouter } from '../../dist/ipc.js';

async function fixture(t) {
  const f = await resourceFixture(), selected = new EditorSelectionService();
  const selection = new UnifiedSceneSelectionService(selected, f.scene, f.operationLog);
  const behavior = createWorkspaceBehaviorPorts(f.workspace, f.operationLog);
  const approvals = []; let decision = 'allow-once', target = path.join(f.directory, 'project'), sequence = 0;
  const editor = new ProjectEditorController(createWorkspaceEditorPorts({ workspace: f.workspace, selection, behavior, tools: f.runtime, playId: () => null,
    approve: async (preparation, approval, signal) => { signal.throwIfAborted(); approvals.push({ preparation, approval, decision }); return decision; },
  }));
  const changes = f.workspace.subscribe(() => editor.syncProject());
  const router = new StudioIpcRouter({ workspace: f.workspace, scene: f.scene, selection, scripts: f.scripts, operationLog: f.operationLog, editor,
    conversation: { cancelPending() {}, async prepareProjectChange() {}, async syncProject() {} }, agentPreview: { cancelPending() {} },
    selectProjectRoot: async () => target, bugBundleRoot: path.join(f.directory, 'bundles'), versions: { app: 'test', schema: '1', upstream: {} },
  });
  const request = (channel, payload = {}) => router.handle({ schemaVersion: 1, id: `request:g09-${++sequence}`, correlationId: 'correlation:g09', channel, payload });
  const invoke = async (channel, payload) => { const result = await request(channel, payload); assert.equal(result.ok, true, JSON.stringify(result)); return result.payload; };
  t.after(async () => { changes.dispose(); router.dispose(); editor.dispose(); await behavior.reader.dispose(); await selection.whenIdle(); selected.dispose(); await f.close(); });
  const stamp = source => ({ epoch: source.epoch, documentId: source.document.id, baseRevision: source.document.revision, selectionRevision: source.selection.revision });
  return { ...f, invoke, request, editor, selection, approvals, stamp, setDecision: value => { decision = value; }, setTarget: value => { target = value; } };
}
test('production IPC / project owner / resource adapter use exact tool approval and shared History', async t => {
  const f = await fixture(t), page = await f.invoke('editor/resources', { category: 'Geometry', limit: 100 });
  assert.equal(page.total, 0, 'empty project contains no geometry templates');
  assert.equal((await f.invoke('editor/resources', { kind: 'template' })).total, 0);
  const before = f.workspace.snapshot(), initial = await f.invoke('editor/advanced');
  const created = await execute(f, 'entity.create', { baseRevision: initial.document.revision, kind: 'point-light' });
  assert.equal(created.status, 'completed');
  assert.equal(f.approvals.length, 0, 'low-risk create retains the existing policy');
  assert.equal(f.workspace.snapshot().history.entries.length, before.history.entries.length + 1);
  const entityId = f.workspace.gameSnapshot().entities.find(entity => entity.componentIds.some(id => f.workspace.gameSnapshot().components.some(c => c.id === id && c.type === 'haiyue.light.point'))).id;
  await f.selection.select(entityId, 'inspector');
  let source = await f.invoke('editor/advanced');
  assert.equal(source.selection.active.id, entityId); assert.ok(source.document.components.some(c => c.type === 'haiyue.light.point'));
  const rename = { type: 'author', stamp: f.stamp(source), toolId: 'entity.rename', arguments: { entityId, baseRevision: source.document.revision, name: 'G09 light' } };
  await f.invoke('editor/advanced-intent', { intent: rename }); assert.equal(f.workspace.gameSnapshot().entities.find(e => e.id === entityId).name, 'G09 light');
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].preparation.baseRevision, source.document.revision);
  assert.equal((await f.request('editor/advanced-intent', { intent: rename })).ok, false, 'old revision rejected');
  source = await f.invoke('editor/advanced'); await f.invoke('editor/advanced-intent', { intent: { type: 'undo', stamp: f.stamp(source) } });
  assert.notEqual(f.workspace.gameSnapshot().entities.find(e => e.id === entityId).name, 'G09 light');
  source = await f.invoke('editor/advanced'); await f.invoke('editor/advanced-intent', { intent: { type: 'redo', stamp: f.stamp(source) } });
  assert.equal(f.workspace.gameSnapshot().entities.find(e => e.id === entityId).name, 'G09 light');
  const after = JSON.stringify(f.workspace.gameSnapshot()); f.setDecision('reject'); source = await f.invoke('editor/advanced');
  const rejected = await f.request('editor/advanced-intent', { intent: { ...rename, stamp: f.stamp(source), arguments: { ...rename.arguments, baseRevision: source.document.revision, name: 'Rejected' } } });
  assert.equal(rejected.ok, false); assert.equal(JSON.stringify(f.workspace.gameSnapshot()), after);
  const lighting = await f.invoke('editor/resources', { category: 'Lighting', limit: 100 });
  assert.ok(lighting.items.every(i => i.entry.kind === 'instance'), 'inventory excludes unavailable preset notices');
  assert.ok(lighting.items.some(i => i.entry.kind === 'instance' && !i.entry.intents.includes('asset.assign')));
});
test('actual resource import retains asset identity after reopen and copy; old view cannot import into the copied project', async t => {
  const f = await fixture(t), bytes = png(2, 1), original = path.join(f.directory, 'project');
  await mkdir(path.join(original, 'assets')); await writeFile(path.join(original, 'assets/sky.png'), bytes);
  let page = await f.invoke('editor/resources');
  const imported = await f.invoke('editor/resource-import', { viewToken: page.viewToken, details: { projectPath: 'assets/sky.png', kind: 'texture', mimeType: 'image/png', license: 'internal-test', provenance: 'g09-local-generated-fixture', decodedBytes: bytes.length, width: 2, height: 1 } });
  const assetId = imported.result.asset.id; await f.invoke('project/save'); page = await f.invoke('editor/resources', { kind: 'asset' });
  const source = await f.invoke('editor/advanced'); await f.invoke('project/reopen');
  assert.equal((await f.invoke('editor/resources', { kind: 'asset' })).items[0].entry.ref.assetId, assetId);
  assert.notEqual((await f.invoke('editor/advanced')).epoch, source.epoch);
  const copy = path.join(f.directory, 'copy'); await mkdir(path.join(copy, 'assets'), { recursive: true });
  await copyFile(path.join(original, '.haiyue-project.json'), path.join(copy, '.haiyue-project.json')); await copyFile(path.join(original, 'assets/sky.png'), path.join(copy, 'assets/sky.png'));
  f.setTarget(copy); await f.invoke('project/open');
  const copied = await f.invoke('editor/resources', { kind: 'asset' }); assert.equal(copied.items[0].entry.ref.assetId, assetId);
  assert.equal((await f.request('editor/resource-intent', { intent: { type: 'action', viewToken: page.viewToken, entry: page.items[0].entry, action: 'asset.inspect' } })).ok, false);
  const inspected = await f.invoke('editor/resource-intent', { intent: { type: 'action', viewToken: copied.viewToken, entry: copied.items[0].entry, action: 'asset.inspect' } }); assert.equal(inspected.kind, 'inspection');
  assert.equal(JSON.stringify(copied).includes(f.directory), false, 'no filesystem roots in renderer resource projection');
});
test('production projections keep 1000 entities and 200 scripts bounded and reject extra IPC authority', async t => {
  const f = await fixture(t); await seedResourceProject(f, 1000, 200);
  const page = await f.invoke('editor/resources', { limit: 25 }), advanced = await f.invoke('editor/advanced');
  assert.equal(advanced.document.entities.length, 1000); assert.equal(Object.hasOwn(advanced.document, 'scripts'), false);
  assert.equal(page.total, 200, 'only actual script resources, not empty entities or transform components'); assert.ok(page.items.length <= 25); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 512 * 1024);
  assert.equal(JSON.stringify(page).includes('Math.sin(time'), false);
  assert.equal((await f.request('editor/advanced', { schemaVersion: 2 })).ok, false);
  assert.equal((await f.request('editor/resource-import', { viewToken: page.viewToken, details: {}, binding: {} })).ok, false);
});
