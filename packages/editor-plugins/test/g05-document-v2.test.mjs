import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import {
  BUILTIN_COMPONENT_DEFINITIONS, ComponentRegistry, ComponentRegistryError, GameDocumentError, GameDocumentStore,
  parseGameDocumentV2, ProjectRepository, ProjectWorkspace, RecentProjectStore,
} from '../dist/index.js';

const FIXED_TIME = new Date('2026-08-25T08:00:00.000Z');
async function temp(name) { return mkdtemp(path.join(tmpdir(), `haiyue-g05-${name}-`)); }

test('component registry validates definitions/instances, rejects unknown component versions and derives one stable capability manifest', () => {
  const registry = new ComponentRegistry().freeze(); const first = registry.snapshot(); const second = registry.snapshot(); const manifest = registry.capabilityManifest();
  assert.deepEqual(first, second); assert.equal(manifest.registryDigest, first.digest); assert.deepEqual(manifest.components.map(({ type, version }) => `${type}@${version}`), first.definitions.map(({ type, version }) => `${type}@${version}`));
  const transform = registry.create({ id: asStableId('component:test-transform'), type: asStableId('haiyue.transform.3d'), version: '1.0.0', value: { position: { x: 1 } } });
  assert.deepEqual(transform.value.position, { x: 1, y: 0, z: 0 }); assert.deepEqual(transform.value.scale, { x: 1, y: 1, z: 1 }); assert.equal(Object.isFrozen(transform.value), true);
  assert.throws(() => registry.validate({ ...transform, version: '9.0.0' }), (error) => error instanceof ComponentRegistryError && error.code === 'component.definition-unknown');
  assert.throws(() => registry.validate({ ...transform, value: { ...transform.value, password: 'SECRET_CANARY' } }), (error) => error instanceof ComponentRegistryError && error.code === 'component.value-invalid');
  const mutable = new ComponentRegistry([]); const candidate = structuredClone(BUILTIN_COMPONENT_DEFINITIONS[0]); candidate.type = 'haiyue.test.unsupported-schema'; candidate.valueSchema = { ...candidate.valueSchema, oneOf: [] };
  assert.throws(() => mutable.register(candidate), (error) => error instanceof ComponentRegistryError && error.code === 'component.schema-unsupported');
});

test('workspace registry accepts plugin descriptors before first project snapshot and then freezes', async () => {
  const value = await workspaceFixture(); const descriptor = structuredClone(BUILTIN_COMPONENT_DEFINITIONS[0]); descriptor.type = 'haiyue.camera.fixture'; descriptor.owner = 'plugin.camera.fixture'; descriptor.testOwner = 'test.camera.fixture';
  value.workspace.componentRegistry.register(descriptor); assert.equal(value.workspace.componentRegistry.get(descriptor.type, descriptor.version).owner, descriptor.owner);
  await value.workspace.newProject(value.projectRoot, 'Registry extension fixture');
  assert.throws(() => value.workspace.componentRegistry.register({ ...descriptor, type: 'haiyue.camera.late' }), (error) => error instanceof ComponentRegistryError && error.code === 'component.registry-frozen');
  await disposeWorkspace(value);
});

test('external v2 parsing fails closed on unknown fields, duplicate ids, missing roots, unknown components and stale script digests', () => {
  const registry = new ComponentRegistry().freeze(); const source = largeDocument(1);
  assert.throws(() => parseGameDocumentV2({ ...source, futureField: true }, registry), (error) => error instanceof GameDocumentError && error.code === 'document.unknown-field');
  assert.throws(() => parseGameDocumentV2({ ...source, scenes: [...source.scenes, source.scenes[0]] }, registry), (error) => error instanceof GameDocumentError && error.code === 'document.scene-duplicate');
  assert.throws(() => parseGameDocumentV2({ ...source, scenes: [{ ...source.scenes[0], rootEntityIds: [] }] }, registry), (error) => error instanceof GameDocumentError && error.code === 'document.scene-root-missing');
  assert.throws(() => parseGameDocumentV2({ ...source, components: [{ ...source.components[0], version: '9.0.0' }] }, registry), (error) => error instanceof ComponentRegistryError && error.code === 'component.definition-unknown');
  const script = { id: 'script:g05-stale', entityId: source.entities[0].id, name: 'Stale', sourcePath: 'scripts/stale.ts', source: 'changed', textRevision: 1, enabled: true, order: 0, capabilities: [], digest: `sha256:${'a'.repeat(64)}` };
  assert.throws(() => parseGameDocumentV2({ ...source, scripts: [script] }, registry), (error) => error instanceof GameDocumentError && error.code === 'document.script-invalid');
});

test('component CRUD, parent integrity, dependency rejection and batch rollback are atomic', () => {
  const registry = new ComponentRegistry().freeze(); const document = baseDocument(registry);
  const entityA = entity('entity:a', null, 0); const entityB = entity('entity:b', null, 1); const transform = registry.create({ id: asStableId('component:a-transform'), type: asStableId('haiyue.transform.3d'), version: '1.0.0' });
  let delta = document.apply(asStableId('transaction:add-two'), [{ op: 'entity.add', entity: entityA }, { op: 'component.add', entityId: entityA.id, component: transform }, { op: 'entity.add', entity: entityB }]);
  assert.equal(delta.afterRevision, 2); assert.equal(delta.operations.length, 3); assert.equal(document.query({ limit: 10 }).entities.length, 2);
  assert.throws(() => document.apply(asStableId('transaction:cycle'), [{ op: 'entity.update', entityId: entityA.id, patch: { parentId: entityB.id } }, { op: 'entity.update', entityId: entityB.id, patch: { parentId: entityA.id } }]), (error) => error instanceof GameDocumentError && error.code === 'document.parent-cycle');
  assert.equal(document.entity(asStableId(entityA.id)).parentId, null); assert.equal(document.revision, 2);
  assert.throws(() => document.apply(asStableId('transaction:delete-dependent'), [{ op: 'entity.remove', entityId: entityA.id }]), /component.*no entity owner/i); assert.ok(document.entity(asStableId(entityA.id)));
  assert.throws(() => document.apply(asStableId('transaction:rollback-invalid'), [{ op: 'component.patch', componentId: transform.id, path: ['position', 'x'], value: 9 }, { op: 'component.patch', componentId: transform.id, path: ['scale', 'x'], value: 0 }]), /must be >=/);
  assert.equal(document.component(transform.id).value.position.x, 0); assert.equal(document.revision, 2);
  delta = document.apply(asStableId('transaction:patch'), [{ op: 'component.patch', componentId: transform.id, path: ['position', 'x'], value: 4 }]);
  assert.equal(delta.metrics.projectionWork, 1); assert.equal(document.component(transform.id).value.position.x, 4);
  document.apply(asStableId('transaction:inverse'), delta.inverse); assert.equal(document.component(transform.id).value.position.x, 0);
});

test('workspace batch shares one History transaction and Undo/Redo apply generated inverse deltas', async () => {
  const value = await workspaceFixture(); await value.workspace.newProject(value.projectRoot, 'Batch fixture'); const sceneId = value.workspace.gameSnapshot().scenes[0].id;
  const entityValue = entity('entity:history', null, 0, sceneId); const transform = value.workspace.componentRegistry.create({ id: asStableId('component:history-transform'), type: asStableId('haiyue.transform.3d'), version: '1.0.0' });
  let snapshot = await value.workspace.executeBatch({ id: asStableId('command:history-add'), label: 'Create entity with components', baseRevision: 1, operations: [{ op: 'entity.add', entity: entityValue }, { op: 'component.add', entityId: entityValue.id, component: transform }] });
  assert.equal(snapshot.document.revision, 2); assert.equal(snapshot.history.canUndo, true); assert.equal(snapshot.history.canRedo, false); assert.equal(value.workspace.queryGameDocument({ entityId: entityValue.id, limit: 1 }).components.length, 1);
  snapshot = await value.workspace.undo(2); assert.equal(snapshot.document.revision, 3); assert.equal(value.workspace.queryGameDocument({ entityId: entityValue.id, limit: 1 }).entities.length, 0);
  snapshot = await value.workspace.redo(3); assert.equal(snapshot.document.revision, 4); assert.equal(value.workspace.queryGameDocument({ entityId: entityValue.id, limit: 1 }).entities.length, 1);
  await assert.rejects(value.workspace.executeBatch({ id: asStableId('command:bad-batch'), label: 'Invalid batch', baseRevision: 4, operations: [{ op: 'component.patch', componentId: transform.id, path: ['position', 'x'], value: 8 }, { op: 'component.patch', componentId: transform.id, path: ['scale', 'x'], value: 0 }] }), /must be >=/);
  assert.equal(value.workspace.snapshot().document.revision, 4); assert.equal(value.workspace.snapshot().history.canUndo, true); assert.equal(value.workspace.snapshot().history.canRedo, false); assert.equal(value.workspace.queryGameDocument({ entityId: entityValue.id, limit: 1 }).components[0].value.position.x, 0);
  await disposeWorkspace(value);
});

test('v1 migration is lossless, backed up, byte-stable on reopen and rollback-restorable', async () => {
  const root = await temp('migration'); const legacy = legacyFixture(); const body = `${JSON.stringify(legacy, null, 2)}\n`; await writeFile(path.join(root, '.haiyue-project.json'), body, 'utf8');
  const repository = await ProjectRepository.open(root, { clock: () => FIXED_TIME }); const first = await repository.readWithMigration();
  assert.equal(first.migration.fromVersion, 1); assert.equal(first.file.document.entities[0].name, 'Player'); assert.equal(first.file.document.scripts[0].source, 'entity.position.x += delta;'); assert.equal(first.file.document.settings['grid.size'], 16); assert.equal(first.file.document.settings['scene.snapshot'], undefined);
  assert.equal(await readFile(path.join(root, '.haiyue-project.v1.backup.json'), 'utf8'), body); assert.equal(JSON.parse(await readFile(path.join(root, '.haiyue-migration-v1-to-v2.json'), 'utf8')).sourceDigest, first.migration.sourceDigest);
  const migratedBody = await readFile(path.join(root, '.haiyue-project.json'), 'utf8'); const reopened = await repository.readWithMigration(); assert.equal(reopened.migration, null); await repository.save(reopened.file); assert.equal(await readFile(path.join(root, '.haiyue-project.json'), 'utf8'), migratedBody);
  await repository.rollbackMigration(); assert.equal(await readFile(path.join(root, '.haiyue-project.json'), 'utf8'), body);
  const remigrated = await repository.readWithMigration(); assert.equal(remigrated.migration.resultDigest, first.migration.resultDigest); assert.equal(await readFile(path.join(root, '.haiyue-project.json'), 'utf8'), migratedBody);

  const failingRoot = await temp('migration-failure'); await writeFile(path.join(failingRoot, '.haiyue-project.json'), body, 'utf8'); const failing = await ProjectRepository.open(failingRoot, { clock: () => FIXED_TIME, beforeRename: () => { throw new Error('injected migration failure'); } });
  await assert.rejects(failing.readWithMigration(), /save failed/i); assert.equal(await readFile(path.join(failingRoot, '.haiyue-project.json'), 'utf8'), body); assert.equal(await readFile(path.join(failingRoot, '.haiyue-project.v1.backup.json'), 'utf8'), body);
});

test('1k and 10k entity single-property edits stay delta-sized and queries remain bounded', { timeout: 30_000 }, () => {
  const registry = new ComponentRegistry().freeze();
  for (const count of [1_000, 10_000]) {
    const store = new GameDocumentStore(asStableId(`document:perf-${count}`), largeDocument(count), registry); const target = asStableId(`component:perf-${String(count - 1).padStart(5, '0')}`); const started = performance.now();
    const delta = store.apply(asStableId(`transaction:perf-${count}`), [{ op: 'component.patch', componentId: target, path: ['position', 'x'], value: 42 }]); const elapsedMs = performance.now() - started;
    assert.equal(delta.metrics.projectionWork, 1); assert.ok(delta.metrics.copiedBytes < 512, `${count} copied ${delta.metrics.copiedBytes} bytes`); assert.ok(delta.metrics.historyBytes < 1_024, `${count} history ${delta.metrics.historyBytes} bytes`); assert.ok(elapsedMs < 50, `${count} edit took ${elapsedMs.toFixed(2)}ms`);
    const page = store.query({ componentType: asStableId('haiyue.transform.3d'), limit: 25 }); assert.equal(page.entities.length, 25); assert.ok(page.nextCursor); assert.ok(page.scanned <= count);
    const sparse = store.query({ componentType: asStableId('haiyue.component.absent'), limit: 25 }); assert.equal(sparse.entities.length, 0); assert.ok(sparse.scanned <= 1_000); if (count > 1_000) assert.ok(sparse.nextCursor);
  }
});

function baseDocument(registry) { return GameDocumentStore.empty(asStableId('document:g05-core'), registry, 1, 0); }
function entity(id, parentId, order, sceneId = 'scene:g05-core') { return Object.freeze({ id: asStableId(id), sceneId: asStableId(sceneId), name: id, parentId: parentId ? asStableId(parentId) : null, order, componentIds: Object.freeze([]) }); }
function largeDocument(count) { const id = `document:perf-${count}`; const sceneId = `scene:perf-${count}`; const entities = []; const components = []; const roots = []; for (let index = 0; index < count; index += 1) { const suffix = String(index).padStart(5, '0'); const entityId = `entity:perf-${suffix}`; const componentId = `component:perf-${suffix}`; roots.push(entityId); entities.push({ id: entityId, sceneId, name: `Entity ${index}`, parentId: null, order: index, componentIds: [componentId] }); components.push({ id: componentId, type: 'haiyue.transform.3d', version: '1.0.0', enabled: true, value: { position: { x: index, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }); } return { schemaVersion: 2, id, revision: 1, savedRevision: 0, scenes: [{ id: sceneId, name: 'Main', rootEntityIds: roots }], entities, components, scripts: [], assets: [], settings: {}, migration: { fromVersion: null, migratedAt: null, sourceDigest: null } }; }
function legacyFixture() { return { schemaVersion: 1, projectId: 'project:m06-fixture', name: 'M06 Fixture', document: { id: 'document:m06-fixture', revision: 4, savedRevision: 4, settings: { 'grid.size': 16, 'scene.snapshot': { schemaVersion: 1, revision: 2, documentId: 'document:m06-fixture', entities: [{ id: 'entity:player', name: 'Player', kind: 'cube', parentId: null, order: 0, transform: { position: { x: 1, y: 2, z: 3 }, rotationDegrees: { x: 0, y: 45, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, appearance: { material: 'pbr', color: [0.2, 0.8, 0.3, 1] } }] }, 'script.resources': [{ id: 'script:player', entityId: 'entity:player', name: 'Player Script', sourcePath: 'scripts/player.ts', text: 'entity.position.x += delta;', textRevision: 3, capabilities: ['read', 'input'] }] } } }; }
async function workspaceFixture() { const projectRoot = await temp('workspace-project'); const userDataRoot = await temp('workspace-userdata'); const operationLog = await OperationLog.open({ rootDirectory: path.join(userDataRoot, 'operation-log'), appVersion: 'g05-test' }); const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(userDataRoot) }; return { projectRoot, userDataRoot, operationLog, resources, workspace: new ProjectWorkspace(resources) }; }
async function disposeWorkspace(value) { await value.workspace.dispose(); value.resources.tasks.dispose(); await value.resources.documents.dispose(); value.resources.history.dispose(); value.resources.projectSession.dispose(); await value.operationLog.close(); }
