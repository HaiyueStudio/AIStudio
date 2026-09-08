import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, mkdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { resourceFixture, execute, png } from './fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('reference query cancellation settles despite an uncooperative port; late project results never publish', async t => {
  const f = await resourceFixture(); t.after(f.close); await f.importTexture();
  const entered = deferred(), release = deferred();
  f.dependencyHook = async result => { entered.resolve(); await release.promise; return result; };
  const pending = f.catalog.query(); await entered.promise;
  f.catalog.cancel(); await assert.rejects(pending, /resource.cancelled/);
  release.resolve(); f.dependencyHook = null;
  assert.equal((await f.page({ kind: 'asset' })).total, 1);
  const switched = deferred(), unblock = deferred();
  f.dependencyHook = async result => { switched.resolve(); await unblock.promise; return result; };
  const late = f.catalog.query(); await switched.promise;
  await f.workspace.newProject(null, 'Another project'); unblock.resolve();
  await assert.rejects(late, /resource.stale/);
  f.dependencyHook = null; const current = await f.page({ kind: 'asset' }); assert.equal(current.total, 0);
  f.catalog.dispose(); f.catalog.dispose(); await assert.rejects(f.catalog.query(), /resource.disposed/);
});

test('file inspection cancelled by caller or superseded by another project cannot assign or change its status', async t => {
  const f = await resourceFixture(); t.after(f.close); await f.importTexture();
  let page = await f.page({ kind: 'asset' });
  const entered = deferred(), release = deferred(), abort = new AbortController();
  f.readHook = async () => { entered.resolve(); await release.promise; };
  const pending = f.action(page, page.items[0], 'asset.assign', { targetEntityId: f.entityId, usage: 'texture.environment-diffuse' }, abort.signal);
  await entered.promise; const before = JSON.stringify(f.workspace.gameSnapshot()), requests = f.requests.length; abort.abort();
  await assert.rejects(pending, /resource.cancelled/); release.resolve(); f.readHook = null;
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(f.requests.length, requests);
  page = await f.page({ kind: 'asset' }); assert.equal(page.items[0].health, 'registered');
  const readEntered = deferred(), readRelease = deferred();
  f.readHook = async () => { readEntered.resolve(); await readRelease.promise; };
  const old = f.action(page, page.items[0], 'asset.inspect'); await readEntered.promise;
  await f.workspace.newProject(null, 'Fresh project'); readRelease.resolve();
  await assert.rejects(old, /resource.stale/); f.readHook = null;
  assert.equal((await f.page({ kind: 'asset' })).total, 0);
});

test('query pages are bounded, query-bound and version-bound; same revision in another project is insufficient', async t => {
  const f = await resourceFixture(); t.after(f.close);
  const first = await f.page({ limit: 7 }); assert.equal(first.items.length, 7); assert.ok(first.nextCursor);
  const ids = new Set(first.items.map(item => item.entry.catalogEntryId));
  let next = first.nextCursor;
  while (next) { const page = await f.page({ limit: 7, cursor: next }); for (const item of page.items) { assert.ok(!ids.has(item.entry.catalogEntryId)); ids.add(item.entry.catalogEntryId); } next = page.nextCursor; }
  assert.equal(ids.size, first.total);
  await assert.rejects(f.page({ limit: 7, cursor: first.nextCursor, kind: 'asset' }), /resource.cursor-stale/);
  await assert.rejects(f.page({ limit: 101 }), /resource.query-invalid/);
  const instancePage = await f.page({ kind: 'instance' }), instance = instancePage.items[0];
  await f.workspace.newProject(null, 'Another document');
  await assert.rejects(f.action(instancePage, instance, 'instance.inspect'), /resource.stale/);
  await assert.rejects(f.page({ limit: 7, cursor: first.nextCursor }), /resource.cursor-stale/);
});

test('existing import containment, file format and decode limits reject invalid sources before Document changes', async t => {
  const f = await resourceFixture(); t.after(f.close);
  const bytes = png(2, 1), assetPath = path.join(f.directory, 'project/assets/safe.png'); await mkdir(path.dirname(assetPath), { recursive: true }); await writeFile(assetPath, bytes);
  const outside = path.join(f.directory, 'outside.png'); await writeFile(outside, bytes);
  const input = { binding: (await f.page()).binding, projectPath: 'assets/safe.png', kind: 'texture', mimeType: 'image/png', license: 'internal-test', provenance: 'fixture:g06', decodedBytes: 128, width: 2, height: 1 };
  const before = JSON.stringify(f.workspace.gameSnapshot());
  for (const patch of [{ projectPath: '../outside.png' }, { projectPath: outside }, { projectPath: 'assets/safe.exe' }, { decodedBytes: 1 }, { decodedBytes: 129 * 1024 * 1024 }, { width: 8193 }, { mimeType: 'application/x-font' }, { license: 'unknown' }]) {
    let result; try { result = await f.catalog.importAsset({ ...input, ...patch }); } catch { /* Same production path may reject at prepare or execution. */ }
    if (result) assert.notEqual(result.result.status, 'completed');
    assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before);
  }
  const link = path.join(f.directory, 'project/assets/escape');
  await symlink(path.join(f.directory), link, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(f.catalog.importAsset({ ...input, projectPath: 'assets/escape/outside.png' }), /resource.workflow-failed/); }
  finally { await unlink(link); }
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before);
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.catalog.importAsset(input, abort.signal), /resource.cancelled/);
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before);
});

test('real approval rejection, History undo/redo, missing references and failed query state remain explicit', async t => {
  const f = await resourceFixture(); t.after(f.close);
  let page = await f.page({ category: 'Lighting', kind: 'template' });
  const template = page.items.find(item => item.entry.ref.templateId === 'haiyue.light.point');
  f.approvalDecision = 'reject'; const before = JSON.stringify(f.workspace.gameSnapshot());
  const bytes = png(2, 1); await mkdir(path.join(f.directory, 'project/assets')); await writeFile(path.join(f.directory, 'project/assets/rejected.png'), bytes);
  const rejected = await f.catalog.importAsset({ binding: page.binding, projectPath: 'assets/rejected.png', kind: 'texture', mimeType: 'image/png', license: 'internal-test', provenance: 'fixture:g06', decodedBytes: bytes.length, width: 2, height: 1 });
  assert.equal(rejected.result.status, 'rejected'); assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before);
  f.approvalDecision = 'allow-once'; const created = await f.action(page, template, 'template.create'); assert.equal(created.result.status, 'completed');
  const entityId = created.result.value.entity.id;
  await f.workspace.undo(f.workspace.gameSnapshot().revision); assert.ok(!f.workspace.gameSnapshot().entities.some(entity => entity.id === entityId));
  await f.workspace.redo(f.workspace.gameSnapshot().revision); assert.ok(f.workspace.gameSnapshot().entities.some(entity => entity.id === entityId));
  await execute(f, 'component.configure', { baseRevision: f.workspace.gameSnapshot().revision, entityId, action: 'upsert', type: 'haiyue.light.environment', patch: { diffuseAssetId: 'asset:missing-resource' } });
  page = await f.page({ kind: 'instance', category: 'Lighting' });
  assert.ok(page.items.some(item => item.entry.dependencies.status === 'unknown' && item.diagnostics.some(message => message.includes('未登记'))));
  await f.importTexture();
  f.dependencyHook = () => { throw Error('SECRET_CANARY private storage details'); };
  page = await f.page({ kind: 'asset' }); assert.equal(page.items[0].entry.usage.status, 'unknown'); assert.doesNotMatch(JSON.stringify(page), /SECRET_CANARY|private storage/);
  f.dependencyHook = result => ({ ...result, references: result.references.map(row => ({ ...row, entityId: 'entity:foreign' })) });
  page = await f.page({ kind: 'asset' }); assert.equal(page.items[0].entry.usage.status, 'unknown'); assert.deepEqual(page.items[0].locations, []);
});
