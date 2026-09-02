import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { ProjectSceneAuthoringService, ProjectWorkspace, RecentProjectStore } from '@haiyue/ai-studio-editor-plugins';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { PreviewAuthorizationService, ProjectScriptService, ScriptValidationWorker } from '@haiyue/ai-studio-script-preview';
import { AgentGameAuthoringCoordinator, GAME_AUTHORING_TOOL_DEFINITIONS, GameAuthoringToolRuntime } from '../dist/index.js';

const movementScript = `
const transform = entity.getComponent('CartesianTransform3D') as unknown as { setPosition(x: number, y: number, z: number): unknown } | null;
transform?.setPosition(time / 1000, 0, 0);
`;

const runtimeFailureScript = `throw new Error('fixture runtime failure');`;
const repairedRuntimeScript = `
const transform = entity.getComponent('CartesianTransform3D') as unknown as { setPosition(x: number, y: number, z: number): unknown } | null;
transform?.setPosition(0, 1, 0);
`;

test('bounded tool catalog exposes registry-driven component authoring', () => {
  assert.deepEqual(GAME_AUTHORING_TOOL_DEFINITIONS.map((item) => item.id), [
    'project.snapshot', 'scene.query', 'scene.diff', 'scene.get-many', 'tool.search', 'engine.capabilities.describe', 'component.describe', 'component.get',
    'camera.get', 'scene.list-entities', 'entity.get', 'script.get', 'script.symbols', 'diagnostics.query', 'history.query', 'asset.search', 'asset.dependencies',
    'camera.set', 'camera.author', 'entity.create', 'entity.create-many', 'entity.rename', 'entity.hierarchy', 'prefab.manage', 'transform.set', 'transform.batch', 'material.set',
    'component.add', 'component.set', 'component.remove', 'component.configure', 'asset.import', 'asset.assign', 'script.propose', 'script.patch', 'script.apply',
    'preview.validate', 'preview.start', 'preview.stop', 'play.start', 'play.stop', 'play.step', 'play.input', 'play.physics-query', 'play.inspect', 'play.capture', 'task.evaluate',
  ]);
  assert.ok(GAME_AUTHORING_TOOL_DEFINITIONS.every((item) => item.version === '1.0.0' && item.timeoutMs <= 20_000 && item.maxResultBytes <= 65_536));
  assert.match(GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'script.propose').description, /time and delta are milliseconds/);
  assert.match(GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'script.propose').description, /strict-TypeScript/);
  assert.match(GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'script.propose').description, /component\.data is the only persistent/);
  assert.match(GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'script.propose').description, /viewport-normalized 0\.\.1/);
  assert.match(GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'script.propose').description, /hudText/);
  assert.deepEqual(
    GAME_AUTHORING_TOOL_DEFINITIONS.filter((item) => item.id === 'entity.create').map((item) => ({ risk: item.risk, requiresApproval: item.requiresApproval })),
    [{ risk: 'low', requiresApproval: false }],
  );
  assert.doesNotMatch(JSON.stringify(GAME_AUTHORING_TOOL_DEFINITIONS), /shell|network|filesystem|package|git/i);
  assert.equal(GAME_AUTHORING_TOOL_DEFINITIONS.some((item) => item.id === 'project.delete'), false);
});

test('entity.create-many creates mixed scene roles in one revision and rejects material on non-geometry', async () => {
  const value = await fixture();
  try {
    const created = await approveAndExecute(value.runtime, call('call:create-many', 'entity.create-many', {
      baseRevision: 1,
      entities: [
        { kind: 'plane', name: 'Board', material: 'basic', color: [0.08, 0.1, 0.16, 1], transform: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 20, y: 1, z: 20 } } },
        { kind: 'ambient-light', name: 'Fill', transform: { position: { x: 0, y: 4, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
        { kind: 'empty', name: 'Game Logic' },
      ],
    }));
    assert.equal(created.beforeRevision, 1); assert.equal(created.afterRevision, 2);
    assert.equal(created.value.entities.length, 3);
    assert.equal(value.workspace.snapshot().history.entries.length, 1);
    await assert.rejects(value.runtime.prepare(call('call:create-many-invalid', 'entity.create-many', { baseRevision: 2, entities: [{ kind: 'ambient-light', material: 'basic' }] })), /Only geometry entities/);
    assert.equal(value.workspace.snapshot().document.revision, 2);
  } finally { await dispose(value); }
});

test('camera.author creates, switches, frames, orbits, follows and configures gameplay cameras atomically', async () => {
  const value = await fixture();
  try {
    const first = await approveAndExecute(value.runtime, call('call:g08-camera-first', 'camera.author', { baseRevision: 1, action: 'create', name: 'Primary Camera', transform: { position: { x: 0, y: 8, z: 12 }, rotationDegrees: { x: -30, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }));
    const second = await approveAndExecute(value.runtime, call('call:g08-camera-second', 'camera.author', { baseRevision: 2, action: 'create', name: 'Secondary Camera', projection: 'orthographic', orthographicHeight: 18 }));
    const firstId = first.value.entity.id; const secondId = second.value.entity.id;
    assert.match(firstId, /^entity:/u); assert.match(secondId, /^entity:/u);
    const activated = await approveAndExecute(value.runtime, call('call:g08-camera-activate', 'camera.author', { baseRevision: 3, action: 'activate', entityId: firstId }));
    assert.equal(activated.value.deactivatedCount, 1);
    assert.equal(value.workspace.queryGameDocument({ entityId: firstId, limit: 256 }).components.find((item) => item.type === 'haiyue.camera.3d').value.active, true);
    assert.equal(value.workspace.queryGameDocument({ entityId: secondId, limit: 256 }).components.find((item) => item.type === 'haiyue.camera.3d').value.active, false);

    const projection = await approveAndExecute(value.runtime, call('call:g08-camera-projection', 'camera.author', { baseRevision: 4, action: 'projection', entityId: firstId, projection: 'orthographic', orthographicHeight: 24, near: 0.2, far: 2_000 }));
    assert.equal(projection.value.component.value.projection, 'orthographic'); assert.equal(projection.value.component.value.orthographicHeight, 24);
    const viewport = await approveAndExecute(value.runtime, call('call:g08-camera-viewport', 'camera.author', { baseRevision: 5, action: 'viewport', entityId: firstId, viewport: { x: 0, y: 0, width: 0.5, height: 1 } }));
    assert.deepEqual(viewport.value.component.value.viewport, { x: 0, y: 0, width: 0.5, height: 1 });

    const target = await executeReady(value.runtime, call('call:g08-camera-target', 'entity.create', { baseRevision: 6, kind: 'cube', name: 'Camera Target', transform: { position: { x: 5, y: 2, z: -3 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 4, y: 2, z: 6 } } }));
    const followed = await approveAndExecute(value.runtime, call('call:g08-camera-follow', 'camera.author', { baseRevision: 7, action: 'follow', entityId: firstId, targetEntityId: target.value.entity.id, mode: 'position-and-look-at', offset: { x: 0, y: 10, z: 14 }, smoothing: 0.25 }));
    assert.equal(followed.value.component.value.targetEntityId, target.value.entity.id); assert.equal(followed.value.component.value.smoothing, 0.25);
    const framed = await approveAndExecute(value.runtime, call('call:g08-camera-frame', 'camera.author', { baseRevision: 8, action: 'frame', targetEntityId: target.value.entity.id, padding: 2 }));
    assert.deepEqual(framed.value.camera.target, { x: 5, y: 2, z: -3 }); assert.equal(framed.value.camera.orthographicSize, 24);
    const orbited = await approveAndExecute(value.runtime, call('call:g08-camera-orbit', 'camera.author', { baseRevision: 9, action: 'orbit', azimuthDelta: 45, elevationDelta: 20, distance: 30 }));
    assert.equal(orbited.value.camera.azimuthDegrees, framed.value.camera.azimuthDegrees + 45); assert.equal(orbited.value.camera.elevationDegrees, framed.value.camera.elevationDegrees + 20); assert.equal(orbited.value.camera.distance, 30);
    await value.workspace.undo(10);
    assert.equal((await executeReady(value.runtime, call('call:g08-camera-orbit-undone', 'camera.get', {}))).value.camera.azimuthDegrees, framed.value.camera.azimuthDegrees);
  } finally { await dispose(value); }
});

test('tool.search and component.configure expose registry defaults as partial semantic upserts', async () => {
  const value = await fixture();
  try {
    const search = await executeReady(value.runtime, call('call:g08-tool-search', 'tool.search', { text: 'camera', limit: 20 }));
    assert.ok(search.value.matches.some((item) => item.kind === 'tool' && item.id === 'camera.set'));
    assert.ok(search.value.matches.some((item) => item.kind === 'component' && item.id === 'haiyue.camera.3d'));
    assert.ok(search.value.matches.every((item) => !Object.hasOwn(item, 'inputSchema') && !Object.hasOwn(item, 'valueSchema')));

    const entity = await executeReady(value.runtime, call('call:g08-camera-holder', 'entity.create', { baseRevision: 1, kind: 'empty', name: 'Gameplay Camera' }));
    const camera = await approveAndExecute(value.runtime, call('call:g08-camera-configure', 'component.configure', {
      baseRevision: 2, action: 'upsert', entityId: entity.value.entity.id, type: 'haiyue.camera.3d',
      patch: { projection: 'orthographic', orthographicHeight: 30, viewport: { width: 0.5 } },
    }));
    assert.equal(camera.value.action, 'add'); assert.equal(camera.value.component.value.projection, 'orthographic');
    assert.deepEqual(camera.value.component.value.viewport, { x: 0, y: 0, width: 0.5, height: 1 });
    assert.equal(camera.value.component.value.fovDegrees, 45, 'registry defaults fill fields the caller did not transmit');
    const updated = await approveAndExecute(value.runtime, call('call:g08-camera-update', 'component.configure', { baseRevision: 3, action: 'upsert', entityId: entity.value.entity.id, type: 'haiyue.camera.3d', patch: { fovDegrees: 60 } }));
    assert.equal(updated.value.action, 'update'); assert.equal(updated.value.component.value.fovDegrees, 60); assert.equal(updated.value.component.value.projection, 'orthographic');

    const lowRisk = await value.runtime.prepare(call('call:g08-low-risk-configure', 'component.configure', { baseRevision: 4, action: 'upsert', entityId: entity.value.entity.id, type: 'haiyue.animation.state', patch: { state: 'playing' } }));
    assert.equal(lowRisk.status, 'ready'); assert.equal(lowRisk.risk, 'low'); assert.equal(lowRisk.approvalId, undefined);
    await value.runtime.execute(lowRisk.id);
    const removed = await approveAndExecute(value.runtime, call('call:g08-camera-remove', 'component.configure', { baseRevision: 5, action: 'remove', entityId: entity.value.entity.id, type: 'haiyue.camera.3d' }));
    assert.equal(removed.value.action, 'remove'); assert.equal(value.workspace.queryGameDocument({ entityId: entity.value.entity.id, limit: 256 }).components.some((item) => item.type === 'haiyue.camera.3d'), false);
    await value.workspace.undo(6);
    assert.equal(value.workspace.queryGameDocument({ entityId: entity.value.entity.id, limit: 256 }).components.some((item) => item.type === 'haiyue.camera.3d'), true);
  } finally { await dispose(value); }
});

test('asset.dependencies and script symbols/patch provide exact incremental context without whole-script retransmission', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:g08-incremental-entity', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Incremental Player' }));
    const entityId = created.value.entity.id;
    const assetId = 'asset:1234567890abcdef12345678';
    await approveAndExecute(value.runtime, call('call:g08-pbr-dependency', 'component.configure', { baseRevision: 2, action: 'upsert', entityId, type: 'haiyue.material.pbr', patch: { baseColorAssetId: assetId } }));
    const dependencies = await executeReady(value.runtime, call('call:g08-asset-dependencies', 'asset.dependencies', { assetId, entityId }));
    assert.equal(dependencies.value.count, 1); assert.equal(dependencies.value.references[0].componentType, 'haiyue.material.pbr'); assert.equal(dependencies.value.references[0].path, '/baseColorAssetId');

    const source = "const moving = api.input.isPressed('MoveLeft');\napi.scene.observe('player-state', { moving });";
    const proposal = await executeReady(value.runtime, call('call:g08-script-propose', 'script.propose', { baseRevision: 3, entityId, text: source, capabilities: ['read', 'input', 'scene'] }));
    await approveAndExecute(value.runtime, call('call:g08-script-apply', 'script.apply', { baseRevision: 3, proposalId: proposal.value.proposalId }));
    const symbols = await executeReady(value.runtime, call('call:g08-script-symbols', 'script.symbols', { entityId }));
    assert.deepEqual(symbols.value.symbols.variables, ['moving']); assert.deepEqual(symbols.value.symbols.apiNamespaces, ['input', 'scene']);
    assert.deepEqual(symbols.value.symbols.inputActions, ['MoveLeft']); assert.deepEqual(symbols.value.symbols.observationIds, ['player-state']); assert.equal(Object.hasOwn(symbols.value, 'text'), false);

    const patch = await executeReady(value.runtime, call('call:g08-script-patch', 'script.patch', { baseRevision: 4, entityId, expectedDigest: symbols.value.digest, edits: [{ startLine: 1, endLine: 1, text: "const moving = api.input.isPressed('MoveRight');" }] }));
    assert.equal(patch.value.canApply, true); assert.equal(patch.value.editCount, 1); assert.equal(patch.value.patchedFromDigest, symbols.value.digest);
    await approveAndExecute(value.runtime, call('call:g08-script-patch-apply', 'script.apply', { baseRevision: 4, proposalId: patch.value.proposalId }));
    const after = await executeReady(value.runtime, call('call:g08-script-after', 'script.get', { entityId }));
    assert.match(after.value.script.text, /MoveRight/); assert.doesNotMatch(after.value.script.text, /MoveLeft/);
    await assert.rejects(executeReady(value.runtime, call('call:g08-script-stale-patch', 'script.patch', { baseRevision: 5, entityId, expectedDigest: symbols.value.digest, edits: [{ startLine: 1, endLine: 1, text: 'const moving = false;' }] })), (error) => error.code === 'tool.script-stale');
  } finally { await dispose(value); }
});

test('scene.get-many and recoverable hierarchy operations clone, reparent and restore complete subtrees', async () => {
  const value = await fixture();
  try {
    const root = await executeReady(value.runtime, call('call:g08-root', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Root' }));
    const child = await executeReady(value.runtime, call('call:g08-child', 'entity.create', { baseRevision: 2, kind: 'sphere', name: 'Child', parentId: root.value.entity.id }));
    const many = await executeReady(value.runtime, call('call:g08-get-many', 'scene.get-many', { entityIds: [child.value.entity.id, 'entity:missing-g08', root.value.entity.id], includeComponents: false }));
    assert.deepEqual(many.value.entities.map((entity) => entity.id), [child.value.entity.id, root.value.entity.id]);
    assert.deepEqual(many.value.missingEntityIds, ['entity:missing-g08']);
    assert.ok(many.value.entities.every((entity) => !Object.hasOwn(entity, 'components')));

    await assert.rejects(
      approveAndExecute(value.runtime, call('call:g08-delete-nonrecursive', 'entity.hierarchy', { baseRevision: 3, action: 'delete', entityId: root.value.entity.id })),
      (error) => error.code === 'tool.entity-has-children',
    );
    assert.equal(value.workspace.gameSnapshot().revision, 3);

    const cloned = await approveAndExecute(value.runtime, call('call:g08-clone-subtree', 'entity.hierarchy', { baseRevision: 3, action: 'clone', entityId: root.value.entity.id, includeDescendants: true, name: 'Root Clone' }));
    assert.equal(cloned.afterRevision, 4); assert.equal(cloned.historyLabel, 'Edit Entity Hierarchy'); assert.equal(cloned.value.clonedEntityIds.length, 2);
    const [clonedRootId, clonedChildId] = cloned.value.clonedEntityIds;
    const clonedScene = value.scene.snapshot();
    assert.equal(clonedScene.entities.find((entity) => entity.id === clonedRootId).name, 'Root Clone');
    assert.equal(clonedScene.entities.find((entity) => entity.id === clonedChildId).parentId, clonedRootId);
    assert.equal(value.workspace.queryGameDocument({ entityId: clonedChildId, limit: 256 }).components.length, value.workspace.queryGameDocument({ entityId: child.value.entity.id, limit: 256 }).components.length);

    const reparented = await approveAndExecute(value.runtime, call('call:g08-reparent', 'entity.hierarchy', { baseRevision: 4, action: 'reparent', entityId: clonedChildId, parentId: null, order: 20 }));
    assert.equal(reparented.value.entity.parentId, null); assert.equal(reparented.value.entity.order, 20);
    const removed = await approveAndExecute(value.runtime, call('call:g08-delete-subtree', 'entity.hierarchy', { baseRevision: 5, action: 'delete', entityId: clonedRootId, includeDescendants: true }));
    assert.deepEqual(removed.value.removedEntityIds, [clonedRootId]);
    assert.equal(value.scene.snapshot().entities.some((entity) => entity.id === clonedRootId), false);
    await value.workspace.undo(6);
    assert.equal(value.scene.snapshot().entities.some((entity) => entity.id === clonedRootId), true, 'History Undo must restore removed entities and components');
  } finally { await dispose(value); }
});

test('prefab.manage captures, instantiates and removes reusable subtrees while history.query stays bounded and source-redacted', async () => {
  const value = await fixture();
  try {
    const root = await executeReady(value.runtime, call('call:g08-prefab-root', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Reusable Root' }));
    const child = await executeReady(value.runtime, call('call:g08-prefab-child', 'entity.create', { baseRevision: 2, kind: 'sphere', name: 'Reusable Child', parentId: root.value.entity.id }));
    const source = "api.scene.observe('prefab-state', { state: 'ready' });";
    const proposal = await executeReady(value.runtime, call('call:g08-prefab-script-propose', 'script.propose', { baseRevision: 3, entityId: child.value.entity.id, text: source, capabilities: ['read', 'scene'] }));
    await approveAndExecute(value.runtime, call('call:g08-prefab-script-apply', 'script.apply', { baseRevision: 3, proposalId: proposal.value.proposalId }));

    const captured = await approveAndExecute(value.runtime, call('call:g08-prefab-capture', 'prefab.manage', { baseRevision: 4, action: 'capture', prefabId: 'prefab:reusable-enemy', entityId: root.value.entity.id, name: 'Reusable Enemy' }));
    assert.equal(captured.afterRevision, 5); assert.equal(captured.value.prefab.entityCount, 2); assert.equal(captured.value.prefab.scriptCount, 1);
    assert.doesNotMatch(JSON.stringify(captured.value), /prefab-state|observe/u, 'tool results must not disclose captured source');
    const settings = await executeReady(value.runtime, call('call:g08-prefab-settings-redaction', 'scene.query', { revision: 5, projection: ['settings'], limit: 100 }));
    assert.equal(settings.value.items.some((item) => item.value?.key === 'studio.prefabs.v1'), false, 'exact context must not expose private prefab script storage');

    const history = await executeReady(value.runtime, call('call:g08-prefab-history', 'history.query', { limit: 2 }));
    assert.equal(history.value.entries[0].label, 'Capture Prefab'); assert.equal(history.value.count, 2); assert.equal(history.value.truncated, true);
    assert.equal(Object.hasOwn(history.value.entries[0], 'operations'), false); assert.doesNotMatch(JSON.stringify(history.value), /prefab-state|observe/u);
    const older = await executeReady(value.runtime, call('call:g08-prefab-history-page', 'history.query', { beforeEntryId: history.value.nextBeforeEntryId, limit: 100 }));
    assert.ok(older.value.entries.length >= 1); assert.ok(older.value.entries.every((entry) => entry.id < history.value.nextBeforeEntryId));

    const instantiated = await approveAndExecute(value.runtime, call('call:g08-prefab-instantiate', 'prefab.manage', { baseRevision: 5, action: 'instantiate', prefabId: 'prefab:reusable-enemy', name: 'Enemy Instance' }));
    assert.equal(instantiated.afterRevision, 6); assert.equal(instantiated.value.instantiatedEntityIds.length, 2); assert.equal(instantiated.value.entity.name, 'Enemy Instance');
    assert.ok(instantiated.value.instantiatedEntityIds.every((id) => ![root.value.entity.id, child.value.entity.id].includes(id)));
    const clonedScript = value.workspace.gameSnapshot().scripts.find((item) => item.entityId === instantiated.value.instantiatedEntityIds[1]);
    assert.equal(clonedScript.source, source); assert.match(clonedScript.sourcePath, /^scripts\/script-m13-/u);
    assert.doesNotMatch(JSON.stringify(instantiated.value), /prefab-state|observe/u);

    await value.workspace.undo(6);
    assert.ok(instantiated.value.instantiatedEntityIds.every((id) => !value.scene.snapshot().entities.some((entity) => entity.id === id)), 'one Undo removes the complete instance');
    await value.workspace.redo(value.workspace.gameSnapshot().revision);
    assert.ok(instantiated.value.instantiatedEntityIds.every((id) => value.scene.snapshot().entities.some((entity) => entity.id === id)), 'Redo restores the complete instance');

    const removed = await approveAndExecute(value.runtime, call('call:g08-prefab-remove', 'prefab.manage', { baseRevision: value.workspace.gameSnapshot().revision, action: 'remove', prefabId: 'prefab:reusable-enemy' }));
    assert.equal(removed.value.remainingCount, 0); assert.equal(Object.hasOwn(value.workspace.gameSnapshot().settings, 'studio.prefabs.v1'), false);
    await value.workspace.undo(value.workspace.gameSnapshot().revision);
    const reinstantiated = await approveAndExecute(value.runtime, call('call:g08-prefab-after-undo', 'prefab.manage', { baseRevision: value.workspace.gameSnapshot().revision, action: 'instantiate', prefabId: 'prefab:reusable-enemy' }));
    assert.equal(reinstantiated.value.instantiatedEntityIds.length, 2, 'Undo restores the removed prefab registry entry');
  } finally { await dispose(value); }
});

test('transform.batch applies set, align, distribute, snap and look-at as bounded single-revision edits', async () => {
  const value = await fixture();
  try {
    const created = [];
    for (const [index, kind] of ['cube', 'sphere', 'cone'].entries()) created.push(await executeReady(value.runtime, call(`call:g08-transform-create-${index}`, 'entity.create', { baseRevision: 1 + index, kind, name: `Spatial ${index}` })));
    const ids = created.map((result) => result.value.entity.id);
    const transform = (x, y, z) => ({ position: { x, y, z }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
    const set = await approveAndExecute(value.runtime, call('call:g08-transform-set', 'transform.batch', { baseRevision: 4, action: 'set', transforms: ids.map((entityId, index) => ({ entityId, transform: transform(index * 4 + 0.2, index * 2 + 1, index + 0.4) })) }));
    assert.equal(set.afterRevision, 5); assert.equal(set.historyLabel, 'Batch Transform'); assert.equal(set.value.entities.length, 3);
    const align = await approveAndExecute(value.runtime, call('call:g08-transform-align', 'transform.batch', { baseRevision: 5, action: 'align', entityIds: ids, axis: 'y', mode: 'min' }));
    assert.deepEqual(align.value.entities.map((entity) => entity.transform.position.y), [1, 1, 1]);
    const distribute = await approveAndExecute(value.runtime, call('call:g08-transform-distribute', 'transform.batch', { baseRevision: 6, action: 'distribute', entityIds: ids, axis: 'x', spacing: 3 }));
    assert.deepEqual(distribute.value.entities.map((entity) => entity.transform.position.x), [0.2, 3.2, 6.2]);
    const snapped = await approveAndExecute(value.runtime, call('call:g08-transform-snap', 'transform.batch', { baseRevision: 7, action: 'snap', entityIds: ids, grid: 1 }));
    assert.deepEqual(snapped.value.entities.map((entity) => entity.transform.position), [{ x: 0, y: 1, z: 0 }, { x: 3, y: 1, z: 1 }, { x: 6, y: 1, z: 2 }]);
    const oriented = await approveAndExecute(value.runtime, call('call:g08-transform-look-at', 'transform.batch', { baseRevision: 8, action: 'look-at', entityIds: ids, target: { x: 0, y: 5, z: 10 } }));
    assert.ok(oriented.value.entities.every((entity) => Number.isFinite(entity.transform.rotationDegrees.x) && Number.isFinite(entity.transform.rotationDegrees.y)));
    await value.workspace.undo(9);
    assert.deepEqual(value.scene.snapshot().entities.map((entity) => entity.transform.rotationDegrees), [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]);
  } finally { await dispose(value); }
});

test('main project camera persists through History and supports a distortion-free top-down board view', async () => {
  const value = await fixture();
  const topDown = {
    projection: 'orthographic', target: { x: 0, y: 0, z: 0 }, distance: 25,
    azimuthDegrees: 0, elevationDegrees: 90, fovDegrees: 45, orthographicSize: 24, near: 0.1, far: 1_000,
  };
  try {
    const initial = await executeReady(value.runtime, call('call:camera-get-initial', 'camera.get', {}));
    assert.equal(initial.value.camera.projection, 'perspective');
    const prepared = await value.runtime.prepare(call('call:camera-top-down', 'camera.set', { baseRevision: 1, camera: topDown }));
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.approvalId, undefined);
    const changed = await value.runtime.execute(prepared.id);
    assert.equal(changed.afterRevision, 2);
    assert.equal(changed.historyLabel, 'Set Camera');
    assert.deepEqual(changed.value.camera, topDown);
    assert.deepEqual(value.workspace.snapshot().document.settings['studio.camera.main'], topDown);

    await value.workspace.undo(2);
    const undone = await executeReady(value.runtime, call('call:camera-get-undone', 'camera.get', {}));
    assert.equal(undone.value.camera.projection, 'perspective');
    await value.workspace.redo(3);
    const redone = await executeReady(value.runtime, call('call:camera-get-redone', 'camera.get', {}));
    assert.deepEqual(redone.value.camera, topDown);
  } finally { await dispose(value); }
});

test('runtime executes a prepared mutation batch through one Scene transaction and one undoable History entry', async () => {
  const value = await fixture();
  try {
    const preparations = await Promise.all([
      value.runtime.prepare(call('call:g07-batch-a', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Batch A' })),
      value.runtime.prepare(call('call:g07-batch-b', 'entity.create', { baseRevision: 1, kind: 'sphere', name: 'Batch B' })),
      value.runtime.prepare(call('call:g07-batch-c', 'entity.create', { baseRevision: 1, kind: 'plane', name: 'Batch C' })),
    ]);
    const committed = await value.runtime.executeTransaction({ sessionId: 'session:fixture', turnId: 'turn:fixture', batchId: 'batch:g07-runtime', preparationIds: preparations.map((item) => item.id) });
    assert.equal(committed.beforeRevision, 1); assert.equal(committed.afterRevision, 2);
    assert.equal(committed.results.length, 3); assert.equal(new Set(committed.results.map((item) => item.transaction.transactionId)).size, 1);
    assert.equal(value.workspace.snapshot().history.entries.length, 1);
    assert.deepEqual(value.scene.snapshot().entities.map((item) => item.name), ['Batch A', 'Batch B', 'Batch C']);
    await value.workspace.undo(2);
    assert.equal(value.scene.snapshot().entities.length, 0, 'one undo must reverse every transaction member');
  } finally { await dispose(value); }
});

test('scene.query and scene.diff expose paged exact context while project.snapshot stays an identity summary', async () => {
  const value = await fixture();
  try {
    const summary = await executeReady(value.runtime, call('call:g05-summary', 'project.snapshot', {}));
    assert.equal(Object.hasOwn(summary.value, 'camera'), false); assert.deepEqual(summary.value.counts.entities, 0);
    const baseline = await executeReady(value.runtime, call('call:g05-baseline', 'scene.query', { revision: 1, projection: ['hierarchy', 'scripts'], limit: 1 }));
    assert.equal(baseline.value.revision, 1); assert.deepEqual(baseline.value.items, []);
    const created = await executeReady(value.runtime, call('call:g05-create', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Delta Cube' }));
    const first = await executeReady(value.runtime, call('call:g05-diff-1', 'scene.diff', { fromRevision: 1, toRevision: created.afterRevision, limit: 1 }));
    assert.equal(first.value.diff.fromRevision, 1); assert.equal(first.value.diff.toRevision, 2); assert.equal(first.value.diff.truncated, true); assert.ok(first.value.diff.nextCursor);
    assert.equal(first.value.diff.transactionIds.length, 1); assert.match(first.value.diff.transactionIds[0], /^command:agent:/u); assert.ok(first.value.diff.provenanceOpIds.some((id) => id.startsWith('event:tools:')));
    const second = await executeReady(value.runtime, call('call:g05-diff-2', 'scene.diff', { fromRevision: 1, toRevision: 2, limit: 1, cursor: first.value.diff.nextCursor }));
    assert.equal(second.value.diff.digest, first.value.diff.digest);
    const current = await executeReady(value.runtime, call('call:g05-current', 'scene.query', { projection: ['hierarchy', 'components'], limit: 100 }));
    assert.equal(current.value.items.filter((item) => item.kind === 'entity').length, 1); assert.equal(current.value.items.some((item) => Object.hasOwn(item.value, 'source')), false);
    await assert.rejects(executeReady(value.runtime, call('call:g05-future', 'scene.diff', { fromRevision: 2, toRevision: 99 })), /newer than current revision/u);
  } finally { await dispose(value); }
});

test('planned entity creation is low risk while later scoped edits retain one-shot approval and History', async () => {
  const value = await fixture();
  try {
    const create = await value.runtime.prepare(call('call:create', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Player' }));
    assert.equal(create.status, 'ready');
    assert.equal(create.approvalId, undefined);
    const created = await value.runtime.execute(create.id);
    assert.equal(created.afterRevision, 2);
    assert.equal(created.historyLabel, 'Create Scene Entity');
    const entityId = created.value.entity.id;
    assert.equal(value.scene.snapshot().entities[0].name, 'Player');

    const rename = await value.runtime.prepare(call('call:rename', 'entity.rename', { baseRevision: 2, entityId, name: 'Hero' }));
    assert.equal(rename.status, 'approval-required');
    await assert.rejects(value.runtime.execute(rename.id), /requires approval/);
    await value.runtime.decide(rename.approvalId, 'allow-once');
    await assert.rejects(value.runtime.decide(rename.approvalId, 'allow-once'), /not pending/);
    const renamed = await value.runtime.execute(rename.id);
    assert.equal(renamed.afterRevision, 3);
    assert.equal(value.scene.snapshot().entities[0].name, 'Hero');
    await value.workspace.undo(3);
    assert.equal(value.scene.snapshot().entities[0].name, 'Player');
    await value.workspace.redo(4);
    assert.equal(value.scene.snapshot().entities[0].name, 'Hero');

    const facts = await value.operationLog.query({ toolCallId: asStableId('call:rename'), limit: 50, traverseCorrelation: false });
    assert.deepEqual(facts.events.filter((item) => item.kind.startsWith('tool/') || item.kind.startsWith('approval/')).map((item) => item.kind), [
      'tool/call-received', 'tool/pre-policy-passed', 'tool/preview-prepared', 'approval/requested', 'approval/allow-once', 'tool/effect-lock-acquired', 'tool/execution-started', 'tool/execution-completed', 'tool/effect-lock-released',
    ]);
    assert.doesNotMatch(JSON.stringify(facts.events), /"name":"Hero"/);
  } finally { await dispose(value); }
});

test('controlled project assets import, search, assign, undo and survive project reopen', async () => {
  const value = await fixture();
  try {
    await mkdir(path.join(value.projectRoot, 'assets', 'textures'), { recursive: true });
    await writeFile(path.join(value.projectRoot, 'assets', 'textures', 'player.png'), pngHeader(2, 2));
    const created = await executeReady(value.runtime, call('call:asset-entity', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Textured Player' }));
    const entityId = created.value.entity.id;

    await assert.rejects(
      value.runtime.prepare(call('call:asset-traversal', 'asset.import', { baseRevision: 2, projectPath: 'assets/../outside.png', kind: 'texture', mimeType: 'image/png', license: 'project-owned', provenance: 'test fixture', decodedBytes: 8 })),
      /project assets directory/,
    );

    const imported = await approveAndExecute(value.runtime, call('call:asset-import', 'asset.import', {
      baseRevision: 2, projectPath: 'assets/textures/player.png', kind: 'texture', mimeType: 'image/png',
      license: 'project-owned', provenance: 'runtime test fixture', decodedBytes: 64, width: 2, height: 2,
    }));
    assert.equal(imported.afterRevision, 3);
    assert.equal(imported.historyLabel, 'Import Asset');
    assert.match(imported.value.asset.id, /^asset:[a-f0-9]{24}$/);
    assert.equal(value.workspace.gameSnapshot().assets.length, 1);
    assert.equal(value.scene.snapshot().assets[0].id, imported.value.asset.id);

    const search = await executeReady(value.runtime, call('call:asset-search', 'asset.search', { text: 'player', kind: 'texture', limit: 10 }));
    assert.equal(search.value.count, 1);
    assert.equal(search.value.assets[0].projectPath, 'assets/textures/player.png');
    assert.equal(search.value.assets[0].license, 'project-owned');
    assert.equal('bytes' in search.value.assets[0], false);

    const assigned = await approveAndExecute(value.runtime, call('call:asset-assign', 'asset.assign', { baseRevision: 3, entityId, assetId: imported.value.asset.id, usage: 'texture.base-color' }));
    assert.equal(assigned.afterRevision, 4);
    assert.equal(assigned.historyLabel, 'Assign Asset');
    assert.equal(assigned.value.component.type, 'haiyue.material.pbr');
    assert.equal(assigned.value.component.value.baseColorAssetId, imported.value.asset.id);

    await value.workspace.undo(4);
    assert.equal(value.workspace.queryGameDocument({ entityId, limit: 256 }).components.some((item) => item.type === 'haiyue.material.pbr'), false);
    await value.workspace.redo(5);
    assert.equal(value.workspace.queryGameDocument({ entityId, limit: 256 }).components.find((item) => item.type === 'haiyue.material.pbr').value.baseColorAssetId, imported.value.asset.id);

    await value.workspace.save();
    await value.workspace.closeProject();
    await value.workspace.openProject(value.projectRoot);
    const reopened = await executeReady(value.runtime, call('call:asset-search-reopened', 'asset.search', { limit: 10 }));
    assert.equal(reopened.value.count, 1);
    assert.equal(reopened.value.assets[0].digest, imported.value.asset.digest);
    assert.equal(value.scene.snapshot().assets[0].digest, imported.value.asset.digest);
  } finally { await dispose(value); }
});

test('controlled asset import rejects decode-budget and kind/format violations without mutation', async () => {
  const value = await fixture();
  try {
    await mkdir(path.join(value.projectRoot, 'assets'), { recursive: true });
    await writeFile(path.join(value.projectRoot, 'assets', 'bad.png'), Buffer.from([1, 2, 3, 4]));
    const prepared = await value.runtime.prepare(call('call:asset-budget', 'asset.import', { baseRevision: 1, projectPath: 'assets/bad.png', kind: 'texture', mimeType: 'image/png', license: 'internal-test', provenance: 'failure fixture', decodedBytes: 2 }));
    await value.runtime.decide(prepared.approvalId, 'allow-once');
    await assert.rejects(value.runtime.execute(prepared.id), (error) => error.code === 'asset.decode-budget');
    assert.equal(value.workspace.gameSnapshot().revision, 1);
    assert.equal(value.workspace.gameSnapshot().assets.length, 0);

    const format = await value.runtime.prepare(call('call:asset-format', 'asset.import', { baseRevision: 1, projectPath: 'assets/bad.png', kind: 'model', mimeType: 'model/gltf-binary', license: 'internal-test', provenance: 'failure fixture', decodedBytes: 4 }));
    await value.runtime.decide(format.approvalId, 'allow-once');
    await assert.rejects(value.runtime.execute(format.id), (error) => error.code === 'asset.format-not-allowed');
    assert.equal(value.workspace.gameSnapshot().revision, 1);
  } finally { await dispose(value); }
});

test('diagnostics query returns redacted bounded pages with a query-bound cursor and no raw payload', async () => {
  const value = await fixture();
  try {
    await executeReady(value.runtime, call('call:diagnostic-source-1', 'project.snapshot', {}));
    await executeReady(value.runtime, call('call:diagnostic-source-2', 'scene.list-entities', {}));
    const first = await executeReady(value.runtime, call('call:diagnostics-page-1', 'diagnostics.query', { limit: 2, traverseCorrelation: false }));
    assert.equal(first.value.count, 2);
    assert.equal(typeof first.value.nextCursor, 'string');
    assert.doesNotMatch(JSON.stringify(first.value.events), /"payload"|projectRoot|authorization/i);
    assert.ok(first.value.events.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.payloadDigest)));
    const second = await executeReady(value.runtime, call('call:diagnostics-page-2', 'diagnostics.query', { limit: 2, traverseCorrelation: false, cursor: first.value.nextCursor }));
    assert.equal(second.value.count, 2);
    assert.notDeepEqual(second.value.events.map((item) => item.eventId), first.value.events.map((item) => item.eventId));
  } finally { await dispose(value); }
});

test('allow always auto-approves only the same tool, version, target and project session scope', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-always-target', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'First' }));
    const first = await value.runtime.prepare(call('call:always-first', 'entity.rename', { baseRevision: 2, entityId: created.value.entity.id, name: 'First Rename' }));
    assert.equal(first.status, 'approval-required');
    assert.equal((await value.runtime.decide(first.approvalId, 'allow-always')).decision, 'allow-always');
    await value.runtime.execute(first.id);
    assert.equal(value.runtime.snapshot().activeApprovalGrants, 1);

    const second = await value.runtime.prepare(call('call:always-second', 'entity.rename', { baseRevision: 3, entityId: created.value.entity.id, name: 'Second Rename' }));
    assert.equal(second.status, 'ready');
    assert.equal(second.approvalId, undefined);
    await value.runtime.execute(second.id);

    const differentTool = await value.runtime.prepare(call('call:always-material', 'material.set', { baseRevision: 4, entityId: created.value.entity.id, material: 'pbr' }));
    assert.equal(differentTool.status, 'approval-required');
    const differentSession = await value.runtime.prepare({ ...call('call:always-other-session', 'entity.rename', { baseRevision: 4, entityId: created.value.entity.id, name: 'Other Session' }), sessionId: 'session:other' });
    assert.equal(differentSession.status, 'approval-required');
    const facts = await value.operationLog.query({ toolCallId: asStableId('call:always-second'), limit: 20, traverseCorrelation: false });
    assert.deepEqual(facts.events.filter((item) => item.kind.startsWith('tool/') || item.kind.startsWith('approval/')).map((item) => item.kind), [
      'tool/call-received', 'tool/pre-policy-passed', 'tool/preview-prepared', 'approval/auto-allowed', 'tool/effect-lock-acquired', 'tool/execution-started', 'tool/execution-completed', 'tool/effect-lock-released',
    ]);
  } finally { await dispose(value); }
});

test('script proposal, trusted apply and runtime start preserve separate approvals', async () => {
  const value = await fixture();
  try {
    const create = await approveAndExecute(value.runtime, call('call:create-script-entity', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Runner' }));
    const entityId = create.value.entity.id;
    const proposed = await executeReady(value.runtime, call('call:propose', 'script.propose', { baseRevision: 2, entityId, text: movementScript, capabilities: ['read', 'debug'] }));
    assert.equal(proposed.value.diagnostics.length, 0);
    assert.equal(value.workspace.snapshot().document.revision, 2);

    const apply = await value.runtime.prepare(call('call:apply', 'script.apply', { baseRevision: 2, proposalId: proposed.value.proposalId }));
    assert.equal(apply.effect, 'trusted-code');
    await assert.rejects(value.runtime.decide(apply.approvalId, 'allow-always'), /one-shot approval/);
    await value.runtime.decide(apply.approvalId, 'allow-once');
    const applied = await value.runtime.execute(apply.id);
    assert.equal(applied.afterRevision, 3);

    const validated = await executeReady(value.runtime, call('call:validate', 'preview.validate', {}));
    const start = await value.runtime.prepare(call('call:start', 'play.start', { baseRevision: 3, planId: validated.value.planId }));
    assert.notEqual(start.approvalId, apply.approvalId);
    await assert.rejects(value.runtime.decide(start.approvalId, 'allow-always'), /one-shot approval/);
    await value.runtime.decide(start.approvalId, 'allow-once');
    const started = await value.runtime.execute(start.id);
    assert.equal(started.value.state, 'playing');
    assert.equal(value.preview.starts, 1);
    const stepped = await executeReady(value.runtime, call('call:play-step', 'play.step', { count: 3 }));
    assert.equal(stepped.value.projection.stepped, 3);
    const injected = await executeReady(value.runtime, call('call:play-input', 'play.input', { event: { tick: 13, kind: 'action', action: 'move-left', phase: 'down', source: 'synthetic' } }));
    assert.equal(injected.value.projection.input.action, 'move-left');
    const physics = await executeReady(value.runtime, call('call:play-physics', 'play.physics-query', { kind: 'raycast', dimension: '3d', origin: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maxDistance: 10 }));
    assert.equal(physics.value.projection.query.kind, 'raycast');
    const inspected = await executeReady(value.runtime, call('call:play-inspect', 'play.inspect', {}));
    assert.match(inspected.value.observation.id, /^artifact:sha256:/);
    const captured = await executeReady(value.runtime, call('call:play-capture', 'play.capture', {}));
    assert.equal(captured.value.projection.byteLength, 8);
    assert.equal('base64' in captured.value, false);
    const evaluated = await executeReady(value.runtime, call('call:task-evaluate', 'task.evaluate', {
      taskSpec: { schemaVersion: 2, id: 'task:session:fixture', request: 'Verify score', visibleConstraints: [], budgetId: 'budget:fixture', requiredCapabilities: ['play.inspect'], acceptance: [{ id: 'acceptance:score', required: true, visibility: 'agent', category: 'functional', assertion: 'evidence state signal score equals 4' }] },
      observationIds: [inspected.value.observation.id],
    }));
    assert.equal(evaluated.value.status, 'pass');
    assert.deepEqual(evaluated.value.acceptanceResults[0].evidenceIds, [inspected.value.observation.id]);
    const stopped = await executeReady(value.runtime, call('call:stop', 'play.stop', {}));
    assert.equal(stopped.value.state, 'stopped');
    assert.equal(stopped.value.projection.cleanupComplete, true);
    assert.equal(value.preview.stops, 1);
  } finally { await dispose(value); }
});

test('AI-generated engine imports and update wrappers are normalized before apply', async () => {
  const value = await fixture();
  try {
    const create = await approveAndExecute(value.runtime, call('call:create-invalid-script-entity', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Invalid Script' }));
    const proposed = await executeReady(value.runtime, call('call:propose-invalid-module', 'script.propose', {
      baseRevision: 2, entityId: create.value.entity.id, text: "```ts\nimport { Entity } from '@haiyue/engine';\nexport function onUpdate(ctx: unknown): void { entity.name; }\n```", capabilities: ['read', 'debug'],
    }));
    assert.equal(proposed.value.canApply, true);
    assert.deepEqual(new Set(proposed.value.repairs), new Set(['removed-markdown-fence', 'removed-redundant-engine-import', 'adapted-update-lifecycle-wrapper']));
    const applied = await approveAndExecute(value.runtime, call('call:apply-normalized-module', 'script.apply', { baseRevision: 2, proposalId: proposed.value.proposalId }));
    assert.equal(applied.afterRevision, 3);
    const source = value.projectScripts.snapshot().resources[0].text;
    assert.doesNotMatch(source, /```|import|export/u);
    assert.match(source, /onUpdate\(\{ entity, component, world, time, delta, api \}\);/u);
  } finally { await dispose(value); }
});

test('unsupported module entry points remain fail closed', async () => {
  const value = await fixture();
  try {
    const create = await approveAndExecute(value.runtime, call('call:create-unsupported-module', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Unsupported Script' }));
    const proposed = await executeReady(value.runtime, call('call:propose-unsupported-module', 'script.propose', {
      baseRevision: 2, entityId: create.value.entity.id, text: 'export function start(): void {}', capabilities: ['read', 'debug'],
    }));
    assert.equal(proposed.value.canApply, false);
    assert.ok(proposed.value.diagnostics.some((item) => item.code === 'script.capability.module-forbidden'));
    const runtimeImport = await executeReady(value.runtime, call('call:propose-runtime-import', 'script.propose', {
      baseRevision: 2, entityId: create.value.entity.id, text: "import { Entity } from '@haiyue/engine';\nconst extra = new Entity('unsafe');", capabilities: ['read', 'debug'],
    }));
    assert.equal(runtimeImport.value.canApply, false, 'value imports cannot be erased into a later runtime ReferenceError');
    assert.deepEqual(runtimeImport.value.repairs, []);
  } finally { await dispose(value); }
});

test('scene capability is inferred from api.scene source and survives proposal and preview validation', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-instance-target', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'SnakeBody' }));
    const source = `const body = api.scene.instances('SnakeBody', 256);\nbody.setCount(1);\nbody.set(0, { position: { x: 0, y: 0, z: 0 } });`;
    const proposed = await executeReady(value.runtime, call('call:propose-inferred-scene', 'script.propose', {
      baseRevision: created.afterRevision, entityId: created.value.entity.id, text: source, capabilities: ['read', 'input', 'debug'],
    }));
    assert.equal(proposed.value.canApply, true);
    assert.deepEqual(proposed.value.capabilities, ['read', 'input', 'debug', 'scene']);
    assert.deepEqual(proposed.value.diagnostics, []);

    const applied = await approveAndExecute(value.runtime, call('call:apply-inferred-scene', 'script.apply', {
      baseRevision: created.afterRevision, proposalId: proposed.value.proposalId,
    }));
    const validated = await executeReady(value.runtime, call('call:validate-inferred-scene', 'preview.validate', {}));
    assert.deepEqual(new Set(validated.value.capabilities), new Set(['read', 'input', 'debug', 'scene']));
    assert.deepEqual(validated.value.diagnostics, []);
  } finally { await dispose(value); }
});

test('preview validation rejects scenes that contain only logic entities', async () => {
  const value = await fixture();
  try {
    const create = await approveAndExecute(value.runtime, call('call:create-empty-script-entity', 'entity.create', { baseRevision: 1, kind: 'empty', name: 'Logic Root' }));
    const proposed = await executeReady(value.runtime, call('call:propose-empty-scene', 'script.propose', { baseRevision: 2, entityId: create.value.entity.id, text: movementScript, capabilities: ['read', 'debug'] }));
    const applied = await approveAndExecute(value.runtime, call('call:apply-empty-scene', 'script.apply', { baseRevision: 2, proposalId: proposed.value.proposalId }));
    const prepared = await value.runtime.prepare(call('call:validate-empty-scene', 'preview.validate', {}));
    await assert.rejects(value.runtime.execute(prepared.id), /no renderable geometry/);
    assert.equal(value.preview.starts, 0);
  } finally { await dispose(value); }
});

test('Agent tools create Engine primitives and lights and can change built-in materials', async () => {
  const value = await fixture();
  try {
    const sphere = await approveAndExecute(value.runtime, call('call:create-sphere', 'entity.create', { baseRevision: 1, kind: 'sphere', name: 'Player Ball', material: 'pbr', color: [0.15, 0.8, 0.25, 1] }));
    assert.equal(sphere.value.entity.kind, 'sphere');
    assert.equal(sphere.value.entity.appearance.material, 'pbr');
    assert.deepEqual(sphere.value.entity.appearance.color, [0.15, 0.8, 0.25, 1]);
    const light = await approveAndExecute(value.runtime, call('call:create-light', 'entity.create', { baseRevision: 2, kind: 'directional-light', name: 'Sun' }));
    assert.equal(light.value.entity.kind, 'directional-light');
    assert.equal(light.value.entity.light.intensity, 1);
    const material = await approveAndExecute(value.runtime, call('call:set-material', 'material.set', { baseRevision: 3, entityId: sphere.value.entity.id, material: 'blinn-phong', color: [1, 0.2, 0.1, 1] }));
    assert.equal(material.value.entity.appearance.material, 'blinn-phong');
    assert.deepEqual(material.value.entity.appearance.color, [1, 0.2, 0.1, 1]);
    assert.equal(material.historyLabel, 'Set Material');
    await assert.rejects(value.runtime.prepare(call('call:light-material', 'material.set', { baseRevision: 4, entityId: light.value.entity.id, material: 'basic' })), /Only geometry entities/);
    await assert.rejects(value.runtime.prepare(call('call:empty-pbr', 'entity.create', { baseRevision: 4, kind: 'empty', material: 'pbr' })), /Only geometry entities/);
    await assert.rejects(value.runtime.prepare(call('call:bad-color', 'material.set', { baseRevision: 4, entityId: sphere.value.entity.id, material: 'pbr', color: [2, 0, 0, 1] })), /RGBA array/);
  } finally { await dispose(value); }
});

test('registry-driven component tools preserve schema, risk, Scene projection and History', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-camera-owner', 'entity.create', { kind: 'empty', name: 'Gameplay Camera' }));
    const entityId = created.value.entity.id;
    const capabilities = await executeReady(value.runtime, call('call:capabilities', 'engine.capabilities.describe', {}));
    assert.ok(capabilities.value.componentCount >= 13);
    assert.ok(capabilities.value.components.some((item) => item.type === 'haiyue.camera.3d' && item.runtimeAdapter === 'adapter.camera.3d'));
    const described = await executeReady(value.runtime, call('call:describe-camera', 'component.describe', { type: 'haiyue.camera.3d' }));
    assert.equal(described.value.definition.risk, 'medium');
    assert.equal(described.value.definition.capability, 'camera.3d');

    const add = await value.runtime.prepare(call('call:add-gameplay-camera', 'component.add', { baseRevision: 2, entityId, type: 'haiyue.camera.3d', value: {} }));
    assert.equal(add.risk, 'medium');
    assert.equal(add.status, 'approval-required');
    await value.runtime.decide(add.approvalId, 'allow-once');
    const added = await value.runtime.execute(add.id);
    assert.equal(added.historyLabel, 'Add Component');
    assert.equal(added.value.component.value.projection, 'perspective');
    const componentId = added.value.component.id;
    assert.ok(value.scene.snapshot().entities[0].components.some((item) => item.id === componentId));

    const byId = await executeReady(value.runtime, call('call:get-gameplay-camera', 'component.get', { componentId }));
    const byType = await executeReady(value.runtime, call('call:get-gameplay-camera-by-type', 'component.get', { entityId, type: 'haiyue.camera.3d' }));
    assert.equal(byId.value.component.id, byType.value.component.id);
    const orthographic = { ...byId.value.component.value, projection: 'orthographic', orthographicHeight: 24 };
    const set = await value.runtime.prepare(call('call:set-gameplay-camera', 'component.set', { baseRevision: 3, componentId, value: orthographic }));
    assert.equal(set.risk, 'medium');
    await value.runtime.decide(set.approvalId, 'allow-once');
    const changed = await value.runtime.execute(set.id);
    assert.equal(changed.value.component.value.projection, 'orthographic');
    assert.equal(changed.historyLabel, 'Set Component');
    await value.workspace.undo(4);
    assert.equal((await executeReady(value.runtime, call('call:get-camera-after-undo', 'component.get', { componentId }))).value.component.value.projection, 'perspective');
    await value.workspace.redo(5);

    const remove = await value.runtime.prepare(call('call:remove-gameplay-camera', 'component.remove', { baseRevision: 6, componentId }));
    assert.equal(remove.risk, 'medium');
    await value.runtime.decide(remove.approvalId, 'allow-once');
    const removed = await value.runtime.execute(remove.id);
    assert.equal(removed.historyLabel, 'Remove Component');
    assert.equal(value.scene.snapshot().entities[0].components.some((item) => item.id === componentId), false);
    await assert.rejects(executeReady(value.runtime, call('call:get-removed-camera', 'component.get', { componentId })), /does not exist/);
  } finally { await dispose(value); }
});

test('Agent can author distinct material colors for snake, food and board entities', async () => {
  const value = await fixture();
  try {
    const snake = await executeReady(value.runtime, call('call:create-snake-material', 'entity.create', { kind: 'cube', name: 'SnakeBody', material: 'pbr', color: [0.12, 0.82, 0.28, 1] }));
    const food = await executeReady(value.runtime, call('call:create-food-material', 'entity.create', { kind: 'sphere', name: 'Food', material: 'pbr', color: [1, 0.18, 0.12, 1] }));
    const board = await executeReady(value.runtime, call('call:create-board-material', 'entity.create', { kind: 'plane', name: 'Board', material: 'basic', color: [0.06, 0.09, 0.14, 1] }));
    assert.equal(new Set([snake.value.entity.appearance.color.join(','), food.value.entity.appearance.color.join(','), board.value.entity.appearance.color.join(',')]).size, 3);
  } finally { await dispose(value); }
});

test('model-facing mutations bind the current revision and create with an initial Transform', async () => {
  const value = await fixture();
  try {
    const initialTransform = (position) => ({ position, rotationDegrees: { x: 0, y: 45, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
    const definition = GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'entity.create');
    assert.deepEqual(definition.inputSchema.required, ['kind']);
    assert.ok(definition.inputSchema.properties.transform);

    const create = await value.runtime.prepare(call('call:create-positioned', 'entity.create', {
      kind: 'sphere', name: 'Positioned Ball', material: 'pbr', transform: initialTransform({ x: 3, y: 2, z: 1 }),
    }));
    assert.equal(create.baseRevision, 1);
    assert.equal(create.status, 'ready');
    const created = await value.runtime.execute(create.id);
    assert.equal(created.afterRevision, 2);
    assert.deepEqual(created.value.entity.transform.position, { x: 3, y: 2, z: 1 });

    await assert.rejects(
      value.runtime.prepare(call('call:transform-without-target', 'transform.set', { transform: initialTransform({ x: 4, y: 0, z: 0 }) })),
      /transform\.set arguments invalid; missing required fields: entityId; unknown fields: none/,
    );
  } finally { await dispose(value); }
});

test('manual UI service and Agent tool serialize the same entity, revision and undoable History state', async () => {
  const agent = await fixture(); const manual = await fixture();
  const input = {
    baseRevision: 1, kind: 'sphere', name: 'Equivalent Ball', material: 'pbr', color: [0.2, 0.7, 1, 1],
    transform: { position: { x: 3, y: 2, z: 1 }, rotationDegrees: { x: 0, y: 45, z: 0 }, scale: { x: 1.5, y: 1.5, z: 1.5 } },
  };
  try {
    const agentResult = await executeReady(agent.runtime, call('call:equivalent-agent', 'entity.create', input));
    const manualScene = await manual.scene.createEntity({ commandId: asStableId('command:equivalent-manual'), ...input });
    const comparable = (entity) => ({ name: entity.name, kind: entity.kind, order: entity.order, transform: entity.transform, appearance: entity.appearance, light: entity.light });
    assert.deepEqual(comparable(agent.scene.snapshot().entities[0]), comparable(manualScene.entities[0]));
    assert.equal(agentResult.historyLabel, 'Create Scene Entity');
    assert.equal(agent.workspace.snapshot().document.revision, manual.workspace.snapshot().document.revision);
    assert.equal(agent.resources.history.canUndo, true);
    assert.equal(manual.resources.history.canUndo, true);
    await agent.workspace.undo(2); await manual.workspace.undo(2);
    assert.equal(agent.scene.snapshot().entities.length, 0);
    assert.equal(manual.scene.snapshot().entities.length, 0);
  } finally { await dispose(agent); await dispose(manual); }
});

test('schema spoof, rejection and revision drift fail closed without mutation', async () => {
  const value = await fixture();
  try {
    await assert.rejects(value.runtime.prepare(call('call:bad', 'entity.create', { baseRevision: 1, kind: 'cube', shell: 'whoami' })), /unknown fields: shell/);
    await assert.rejects(value.runtime.prepare({ ...call('call:version', 'entity.create', { baseRevision: 1, kind: 'cube' }), toolVersion: '2.0.0' }), /not registered/);
    const created = await executeReady(value.runtime, call('call:policy-target', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Policy Target' }));
    const entityId = created.value.entity.id;
    const rejected = await value.runtime.prepare(call('call:reject', 'entity.rename', { baseRevision: 2, entityId, name: 'Rejected' }));
    await value.runtime.decide(rejected.approvalId, 'reject');
    assert.equal((await value.runtime.execute(rejected.id)).status, 'rejected');
    assert.equal(value.workspace.snapshot().document.revision, 2);

    const stale = await value.runtime.prepare(call('call:stale', 'entity.rename', { baseRevision: 2, entityId, name: 'Stale' }));
    await value.runtime.decide(stale.approvalId, 'allow-once');
    await value.workspace.execute({ id: asStableId('command:drift'), label: 'Drift', baseRevision: 2, key: 'fixture.drift', value: true });
    await assert.rejects(value.runtime.execute(stale.id), /Document changed/);
    assert.equal(value.scene.snapshot().entities[0].name, 'Policy Target');

    const cancelled = await value.runtime.prepare(call('call:cancel-ready', 'project.snapshot', {}));
    await value.runtime.cancel(asStableId('call:cancel-ready'));
    assert.equal((await value.runtime.execute(cancelled.id)).status, 'cancelled');
  } finally { await dispose(value); }
});

test('schema fuzz rejects duplicate, nested unknown, non-finite and malformed structured fields before mutation', async () => {
  const value = await fixture();
  try {
    const transform = { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const cases = [
      call('call:fuzz-nested', 'entity.create', { kind: 'cube', transform: { ...transform, position: { ...transform.position, w: 1 } } }),
      call('call:fuzz-infinite', 'entity.create', { kind: 'cube', transform: { ...transform, position: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 } } }),
      call('call:fuzz-capability-duplicate', 'script.propose', { entityId: 'entity:fixture', text: 'return;', capabilities: ['read', 'read'] }),
      call('call:fuzz-kind-format', 'diagnostics.query', { limit: 10, traverseCorrelation: false, kinds: ['INVALID KIND'] }),
      { ...call('call:fuzz-envelope', 'project.snapshot', {}), effect: 'trusted-code' },
    ];
    for (const candidate of cases) await assert.rejects(value.runtime.prepare(candidate), /invalid|unknown fields|non-finite/i);
    assert.equal(value.workspace.snapshot().document.revision, 1);
    const facts = await value.operationLog.query({ toolCallId: asStableId('call:fuzz-kind-format'), limit: 20, traverseCorrelation: false });
    assert.deepEqual(facts.events.filter((item) => item.kind.startsWith('tool/')).map((item) => item.kind), ['tool/call-received', 'tool/preparation-failed']);
  } finally { await dispose(value); }
});

test('same-document mutations serialize and a queued stale preparation never enters the editor service', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-serialized', 'entity.create', { kind: 'cube', name: 'Before' }));
    const entityId = created.value.entity.id;
    const first = await value.runtime.prepare(call('call:serialize-first', 'entity.rename', { baseRevision: 2, entityId, name: 'First' }));
    const second = await value.runtime.prepare(call('call:serialize-second', 'entity.rename', { baseRevision: 2, entityId, name: 'Second' }));
    await value.runtime.decide(first.approvalId, 'allow-once');
    await value.runtime.decide(second.approvalId, 'allow-once');
    const originalRename = value.scene.renameEntity.bind(value.scene);
    const entered = deferred(); const release = deferred(); let active = 0; let maximum = 0; let calls = 0;
    value.scene.renameEntity = async (...args) => { calls += 1; active += 1; maximum = Math.max(maximum, active); entered.resolve(); await release.promise; try { return await originalRename(...args); } finally { active -= 1; } };
    const firstExecution = value.runtime.execute(first.id);
    await entered.promise;
    const secondExecution = value.runtime.execute(second.id);
    release.resolve();
    assert.equal((await firstExecution).status, 'completed');
    await assert.rejects(secondExecution, /Document changed/);
    assert.equal(maximum, 1);
    assert.equal(calls, 1);
    assert.equal(value.scene.snapshot().entities[0].name, 'First');
  } finally { await dispose(value); }
});

test('tool, approval, Document and History correlation remains traversable after the journal restarts', async () => {
  const value = await fixture(); let disposed = false; let reopened;
  try {
    const created = await executeReady(value.runtime, call('call:restart-create', 'entity.create', { kind: 'cube', name: 'Before Restart' }));
    const rename = await value.runtime.prepare(call('call:restart-rename', 'entity.rename', { baseRevision: 2, entityId: created.value.entity.id, name: 'After Restart' }));
    await value.runtime.decide(rename.approvalId, 'allow-once');
    await value.runtime.execute(rename.id);
    await dispose(value); disposed = true;

    reopened = await OperationLog.open({ rootDirectory: path.join(value.userDataRoot, 'log'), appVersion: 'test-reopen' });
    const page = await reopened.query({ toolCallId: asStableId('call:restart-rename'), limit: 200, traverseCorrelation: true });
    const kinds = page.events.map((item) => item.kind);
    assert.ok(kinds.includes('approval/allow-once'));
    assert.ok(kinds.includes('tool/execution-completed'));
    assert.ok(kinds.includes('document/command-requested'));
    assert.ok(kinds.includes('document/command-committed'));
    assert.ok(page.events.some((item) => item.kind === 'document/command-committed' && item.correlation.commandId));
  } finally {
    if (reopened) await reopened.close();
    if (!disposed) await dispose(value);
  }
});

test('cancelled calls reject a late result even when the injected runtime ignores AbortSignal', async () => {
  const value = await fixture();
  try {
    const entered = deferred(); const release = deferred();
    value.preview.stop = async () => { entered.resolve(); return await release.promise; };
    const prepared = await value.runtime.prepare(call('call:late-preview-stop', 'preview.stop', {}));
    const execution = value.runtime.execute(prepared.id);
    await entered.promise;
    await value.runtime.cancel(asStableId('call:late-preview-stop'));
    release.resolve({ instanceId: null, state: 'stopped', entityId: null, position: null, disposableCount: 0, errors: [] });
    await assert.rejects(execution, /cancelled/);
    const facts = await value.operationLog.query({ toolCallId: asStableId('call:late-preview-stop'), limit: 30, traverseCorrelation: false });
    assert.equal(facts.events.some((item) => item.kind === 'tool/execution-completed'), false);
    assert.ok(facts.events.some((item) => item.kind === 'tool/execution-failed'));
  } finally { await dispose(value); }
});

test('tool timeout aborts execution, emits a terminal failure and cannot produce a late completion', async () => {
  const value = await fixture({ timeoutCeilingMs: 25 });
  try {
    value.preview.stop = async (signal) => await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    const prepared = await value.runtime.prepare(call('call:timeout-preview-stop', 'preview.stop', {}));
    await assert.rejects(value.runtime.execute(prepared.id), (cause) => cause.code === 'tool.timeout');
    const facts = await value.operationLog.query({ toolCallId: asStableId('call:timeout-preview-stop'), limit: 30, traverseCorrelation: false });
    assert.equal(facts.events.some((item) => item.kind === 'tool/execution-completed'), false);
    assert.ok(facts.events.some((item) => item.kind === 'tool/execution-failed'));
  } finally { await dispose(value); }
});

test('observe tools degrade when journal append fails while every mutation remains fail closed', async () => {
  const value = await fixture();
  const append = value.operationLog.append.bind(value.operationLog);
  try {
    value.operationLog.append = async () => { throw new Error('fixture journal unavailable'); };
    const observed = await value.runtime.prepare(call('call:degraded-observe', 'project.snapshot', {}));
    const result = await value.runtime.execute(observed.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.afterRevision, 1);
    await assert.rejects(value.runtime.prepare(call('call:degraded-mutation', 'entity.create', { kind: 'cube' })), /Operation Log rejected/);
    assert.equal(value.workspace.snapshot().document.revision, 1);
  } finally { value.operationLog.append = append; await dispose(value); }
});

test('pending approvals have no wall-clock expiry while revision drift still invalidates them', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-expiry-target', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Before' }));
    const entityId = created.value.entity.id;
    const pending = await value.runtime.prepare(call('call:no-expiry', 'entity.rename', { baseRevision: 2, entityId, name: 'Still valid' }));
    assert.equal(pending.expiresAt, undefined);
    assert.equal(value.runtime.approval(pending.approvalId).expiresAt, undefined);
    value.time.value += 30 * 24 * 60 * 60_000;
    assert.equal((await value.runtime.decide(pending.approvalId, 'allow-once')).decision, 'allow-once');
    assert.equal((await value.runtime.execute(pending.id)).status, 'completed');
    assert.equal(value.scene.snapshot().entities[0].name, 'Still valid');

    const stale = await value.runtime.prepare(call('call:approval-stale', 'entity.rename', { baseRevision: 3, entityId, name: 'Must not apply' }));
    await value.workspace.execute({ id: asStableId('command:approval-drift'), label: 'Approval drift', baseRevision: 3, key: 'fixture.approval-drift', value: true });
    await assert.rejects(value.runtime.decide(stale.approvalId, 'allow-once'), /is stale/);
    assert.equal(value.runtime.approval(stale.approvalId).decision, 'stale');
    assert.equal((await value.runtime.execute(stale.id)).status, 'rejected');
    assert.equal(value.scene.snapshot().entities[0].name, 'Still valid');

    const facts = await value.operationLog.query({ toolCallId: asStableId('call:no-expiry'), limit: 30, traverseCorrelation: false });
    assert.equal(facts.events.some((item) => item.kind === 'approval/expired'), false);
  } finally { await dispose(value); }
});

test('fake backend deterministic E2E creates, transforms, scripts and starts preview through one tool seam', async () => {
  const value = await fixture();
  const approvals = [];
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request(preparation, approval) { approvals.push({ toolId: preparation.toolId, approvalId: approval.approvalId }); return 'allow-once'; } });
  const backend = scriptedBackend(movementScript);
  try {
    const summary = await coordinator.run(backend, { prompt: 'Create a moving cube and preview it.' });
    assert.equal(summary.terminal, 'completed');
    assert.deepEqual(summary.results.map((item) => item.toolId), ['entity.create', 'transform.set', 'script.propose', 'script.apply', 'preview.validate', 'preview.start', 'preview.stop']);
    assert.deepEqual(approvals.map((item) => item.toolId), ['transform.set', 'script.apply', 'preview.start']);
    assert.equal(value.scene.snapshot().entities[0].transform.position.x, 2);
    assert.equal(value.scripts.snapshot().resources.length, 1);
    assert.equal(value.preview.starts, 1);
    assert.equal(value.preview.stops, 1);
    assert.equal(value.workspace.snapshot().document.revision, 4);
  } finally { coordinator.dispose(); await dispose(value); }
});

test('coordinator recovers a validated script proposal after provider transport interruption through normal one-shot approval', async () => {
  const value = await fixture();
  const created = await executeReady(value.runtime, call('call:recovery-create', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Recovery Target' }));
  const approvals = [];
  const backend = minimalBackend(async function* () {
    yield event('tool-request', { toolCallId: 'toolcall:recovery-propose', toolId: 'script.propose', arguments: { baseRevision: created.afterRevision, entityId: created.value.entity.id, text: movementScript, capabilities: ['read', 'debug'] } });
    yield event('diagnostic', { code: 'TRANSPORT', message: 'fixture provider connection closed' });
  });
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, {
    async request(preparation) { approvals.push(preparation.toolId); return 'allow-once'; },
  });
  try {
    const summary = await coordinator.run(backend, { taskId: asStableId('task:recovery'), prompt: 'Create a script.' });
    assert.equal(summary.terminal, 'interrupted');
    assert.deepEqual(summary.results.map((item) => item.toolId), ['script.propose']);
    assert.equal(summary.results[0].value.canApply, true);
    assert.equal(value.scripts.snapshot().resources.length, 0);

    const recovered = await coordinator.recoverValidatedScriptProposal({
      taskId: asStableId('task:recovery'), sessionId: summary.sessionId, turnId: summary.turnId, results: summary.results,
    });
    assert.equal(recovered.result.toolId, 'script.apply');
    assert.equal(recovered.result.status, 'completed');
    assert.equal(recovered.sourceCallId, 'toolcall:recovery-propose');
    assert.deepEqual(approvals, ['script.apply']);
    assert.equal(value.scripts.snapshot().resources.length, 1);
    assert.equal(value.scripts.snapshot().resources[0].text, movementScript);

    const facts = await value.operationLog.query({ toolCallId: recovered.result.callId, limit: 100, traverseCorrelation: true });
    assert.ok(facts.events.some((item) => item.kind === 'approval/allow-once'));
    assert.ok(facts.events.some((item) => item.kind === 'document/command-committed'));
  } finally { coordinator.dispose(); await dispose(value); }
});

test('agent queries a pre-restart runtime fault and applies one approved repair through the bounded tool seam', async () => {
  const beforeRestart = await fixture(); let beforeDisposed = false; let afterRestart; let coordinator;
  try {
    const created = await executeReady(beforeRestart.runtime, call('call:repair-seed-create', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Broken Runner' }));
    const entityId = created.value.entity.id;
    const proposed = await executeReady(beforeRestart.runtime, call('call:repair-seed-propose', 'script.propose', {
      baseRevision: created.afterRevision, entityId, text: runtimeFailureScript, capabilities: ['read', 'debug'],
    }));
    const applied = await approveAndExecute(beforeRestart.runtime, call('call:repair-seed-apply', 'script.apply', {
      baseRevision: proposed.afterRevision, proposalId: proposed.value.proposalId,
    }));
    await beforeRestart.workspace.save();
    await beforeRestart.operationLog.append({
      kind: 'preview/runtime-error', severity: 'error', source: asStableId('studio.preview'),
      correlation: { entityId, scriptId: applied.value.scriptId, previewId: asStableId('preview:repair-fixture') },
      payload: { code: 'fixture.runtime-error', message: 'fixture runtime failure', source: runtimeFailureScript, line: 1, column: 1 },
    });
    const restartState = { projectRoot: beforeRestart.projectRoot, userDataRoot: beforeRestart.userDataRoot, time: beforeRestart.time };
    await dispose(beforeRestart); beforeDisposed = true;

    afterRestart = await fixture({}, restartState);
    const approvals = [];
    coordinator = new AgentGameAuthoringCoordinator(afterRestart.runtime, {
      async request(preparation) { approvals.push(preparation.toolId); return 'allow-once'; },
    });
    const summary = await coordinator.run(repairBackend(entityId, repairedRuntimeScript), { prompt: 'Inspect the prior preview failure and repair the script.' });

    assert.equal(summary.terminal, 'completed');
    assert.deepEqual(summary.results.map((item) => item.toolId), ['diagnostics.query', 'script.propose', 'script.apply']);
    assert.deepEqual(approvals, ['script.apply']);
    assert.equal(summary.results[0].value.count, 1);
    assert.equal(summary.results[0].value.events[0].kind, 'preview/runtime-error');
    assert.equal(summary.results[0].value.events[0].correlation.entityId, entityId);
    assert.equal(afterRestart.scripts.snapshot().resources[0].text, repairedRuntimeScript);
    assert.equal(afterRestart.workspace.snapshot().document.revision, 4);

    const repairFacts = await afterRestart.operationLog.query({ toolCallId: asStableId('toolcall:repair-apply'), limit: 100, traverseCorrelation: true });
    assert.ok(repairFacts.events.some((item) => item.kind === 'approval/allow-once'));
    assert.ok(repairFacts.events.some((item) => item.kind === 'document/command-committed'));
  } finally {
    if (coordinator) coordinator.dispose();
    if (afterRestart) await dispose(afterRestart);
    if (!beforeDisposed) await dispose(beforeRestart);
  }
});

test('coordinator rejects malformed provider arguments instead of coercing them to an empty observe call', async () => {
  const value = await fixture(); let submitted;
  const backend = minimalBackend(async function* () {
    yield event('tool-request', { toolCallId: 'toolcall:malformed', toolId: 'project.snapshot', arguments: [] });
    yield event('completed', { status: 'completed' });
  }, async (_id, result) => { submitted = result; });
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } });
  try {
    const summary = await coordinator.run(backend, { prompt: 'Malformed fixture.' });
    assert.equal(summary.terminal, 'completed');
    assert.equal(summary.results.length, 0);
    assert.equal(summary.diagnostics[0].code, 'tool.arguments-invalid');
    assert.equal(submitted.status, 'failed');
  } finally { coordinator.dispose(); await dispose(value); }
});

test('coordinator can route backend turns and tool output accounting through AgentTurnRuntime', async () => {
  const value = await fixture(); const calls = []; let submissions = 0;
  const backend = minimalBackend(async function* () {
    yield event('tool-request', { toolCallId: 'toolcall:accounted-snapshot', toolId: 'project.snapshot', arguments: {} });
    yield event('completed', { status: 'completed' });
  }, async () => { submissions += 1; });
  const turns = {
    start(backendId, input, signal) { calls.push({ kind: 'start', backendId, toolCount: input.tools.length }); return backend.startTurn(input, signal); },
    async recordToolResult(turnId, toolCallId, result) { calls.push({ kind: 'result', turnId, toolCallId, status: result.status }); throw new Error('accounting sink unavailable'); },
  };
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } }, turns);
  try {
    const summary = await coordinator.run(backend, { prompt: 'Inspect the project.' });
    assert.equal(summary.terminal, 'completed');
    assert.equal(summary.results.length, 1);
    assert.deepEqual(calls.map((entry) => entry.kind), ['start', 'result']);
    assert.equal(calls[0].backendId, backend.descriptor.id);
    assert.ok(calls[0].toolCount > 10);
    assert.equal(calls[1].toolCallId, 'toolcall:accounted-snapshot');
    assert.equal(calls[1].status, 'completed');
    assert.equal(submissions, 1, 'accounting failure must not submit a second contradictory tool result');
    assert.equal(summary.diagnostics.at(-1).code, 'accounting.tool-result-failed');
  } finally { coordinator.dispose(); await dispose(value); }
});

test('coordinator can expose a bounded tool profile and compact only the provider-facing result', async () => {
  const value = await fixture(); let submitted; let visibleTools;
  const backend = minimalBackend(async function* (input) {
    visibleTools = input.tools.map((entry) => entry.id);
    yield event('tool-request', { toolCallId: 'toolcall:compact-capabilities', toolId: 'engine.capabilities.describe', arguments: {} });
    yield event('completed', { status: 'completed' });
  }, async (_id, result) => { submitted = result; });
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } }, undefined, {
    modelToolIds: ['project.snapshot', 'engine.capabilities.describe'], maxModelToolResultBytes: 512,
  });
  try {
    const summary = await coordinator.run(backend, { prompt: 'Inspect capabilities.' });
    assert.deepEqual(visibleTools, ['project.snapshot', 'engine.capabilities.describe']);
    assert.equal(submitted.value.truncated, true);
    assert.match(submitted.value.originalDigest, /^sha256:/u);
    assert.ok(summary.results[0].value.components.length > 1, 'full evidence remains available to Studio');
  } finally { coordinator.dispose(); await dispose(value); }
});

test('coordinator automatically takes over backend questions through an explicit policy', async () => {
  const value = await fixture(); const answered = deferred(); let submittedAnswer;
  const backend = minimalBackend(async function* () {
    yield event('question', { nodeId: 'question:auto', questions: [{ id: 'choice', options: [{ label: 'Safe' }] }], isBlocking: true });
    await answered.promise;
    yield event('completed', { status: 'completed' });
  });
  backend.answerQuestion = async (nodeId, answer) => { submittedAnswer = { nodeId, answer }; answered.resolve(); };
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } }, undefined, {
    questionTakeover: { async answer() { return { choice: { answers: ['Safe'] } }; } },
  });
  try {
    const summary = await coordinator.run(backend, { prompt: 'Use safe defaults.' });
    assert.equal(summary.terminal, 'completed');
    assert.deepEqual(submittedAnswer, { nodeId: 'question:auto', answer: { choice: { answers: ['Safe'] } } });
    assert.ok(summary.diagnostics.some((item) => item.code === 'agent.question-auto-answered'));
  } finally { coordinator.dispose(); await dispose(value); }
});

test('coordinator cancels a non-converging turn at its tool request boundary', async () => {
  const value = await fixture(); let cancelled = 0;
  const backend = minimalBackend(async function* () {
    yield event('tool-request', { toolCallId: 'toolcall:bounded-1', toolId: 'project.snapshot', arguments: {} });
    yield event('tool-request', { toolCallId: 'toolcall:bounded-2', toolId: 'scene.list-entities', arguments: {} });
    yield event('tool-request', { toolCallId: 'toolcall:bounded-3', toolId: 'camera.get', arguments: {} });
    yield event('completed', { status: 'completed' });
  });
  backend.cancelTurn = async () => { cancelled += 1; };
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } }, undefined, { maxToolRequests: 2 });
  try {
    const summary = await coordinator.run(backend, { prompt: 'Inspect with a bounded turn.' });
    assert.equal(summary.terminal, 'failed');
    assert.equal(summary.results.length, 2);
    assert.equal(cancelled, 1);
    assert.ok(summary.diagnostics.some((item) => item.code === 'agent.tool-call-budget-exceeded'));
  } finally { coordinator.dispose(); await dispose(value); }
});

test('coordinator preserves completed tool results when the host budget observer blocks the next request', async () => {
  const value = await fixture(); let cancelled = 0;
  const backend = minimalBackend(async function* () {
    yield event('tool-request', { toolCallId: 'toolcall:budget-preserved', toolId: 'project.snapshot', arguments: {} });
    yield event('tool-request', { toolCallId: 'toolcall:budget-blocked', toolId: 'scene.list-entities', arguments: {} });
    yield event('completed', { status: 'completed' });
  });
  backend.cancelTurn = async () => { cancelled += 1; };
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } });
  try {
    const summary = await coordinator.run(backend, { prompt: 'Preserve work at the host budget boundary.' }, (backendEvent) => {
      if (backendEvent.kind === 'tool-request' && backendEvent.payload.toolCallId === 'toolcall:budget-blocked') {
        const cause = new Error('Formal cap reached before the next tool effect.');
        cause.code = 'budget.formal-cap';
        throw cause;
      }
    });
    assert.equal(summary.terminal, 'failed');
    assert.deepEqual(summary.results.map((item) => item.toolId), ['project.snapshot']);
    assert.equal(cancelled, 1);
    assert.ok(summary.diagnostics.some((item) => item.code === 'budget.formal-cap'));
  } finally { coordinator.dispose(); await dispose(value); }
});

test('disposing the coordinator aborts an active backend turn and is idempotent', async () => {
  const value = await fixture(); const entered = deferred();
  const backend = minimalBackend(async function* (_input, signal) {
    entered.resolve();
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    yield event('completed', { status: 'completed' });
  });
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } });
  try {
    const running = coordinator.run(backend, { prompt: 'Wait for disposal.' });
    await entered.promise;
    coordinator.dispose(); coordinator.dispose();
    await assert.rejects(running, /disposed/);
  } finally { coordinator.dispose(); await dispose(value); }
});

async function fixture(runtimeOptions = {}, restartState = null) {
  const projectRoot = restartState?.projectRoot ?? await mkdtemp(path.join(tmpdir(), 'haiyue-tools-project-'));
  const userDataRoot = restartState?.userDataRoot ?? await mkdtemp(path.join(tmpdir(), 'haiyue-tools-userdata-'));
  const time = restartState?.time ?? { value: 1_000 };
  const operationLog = await OperationLog.open({ rootDirectory: path.join(userDataRoot, 'log'), appVersion: 'test', clock: () => new Date(time.value), eventId: (sequence) => asStableId(`event:tools:${sequence}`) });
  const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(userDataRoot) };
  const workspace = new ProjectWorkspace(resources);
  if (restartState) await workspace.openProject(projectRoot); else await workspace.newProject(projectRoot, 'Tool fixture');
  const scene = new ProjectSceneAuthoringService(workspace, operationLog);
  const validator = new ScriptValidationWorker();
  const projectScripts = new ProjectScriptService(workspace, validator, operationLog);
  const authorization = new PreviewAuthorizationService(projectScripts, validator, operationLog, () => time.value);
  const scripts = {
    snapshot: () => projectScripts.snapshot(), proposeEdit: (input) => projectScripts.proposeEdit(input),
    commitProposal: (proposalId, commandId, signal) => projectScripts.commitProposal(proposalId, commandId, signal),
    prepare: (input) => authorization.prepare(input),
    decide: (planId, approved, ttl) => authorization.decide(planId, approved, ttl), consume: (grantId) => authorization.consume(grantId),
  };
  const preview = {
    starts: 0, stops: 0, state: { instanceId: null, state: 'stopped', scriptSetDigest: null, scriptCount: 0, scripts: [], entityId: null, position: null, disposableCount: 0, errors: [] },
    async start(scene, plan) { assert.ok(scene.entities.some((entity) => entity.kind === 'cube')); this.starts += 1; this.state = { ...this.state, instanceId: 'preview:fixture', state: 'playing', scriptSetDigest: plan.scriptSetDigest, scriptCount: plan.scripts.length, scripts: plan.scripts.map((script) => ({ scriptId: script.scriptId, entityId: script.entityId, order: script.order, state: 'playing', position: null, disposableCount: 0, errorCount: 0 })), entityId: plan.scripts[0]?.entityId ?? null }; return this.state; },
    async stop() { this.stops += 1; this.state = { ...this.state, state: 'stopped', instanceId: null, entityId: null }; return this.state; },
    async step(count) { return this.observation({ stepped: count }); }, async input(event) { return this.observation({ input: event }); }, async physicsQuery(query) { return this.observation({ query: { kind: query.kind, result: query.kind === 'raycast' ? { entityId: 'entity:ground', distance: 2 } : null } }); }, async inspect() { return this.observation({ score: 4 }); },
    async capture() { const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); return { ...this.observation({}), mediaType: 'image/png', byteLength: png.length, base64: png.toString('base64') }; },
    observation(value) { return { playId: 'preview:fixture', documentRevision: 3, scriptDigests: [`sha256:${'a'.repeat(64)}`], tick: 12, frame: 9, viewport: { width: 393, height: 852 }, device: 'fixture', capturedAt: '2026-08-29T00:00:00.000Z', value }; },
    snapshot() { return this.state; },
  };
  const runtime = new GameAuthoringToolRuntime({ workspace, scene, scripts, diagnostics: operationLog.diagnosticsService(), operationLog, preview, ...runtimeOptions });
  return { projectRoot, userDataRoot, time, operationLog, resources, workspace, scene, validator, projectScripts, scripts, preview, runtime };
}

function call(id, toolId, args) { return { schemaVersion: 1, id, sessionId: 'session:fixture', turnId: 'turn:fixture', toolId, toolVersion: '1.0.0', arguments: args }; }
async function approveAndExecute(runtime, value) { const prepared = await runtime.prepare(value); if (prepared.approvalId) await runtime.decide(prepared.approvalId, 'allow-once'); return runtime.execute(prepared.id); }
async function executeReady(runtime, value) { const prepared = await runtime.prepare(value); assert.equal(prepared.status, 'ready'); return runtime.execute(prepared.id); }
async function dispose(value) { value.runtime.dispose(); value.scene.dispose(); value.projectScripts.dispose(); await value.validator.dispose(); await value.workspace.dispose(); value.resources.tasks.dispose(); await value.resources.documents.dispose(); value.resources.history.dispose(); value.resources.projectSession.dispose(); await value.operationLog.close(); }

function scriptedBackend(script) {
  let pending;
  const backendId = 'backend:fake-tools'; const sessionId = 'session:fake-tools'; const turnId = 'turn:fake-tools';
  return {
    descriptor: { schemaVersion: 1, id: backendId, kind: 'harness-api-key', protocolVersion: 'fake', capabilities: { resume: false, questions: false, structuredTools: true, backendApprovals: false, usage: false, rateLimits: false } },
    async *startTurn(input) {
      assert.equal(input.tools.length, 47);
      yield event('status', { status: 'running' });
      let result = yield* request('toolcall:create', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Agent Cube' });
      const entityId = result.value.entity.id;
      result = yield* request('toolcall:transform', 'transform.set', { baseRevision: result.afterRevision, entityId, transform: { position: { x: 2, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 30, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
      result = yield* request('toolcall:propose', 'script.propose', { baseRevision: result.afterRevision, entityId, text: script, capabilities: ['read', 'debug'] });
      result = yield* request('toolcall:apply', 'script.apply', { baseRevision: result.afterRevision, proposalId: result.value.proposalId });
      result = yield* request('toolcall:validate', 'preview.validate', {});
      result = yield* request('toolcall:start', 'preview.start', { baseRevision: result.afterRevision, planId: result.value.planId });
      yield* request('toolcall:stop', 'preview.stop', {});
      yield event('completed', { status: 'completed' });
    },
    async submitToolResult(id, result) { assert.equal(pending?.id, id); pending.resolve(result); pending = undefined; },
    async authenticate() { return null; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async logout() {},
    resumeTurn() { throw new Error('unused'); }, async answerQuestion() {}, async resolveBackendApproval() {}, async cancelTurn() {}, async dispose() {},
  };
  function event(kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
  async function* request(id, toolId, args) { const result = deferred(); pending = { id, resolve: result.resolve }; yield event('tool-request', { toolCallId: id, toolId, arguments: args }); return await result.promise; }
}
function repairBackend(entityId, repairedScript) {
  let pending;
  const backendId = 'backend:fake-repair'; const sessionId = 'session:fake-repair'; const turnId = 'turn:fake-repair';
  return {
    descriptor: { schemaVersion: 1, id: backendId, kind: 'harness-api-key', protocolVersion: 'fake', capabilities: { resume: false, questions: false, structuredTools: true, backendApprovals: false, usage: false, rateLimits: false } },
    async *startTurn(input) {
      assert.equal(input.tools.length, 47);
      let result = yield* request('toolcall:repair-diagnostics', 'diagnostics.query', { kinds: ['preview/runtime-error'], limit: 10, traverseCorrelation: false });
      assert.equal(result.value.count, 1);
      assert.equal(result.value.events[0].kind, 'preview/runtime-error');
      assert.equal(result.value.events[0].correlation.entityId, entityId);
      result = yield* request('toolcall:repair-propose', 'script.propose', { baseRevision: result.afterRevision, entityId, text: repairedScript, capabilities: ['read', 'debug'] });
      yield* request('toolcall:repair-apply', 'script.apply', { baseRevision: result.afterRevision, proposalId: result.value.proposalId });
      yield backendEvent('completed', { status: 'completed' });
    },
    async submitToolResult(id, result) { assert.equal(pending?.id, id); pending.resolve(result); pending = undefined; },
    async authenticate() { return null; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async logout() {},
    resumeTurn() { throw new Error('unused'); }, async answerQuestion() {}, async resolveBackendApproval() {}, async cancelTurn() {}, async dispose() {},
  };
  function backendEvent(kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
  async function* request(id, toolId, args) { const result = deferred(); pending = { id, resolve: result.resolve }; yield backendEvent('tool-request', { toolCallId: id, toolId, arguments: args }); return await result.promise; }
}
function minimalBackend(startTurn, submitToolResult = async () => {}) {
  return {
    descriptor: { schemaVersion: 1, id: 'backend:minimal-tools', kind: 'harness-api-key', protocolVersion: 'fake', capabilities: { resume: false, questions: false, structuredTools: true, backendApprovals: false, usage: false, rateLimits: false } },
    startTurn, submitToolResult,
    async authenticate() { return null; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async logout() {},
    resumeTurn() { throw new Error('unused'); }, async answerQuestion() {}, async resolveBackendApproval() {}, async cancelTurn() {}, async dispose() {},
  };
}
function event(kind, payload) { return { schemaVersion: 1, backendId: 'backend:minimal-tools', sessionId: 'session:minimal-tools', turnId: 'turn:minimal-tools', kind, payload }; }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function pngHeader(width, height) { const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); const view = new DataView(bytes.buffer); view.setUint32(16, width, false); view.setUint32(20, height, false); return bytes; }
