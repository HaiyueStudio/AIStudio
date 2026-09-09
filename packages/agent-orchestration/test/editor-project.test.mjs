import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectEditorController } from '../dist/index.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  let identity = { projectId: 'project:a', documentId: 'document:a', revision: 1, selectionRevision: 1, storageKey: '/a' }, sequence = 0;
  const calls = [], prepared = deferred(), approvalStarted = deferred();
  const source = epoch => ({ epoch, document: { id: identity.documentId, revision: identity.revision, entities: [{ id: 'entity:a', componentIds: ['component:a'], parentId: null, order: 0, name: 'A' }], components: [] }, definitions: [],
    selection: { revision: identity.selectionRevision, active: { kind: 'scene-entity', id: 'entity:a', documentId: identity.documentId }, items: [] }, history: { busy: false, canUndo: true, canRedo: false }, projection: null, playId: null, observation: null, observationValue: null, observationEpoch: null, observationDocumentId: null });
  const port = {
    current: () => identity, nextId: () => `id-${++sequence}`, advancedSource: source,
    select: async id => calls.push(['select', id]), history: async () => calls.push(['history']),
    tools: {
      prepare: async call => { calls.push(['prepare', call]); prepared.resolve(); return { id: 'preparation:a', approvalId: 'approval:a', documentId: identity.documentId, baseRevision: identity.revision }; },
      approval: () => ({ approvalId: 'approval:a' }), decide: async (...args) => calls.push(['decide', ...args]),
      execute: async id => { calls.push(['execute', id]); identity = { ...identity, revision: identity.revision + 1 }; return { status: 'completed', value: { saved: true } }; },
      cancel: async id => calls.push(['cancel', id]),
    },
    approve: async () => { approvalStarted.resolve(); return 'allow-once'; },
    resources: async () => ({
      query: async () => ({ binding: { digest: 'binding:a' }, data: { state: 'ready', total: 0, items: [], target: null, diagnostics: [], categories: [], nextCursor: null } }),
      execute: async input => { calls.push(['resource.execute', input]); return { kind: 'workflow' }; },
      importAsset: async input => { calls.push(['import', input]); return { kind: 'workflow' }; }, locateUsage: input => input,
      cancel: () => calls.push(['resource.cancel']), dispose: () => calls.push(['resource.dispose']),
    }), ...overrides,
  };
  const controller = new ProjectEditorController(port);
  const intent = () => ({ type: 'author', stamp: { epoch: controller.snapshotAdvanced().epoch, documentId: identity.documentId, baseRevision: identity.revision, selectionRevision: identity.selectionRevision }, toolId: 'entity.rename', arguments: { baseRevision: identity.revision, entityId: 'entity:a', name: 'Renamed' } });
  return { controller, port, calls, prepared, approvalStarted, intent, change: patch => { identity = { ...identity, ...patch }; controller.syncProject(); } };
}
test('manual authoring uses the existing prepare / exact approval / execute path', async () => {
  const f = fixture();
  try { assert.deepEqual(await f.controller.dispatchAdvanced(f.intent()), { saved: true }); assert.deepEqual(f.calls.map(c => c[0]), ['prepare', 'decide', 'execute']); }
  finally { f.controller.dispose(); }
});
test('revision and selection changes while awaiting approval prevent both decision and commit', async () => {
  for (const change of [{ revision: 2 }, { selectionRevision: 2 }]) {
    const pending = deferred(), started = deferred(), f = fixture({ approve: async () => { started.resolve(); return pending.promise; } });
    const task = f.controller.dispatchAdvanced(f.intent()); await started.promise; f.change(change); pending.resolve('allow-once');
    await assert.rejects(task, /stale/); assert.equal(f.calls.some(c => c[0] === 'execute' || c[0] === 'decide'), false); assert.ok(f.calls.some(c => c[0] === 'cancel')); f.controller.dispose();
  }
});
test('reopening an identical project invalidates old advanced stamps and resource tokens', async () => {
  const f = fixture(), intent = f.intent(), page = await f.controller.queryResources(); f.controller.replaceProject();
  await assert.rejects(f.controller.dispatchAdvanced(intent), /stale/);
  await assert.rejects(f.controller.importResource(page.viewToken, {}), /stale/);
  assert.equal(f.calls.filter(c => c[0] === 'resource.dispose').length, 1); f.controller.dispose();
});
test('cancelling or switching project during an approval never commits a late allow', async () => {
  for (const action of ['cancel', 'replaceProject', 'dispose']) {
    const pending = deferred(), started = deferred(), f = fixture({ approve: async () => { started.resolve(); return pending.promise; } });
    const task = f.controller.dispatchAdvanced(f.intent()); await started.promise; f.controller[action](); pending.resolve('allow-once'); await assert.rejects(task);
    assert.equal(f.calls.some(c => c[0] === 'execute' || c[0] === 'decide'), false); f.controller.dispose();
  }
});
test('normalized intents cannot choose a foreign selected entity, tool or stamp extension', async () => {
  const f = fixture();
  for (const edit of [i => { i.arguments.entityId = 'entity:foreign'; }, i => { i.toolId = 'asset.import'; }, i => { i.stamp.schemaVersion = 2; }, i => { i.arguments.baseRevision = 0; }]) {
    const intent = f.intent(); edit(intent); await assert.rejects(f.controller.dispatchAdvanced(intent));
  }
  assert.equal(f.calls.length, 0); f.controller.dispose();
});
test('resource actions accept only the current opaque token and main-owned binding', async () => {
  const f = fixture(), page = await f.controller.queryResources();
  await f.controller.dispatchResource({ type: 'action', viewToken: page.viewToken, entry: {}, action: 'template.create' });
  assert.deepEqual(f.calls.find(c => c[0] === 'resource.execute')[1].binding, { digest: 'binding:a' });
  await assert.rejects(f.controller.dispatchResource({ type: 'action', viewToken: page.viewToken, entry: {}, action: 'template.create', binding: {} }));
  await f.controller.queryResources(); await assert.rejects(f.controller.importResource(page.viewToken, {}), /stale/); f.controller.dispose();
});
test('superseded resource queries cannot replace the newest view token', async () => {
  const first = deferred(), started = deferred(); let queries = 0;
  const f = fixture(); const resource = await f.port.resources();
  f.port.resources = async () => ({ ...resource, query: async () => { if (++queries === 1) { started.resolve(); await first.promise; } return resource.query(); } });
  const old = f.controller.queryResources(); await started.promise; const next = await f.controller.queryResources(); first.resolve();
  await assert.rejects(old, /superseded/); await f.controller.importResource(next.viewToken, {}); f.controller.dispose();
});
test('late resource factory completion is disposed after a copied project opens', async () => {
  const wait = deferred(), started = deferred(), f = fixture(); const resource = await f.port.resources();
  f.port.resources = async () => { started.resolve(); await wait.promise; return resource; };
  const query = f.controller.queryResources(); await started.promise; f.controller.replaceProject(); wait.resolve(); await assert.rejects(query);
  assert.equal(f.calls.filter(c => c[0] === 'resource.dispose').length, 1); f.controller.dispose();
});
