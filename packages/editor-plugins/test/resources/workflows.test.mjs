import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, copyFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { resourceFixture, execute } from './fixture.mjs';

test('registered light, geometry, material and component template values match the actual committed defaults', async t => {
  const f = await resourceFixture(); t.after(f.close);
  for (const type of ['haiyue.light.point', 'haiyue.light.directional', 'haiyue.light.ambient', 'haiyue.render.geometry']) {
    const page = await f.page({ kind: 'template' }), item = page.items.find(item => item.entry.ref.templateId === type);
    const result = await f.action(page, item, 'template.create'); assert.equal(result.result.status, 'completed');
    const entity = f.workspace.gameSnapshot().entities.find(entity => entity.id === result.result.value.entity.id);
    const component = f.workspace.gameSnapshot().components.find(component => entity.componentIds.includes(component.id) && component.type === type);
    assert.deepEqual(component.value, item.configuration, type);
  }
  let page = await f.page({ kind: 'template', category: 'Material' }); const material = page.items.find(item => item.configuration.material === 'pbr');
  const geometry = f.workspace.gameSnapshot().entities.find(entity => entity.componentIds.some(id => f.workspace.gameSnapshot().components.some(c => c.id === id && c.type === 'haiyue.render.geometry')));
  const assigned = await f.action(page, material, 'template.create', { targetEntityId: geometry.id }); assert.equal(assigned.result.status, 'completed');
  assert.equal(f.requests.at(-1).toolId, 'material.set');
  assert.deepEqual(f.workspace.gameSnapshot().components.find(c => geometry.componentIds.includes(c.id) && c.type === 'haiyue.render.material').value, material.configuration);
  page = await f.page({ kind: 'template' }); const camera = page.items.find(item => item.entry.ref.templateId === 'haiyue.camera.3d');
  const result = await f.action(page, camera, 'template.create', { targetEntityId: f.entityId }); assert.equal(result.result.status, 'completed'); assert.equal(f.requests.at(-1).toolId, 'component.configure');
  const owner = f.workspace.gameSnapshot().entities.find(entity => entity.id === f.entityId);
  assert.deepEqual(f.workspace.gameSnapshot().components.find(c => owner.componentIds.includes(c.id) && c.type === 'haiyue.camera.3d').value, camera.configuration);
});

test('workflow errors never disclose port text and delayed mutations keep exact source revision', async t => {
  const f = await resourceFixture(); t.after(f.close);
  const page = await f.page({ kind: 'template', category: 'Lighting' }), item = page.items.find(item => item.entry.ref.templateId === 'haiyue.light.point');
  f.requestHook = async () => { throw Error('SECRET_CANARY credential path'); };
  await assert.rejects(f.action(page, item, 'template.create'), error => error.message === 'resource.workflow-failed');
  assert.equal(f.requests.length, 0);
  let entered, release; const ready = new Promise(resolve => entered = resolve), wait = new Promise(resolve => release = resolve);
  f.requestHook = async () => { entered(); await wait; };
  const pending = f.action(page, item, 'template.create'); await ready;
  await execute(f, 'entity.create', { baseRevision: f.workspace.gameSnapshot().revision, kind: 'empty', name: 'Revision changed' });
  const before = JSON.stringify(f.workspace.gameSnapshot()); release();
  await assert.rejects(pending, /resource.workflow-failed/); assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(f.requests.length, 0);
});

test('copied projects keep resource identity while file health and pending reads stay with their storage owner', async t => {
  const f = await resourceFixture(); t.after(f.close); const asset = await f.importTexture(); await f.workspace.save();
  const original = path.join(f.directory, 'project'), copied = path.join(f.directory, 'copied-project');
  await mkdir(path.join(copied, 'assets'), { recursive: true }); await copyFile(path.join(original, '.haiyue-project.json'), path.join(copied, '.haiyue-project.json')); await writeFile(path.join(copied, 'assets/sky.png'), asset.bytes);
  let page = await f.page({ kind: 'asset' }); const oldDigest = page.binding.digest;
  await unlink(asset.target); await assert.rejects(f.action(page, page.items[0], 'asset.inspect'), /asset-missing/);
  assert.equal((await f.page({ kind: 'asset' })).items[0].health, 'missing');
  await f.workspace.openProject(copied); page = await f.page({ kind: 'asset' });
  assert.equal(page.binding.digest, oldDigest); assert.equal(page.items[0].health, 'registered'); assert.equal(page.items[0].entry.ref.assetId, asset.assetId);
  let entered, release; const ready = new Promise(resolve => entered = resolve), wait = new Promise(resolve => release = resolve);
  f.readHook = async () => { entered(); await wait; };
  const pending = f.action(page, page.items[0], 'asset.inspect'); await ready; await f.workspace.openProject(original); release();
  await assert.rejects(pending, /resource.stale/); f.readHook = null;
  assert.equal((await f.page({ kind: 'asset' })).items[0].health, 'registered');
});
