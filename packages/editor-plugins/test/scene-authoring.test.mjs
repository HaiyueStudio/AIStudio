import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EditorDocumentHost,
  EditorHistoryService,
  EditorProjectSessionState,
  EditorSelectionService,
  EditorTaskCoordinator,
} from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import {
  OwnedViewportService,
  ProjectSceneAuthoringService,
  ProjectWorkspace,
  RecentProjectStore,
  UnifiedSceneSelectionService,
  normalizePickPoint,
  parseSceneSnapshot,
} from '../dist/index.js';

async function temp(name) { return mkdtemp(path.join(tmpdir(), `haiyue-scene-${name}-`)); }

async function fixture() {
  const projectRoot = await temp('project');
  const userDataRoot = await temp('userdata');
  const operationLog = await OperationLog.open({
    rootDirectory: path.join(userDataRoot, 'operation-log'), appVersion: '0.0.0-test',
    clock: () => new Date('2026-08-19T02:00:00.000Z'), eventId: (sequence) => asStableId(`event:scene:${sequence}`),
  });
  const resources = {
    documents: new EditorDocumentHost(),
    history: new EditorHistoryService(),
    tasks: new EditorTaskCoordinator(),
    projectSession: new EditorProjectSessionState(),
    operationLog,
    recentProjects: new RecentProjectStore(userDataRoot),
  };
  const workspace = new ProjectWorkspace(resources);
  const scene = new ProjectSceneAuthoringService(workspace, operationLog);
  return { projectRoot, userDataRoot, operationLog, resources, workspace, scene };
}

function transform(position = { x: 0, y: 0, z: 0 }) {
  return { position, rotationDegrees: { x: 0, y: 45, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
}

test('create/transform use the document command path and survive undo, redo, save and reopen', async () => {
  const value = await fixture();
  await value.workspace.newProject(value.projectRoot, 'Scene fixture');

  let scene = await value.scene.createEntity({
    commandId: asStableId('command:create-root'), baseRevision: 1, kind: 'empty', name: 'Root',
  });
  const root = scene.entities[0];
  scene = await value.scene.createEntity({
    commandId: asStableId('command:create-cube'), baseRevision: 2, kind: 'cube', name: 'Player', parentId: root.id,
  });
  const cube = scene.entities[1];
  assert.deepEqual(scene.entities.map(({ name, parentId, order }) => ({ name, parentId, order })), [
    { name: 'Root', parentId: null, order: 0 },
    { name: 'Player', parentId: root.id, order: 0 },
  ]);
  assert.equal(value.scene.resources().engineEntityCount, 2);
  assert.equal(Object.isFrozen(scene), true);
  assert.equal(Object.isFrozen(scene.entities), true);

  scene = await value.scene.setTransform({
    commandId: asStableId('command:move-cube'), baseRevision: 3, entityId: cube.id, transform: transform({ x: 2, y: 3, z: 4 }),
  });
  assert.deepEqual(scene.entities[1].transform.position, { x: 2, y: 3, z: 4 });
  const beforeFailure = value.workspace.snapshot();
  await assert.rejects(value.scene.setTransform({
    commandId: asStableId('command:invalid-transform'), baseRevision: 4, entityId: cube.id,
    transform: transform({ x: Number.NaN, y: 0, z: 0 }),
  }), /finite values/);
  await assert.rejects(value.scene.setTransform({
    commandId: asStableId('command:stale-transform'), baseRevision: 3, entityId: cube.id, transform: transform({ x: 9, y: 9, z: 9 }),
  }), /revision/i);
  assert.equal(value.workspace.snapshot().document.revision, beforeFailure.document.revision);
  assert.deepEqual(value.scene.snapshot(), scene);

  await value.workspace.undo(4);
  assert.deepEqual(value.scene.snapshot().entities[1].transform.position, { x: 0, y: 0, z: 0 });
  await value.workspace.redo(5);
  assert.deepEqual(value.scene.snapshot().entities[1].transform.position, { x: 2, y: 3, z: 4 });
  await value.workspace.save();
  await value.workspace.closeProject();
  assert.equal(value.scene.snapshot().entities.length, 0);
  assert.equal(value.scene.resources().engineEntityCount, 0);
  await value.workspace.openProject(value.projectRoot);
  assert.equal(value.scene.snapshot().entities[1].id, cube.id);
  assert.deepEqual(value.scene.snapshot().entities[1].transform.position, { x: 2, y: 3, z: 4 });

  const commandFacts = await value.operationLog.query({ commandId: asStableId('command:move-cube'), limit: 20, traverseCorrelation: false });
  assert.deepEqual(commandFacts.events.map((event) => event.kind), [
    'document/command-requested', 'document/command-committed', 'scene/transform-edited',
  ]);
  const rejected = await value.operationLog.query({ limit: 100 });
  assert.equal(rejected.events.filter((event) => event.kind === 'scene/command-rejected').length, 2);
  await disposeFixture(value);
});

test('selection sources converge and stale viewport readback cannot replace newer intent', async () => {
  const value = await fixture();
  await value.workspace.newProject(value.projectRoot, 'Selection fixture');
  const created = await value.scene.createEntity({
    commandId: asStableId('command:create-selectable'), baseRevision: 1, kind: 'cube',
  });
  const cubeId = created.entities[0].id;
  const foundationSelection = new EditorSelectionService();
  const selection = new UnifiedSceneSelectionService(foundationSelection, value.scene, value.operationLog);

  assert.equal((await selection.select(cubeId, 'hierarchy')).source, 'hierarchy');
  let resolveReadback;
  const pending = selection.pick(new Promise((resolve) => { resolveReadback = resolve; }), 'viewport');
  await selection.select(null, 'inspector');
  resolveReadback(cubeId);
  assert.equal((await pending).activeEntityId, null);
  assert.equal(selection.snapshot().source, 'inspector');
  assert.equal((await selection.pick(Promise.resolve(cubeId))).source, 'viewport');
  assert.equal(selection.snapshot().entityIds.length, 1);
  assert.equal((await selection.pick(Promise.resolve(null))).activeEntityId, null);

  const facts = await value.operationLog.query({ limit: 20 });
  assert.ok(facts.events.some((event) => event.kind === 'selection/entity-selected' && event.payload.source === 'hierarchy'));
  assert.ok(facts.events.some((event) => event.kind === 'selection/cleared' && event.payload.source === 'viewport'));
  foundationSelection.dispose();
  await disposeFixture(value);
});

test('viewport normalizes DPR coordinates, reports failures and releases 100 replacement backends', async () => {
  const value = await fixture();
  await value.workspace.newProject(value.projectRoot, 'Viewport fixture');
  const created = await value.scene.createEntity({
    commandId: asStableId('command:create-viewport-cube'), baseRevision: 1, kind: 'cube',
  });
  const cubeId = created.entities[0].id;
  const foundationSelection = new EditorSelectionService();
  const selection = new UnifiedSceneSelectionService(foundationSelection, value.scene, value.operationLog);
  const viewport = new OwnedViewportService(value.scene, selection, value.operationLog);
  const disposed = [];
  const points = [];

  const backend = (result = cubeId) => ({
    async initialize() {},
    render(scene, selectedEntityId) { assert.equal(scene.entities.length, 1); assert.equal(selectedEntityId, selection.snapshot().activeEntityId); },
    async pick(point) { points.push(point); if (result instanceof Error) throw result; return result; },
    resize(width, height, dpr) { assert.ok(width > 0 && height > 0 && dpr > 0); },
    dispose() { disposed.push(true); },
  });

  await viewport.attach(backend());
  assert.equal(viewport.state, 'ready');
  await viewport.pick({ clientX: 60, clientY: 45, rect: { left: 10, top: 20, width: 100, height: 50 }, devicePixelRatio: 2 });
  assert.deepEqual(points[0], { pixelX: 100, pixelY: 50, normalizedX: 0.5, normalizedY: 0.5 });
  viewport.resize(640, 360, 2);
  await viewport.attach(backend(new Error('readback failed')));
  await assert.rejects(viewport.pick({ clientX: 10, clientY: 10, rect: { left: 0, top: 0, width: 100, height: 100 }, devicePixelRatio: 1 }), /readback failed/);
  await viewport.deviceLost('injected device loss');
  assert.equal(viewport.state, 'device-lost');

  for (let index = 0; index < 100; index += 1) await viewport.attach(backend(null));
  await viewport.dispose();
  assert.equal(viewport.state, 'disposed');
  assert.equal(disposed.length, 102);
  const facts = await value.operationLog.query({ limit: 200 });
  assert.equal(facts.events.filter((event) => event.kind === 'viewport/picking-failed').length, 1);
  assert.equal(facts.events.filter((event) => event.kind === 'viewport/device-lost').length, 1);
  assert.ok(facts.events.some((event) => event.kind === 'viewport/rendered-state'));
  foundationSelection.dispose();
  await disposeFixture(value);
});

test('scene parser rejects missing parents and transform scale that cannot be rendered', () => {
  const entity = {
    id: asStableId('entity:orphan'), name: 'Orphan', kind: 'empty', parentId: asStableId('entity:missing'), order: 0,
    transform: transform(),
  };
  assert.throws(() => parseSceneSnapshot({ schemaVersion: 1, revision: 1, entities: [entity] }, asStableId('document:test')), /Missing scene parent/);
  assert.throws(() => parseSceneSnapshot({
    schemaVersion: 1, revision: 1, entities: [{ ...entity, parentId: null, transform: { ...transform(), scale: { x: 0, y: 1, z: 1 } } }],
  }, asStableId('document:test')), /greater than zero/);
  assert.deepEqual(normalizePickPoint({ clientX: -10, clientY: 120, rect: { left: 0, top: 0, width: 100, height: 100 }, devicePixelRatio: 2 }), {
    pixelX: 0, pixelY: 199, normalizedX: 0, normalizedY: 1,
  });
});

async function disposeFixture(value) {
  value.scene.dispose();
  assert.equal(value.scene.resources().disposed, true);
  assert.equal(value.scene.resources().engineEntityCount, 0);
  await value.workspace.dispose();
  value.resources.tasks.dispose();
  await value.resources.documents.dispose();
  value.resources.history.dispose();
  value.resources.projectSession.dispose();
  await value.operationLog.close();
}
