import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneContextError, SceneContextRuntime } from '../dist/index.js';

test('0/1/1000 entity and 200 script queries are bounded, paged and never expose script source', () => {
  for (const entityCount of [0, 1, 1_000]) {
    const runtime = new SceneContextRuntime(); const snapshot = fixtureDocument(1, entityCount, entityCount === 1_000 ? 200 : 0); runtime.reset(snapshot);
    const first = runtime.query({ projection: ['hierarchy', 'scripts'], limit: 73 });
    assert.equal(first.revision, 1); assert.ok(first.items.length <= 73); assert.equal(first.totalItems, entityCount + (entityCount === 1_000 ? 200 : 0));
    const collected = [...first.items]; let cursor = first.nextCursor;
    while (cursor) { const page = runtime.query({ projection: ['hierarchy', 'scripts'], limit: 73, cursor }); collected.push(...page.items); cursor = page.nextCursor; }
    assert.equal(collected.length, first.totalItems);
    for (const item of collected.filter((entry) => entry.kind === 'script')) { assert.equal(Object.hasOwn(item.value, 'source'), false); assert.match(item.value.digest, /^sha256:/u); }
  }
});

test('add, remove, reparent, reorder, component patch, script, asset, camera and render changes retain provenance', () => {
  const runtime = new SceneContextRuntime(); const base = fixtureDocument(4, 3, 1); runtime.reset(base);
  base.assets.push({ id: 'asset:111111111111111111111111', kind: 'texture', digest: digest('existing-asset'), source: 'project' }); runtime.reset(base);
  const target = structuredClone(base); target.revision = 5;
  target.entities[1] = { ...target.entities[1], parentId: target.entities[0].id, order: 7, name: 'Reparented' };
  target.entities.splice(2, 1); target.components.splice(2, 1);
  target.entities.push(entity(99)); target.components.push(component(99, { position: { x: 9, y: 0, z: 0 } }));
  const cameraComponent = { id: 'component:camera:g05', type: 'haiyue.camera.3d', version: '1.0.0', enabled: true, value: { projection: 'perspective', fovDegrees: 60 } }; target.components.push(cameraComponent);
  target.entities.at(-1).componentIds = [target.components.at(-2).id, cameraComponent.id]; target.scenes[0].rootEntityIds = target.entities.filter((entry) => entry.parentId === null).map((entry) => entry.id);
  target.components[0] = { ...target.components[0], value: { position: { x: 3, y: 2, z: 1 }, textureAssetId: base.assets[0].id } };
  target.scripts[0] = { ...target.scripts[0], source: 'changed source', digest: digest('changed source'), textRevision: 2 };
  target.assets.push({ id: 'asset:222222222222222222222222', kind: 'texture', digest: digest('asset'), source: 'project' });
  target.settings['studio.camera.main'] = { projection: 'orthographic', distance: 20 };
  target.settings['studio.render.profile'] = { postprocess: true };
  const operations = [
    { op: 'entity.update', entityId: base.entities[1].id, patch: { parentId: base.entities[0].id, order: 7, name: 'Reparented' } },
    { op: 'component.remove', entityId: base.entities[2].id, componentId: base.components[2].id }, { op: 'entity.remove', entityId: base.entities[2].id },
    { op: 'entity.add', entity: { ...target.entities.at(-1), componentIds: [] } }, { op: 'component.add', entityId: target.entities.at(-1).id, component: target.components.at(-2) }, { op: 'component.add', entityId: target.entities.at(-1).id, component: cameraComponent },
    { op: 'component.replace', component: target.components[0] }, { op: 'script.upsert', script: target.scripts[0] }, { op: 'asset.upsert', asset: target.assets.at(-1) },
    { op: 'setting.set', key: 'studio.camera.main', value: target.settings['studio.camera.main'] }, { op: 'setting.set', key: 'studio.render.profile', value: target.settings['studio.render.profile'] },
  ];
  runtime.record({ delta: delta(base, target, operations, 'transaction:g05-all'), target, provenanceOpIds: ['event:g05-command'] });
  const result = runtime.diff({ fromRevision: 4, toRevision: 5, limit: 1_000 }); const value = result.diff;
  assert.deepEqual(value.transactionIds, ['transaction:g05-all']); assert.deepEqual(value.provenanceOpIds, ['event:g05-command']);
  assert.deepEqual(value.addedEntityIds, ['entity:0099']); assert.deepEqual(value.removedEntityIds, ['entity:0002']);
  assert.ok(value.changedEntities.some((entry) => entry.entityId === 'entity:0001' && entry.paths.includes('parentId') && entry.paths.includes('order')));
  assert.deepEqual(value.reorderedEntityIds, ['entity:0001']); assert.ok(value.componentPatches.some((entry) => entry.componentId === 'component:0000' && entry.paths.includes('value.position.x')));
  assert.deepEqual(value.scriptChanges.map((entry) => entry.change), ['updated']); assert.deepEqual(Object.fromEntries(value.assetChanges.map((entry) => [entry.assetId, entry.change])), { 'asset:111111111111111111111111': 'updated', 'asset:222222222222222222222222': 'added' });
  assert.ok(value.cameraChanges.some((entry) => entry.cameraId === 'camera:main' && entry.change === 'added')); assert.ok(value.cameraChanges.some((entry) => entry.cameraId === cameraComponent.id && entry.change === 'added'));
  assert.equal(value.renderChanges[0].change, 'added'); assert.ok(value.tombstoneIds.includes('entity:0002'));
  const authoritative = new SceneContextRuntime(); authoritative.reset(target);
  assert.equal(result.targetSnapshotDigest, authoritative.query({ revision: 5, projection: ['hierarchy'], limit: 1_000 }).snapshotDigest);
});

test('cursor integrity, stale query shape, future revision and pruned history fail with recoverable diagnostics', () => {
  const runtime = new SceneContextRuntime(1); const v1 = fixtureDocument(1, 2, 0); runtime.reset(v1);
  const v2 = rename(v1, 2, 0, 'two'); runtime.record({ delta: delta(v1, v2, [{ op: 'entity.update', entityId: v1.entities[0].id, patch: { name: 'two' } }], 'transaction:g05-v2'), target: v2 });
  const page = runtime.query({ projection: ['hierarchy'], limit: 1 }); assert.ok(page.nextCursor);
  assert.throws(() => runtime.query({ projection: ['components'], limit: 1, cursor: page.nextCursor }), (error) => error instanceof SceneContextError && error.code === 'scene.cursor-stale' && error.recoverable);
  assert.throws(() => runtime.query({ projection: ['hierarchy'], limit: 1, cursor: `${page.nextCursor}tampered` }), (error) => error instanceof SceneContextError && error.code === 'scene.cursor-invalid' && error.recoverable);
  const v3 = rename(v2, 3, 1, 'three'); runtime.record({ delta: delta(v2, v3, [{ op: 'entity.update', entityId: v2.entities[1].id, patch: { name: 'three' } }], 'transaction:g05-v3'), target: v3 });
  assert.equal(runtime.retainedFromRevision(), 2);
  assert.throws(() => runtime.diff({ fromRevision: 1 }), (error) => error instanceof SceneContextError && error.code === 'scene.history-pruned' && error.recoverable);
  assert.throws(() => runtime.query({ revision: 4 }), (error) => error instanceof SceneContextError && error.code === 'scene.revision-future' && error.recoverable);

  const gapped = new SceneContextRuntime(); const gapBase = fixtureDocument(10, 1, 0); gapped.reset(gapBase);
  const gapTarget = rename(gapBase, 12, 0, 'twelve');
  gapped.record({ delta: delta(gapBase, gapTarget, [{ op: 'entity.update', entityId: gapBase.entities[0].id, patch: { name: 'twelve' } }], 'transaction:g05-gap'), target: gapTarget });
  assert.throws(() => gapped.query({ revision: 11 }), (error) => error instanceof SceneContextError && error.code === 'scene.revision-gap' && error.recoverable);

  const divergent = new SceneContextRuntime(); const divergentBase = fixtureDocument(20, 1, 0); divergent.reset(divergentBase);
  const authoritativeTarget = rename(divergentBase, 21, 0, 'authoritative');
  divergent.record({ delta: delta(divergentBase, authoritativeTarget, [{ op: 'entity.update', entityId: divergentBase.entities[0].id, patch: { name: 'divergent' } }], 'transaction:g05-divergent'), target: authoritativeTarget });
  assert.equal(divergent.query({ revision: 21, projection: ['hierarchy'] }).items[0].value.name, 'authoritative');
  assert.throws(() => divergent.diff({ fromRevision: 20 }), (error) => error instanceof SceneContextError && error.code === 'scene.history-pruned' && error.recoverable);
});

function fixtureDocument(revision, entityCount, scriptCount) {
  const entities = Array.from({ length: entityCount }, (_, index) => entity(index));
  const components = Array.from({ length: entityCount }, (_, index) => component(index, { position: { x: index, y: 0, z: 0 } }));
  for (let index = 0; index < entityCount; index += 1) entities[index].componentIds = [components[index].id];
  const scripts = Array.from({ length: scriptCount }, (_, index) => ({ id: `script:${String(index).padStart(4, '0')}`, entityId: entities[index % Math.max(1, entities.length)]?.id ?? 'entity:missing', name: `Script ${index}`, sourcePath: `scripts/${index}.ts`, source: `secret source ${index}`, textRevision: 1, enabled: true, order: index, capabilities: ['read'], digest: digest(`secret source ${index}`) }));
  return { schemaVersion: 2, id: 'document:g05', revision, savedRevision: revision, scenes: [{ id: 'scene:main', name: 'Main', rootEntityIds: entities.map((entry) => entry.id) }], entities, components, scripts, assets: [], settings: {}, migration: { fromVersion: null, migratedAt: null, sourceDigest: null } };
}
function entity(index) { return { id: `entity:${String(index).padStart(4, '0')}`, sceneId: 'scene:main', name: `Entity ${index}`, parentId: null, order: index, componentIds: [] }; }
function component(index, value) { return { id: `component:${String(index).padStart(4, '0')}`, type: 'haiyue.transform.3d', version: '1.0.0', enabled: true, value }; }
function rename(source, revision, index, name) { const target = structuredClone(source); target.revision = revision; target.entities[index] = { ...target.entities[index], name }; return target; }
function delta(before, after, operations, transactionId) { return { schemaVersion: 2, transactionId, documentId: before.id, beforeRevision: before.revision, afterRevision: after.revision, operations, inverse: [], metrics: { copiedBytes: 1, historyBytes: 1, projectionWork: operations.length, durationMicros: 1 } }; }
function digest(value) { return `sha256:${value.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/gu, 'a')}`; }
