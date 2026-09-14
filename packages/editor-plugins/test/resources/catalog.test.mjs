import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { parseBehaviorContract } from '@haiyue/ai-studio-script-preview';
import { resourceFixture, execute } from './fixture.mjs';

test('catalog projects frozen four-kind contracts from actual registry and Document without changing History', async t => {
  const f = await resourceFixture(); t.after(f.close);
  const before = JSON.stringify(f.workspace.gameSnapshot()), history = JSON.stringify(f.workspace.snapshot().history);
  const page = await f.page();
  assert.ok(page.items.length > 40);
  for (const { entry } of page.items) { assert.deepEqual(parseBehaviorContract('resource-catalog-entry', entry), entry); assert.equal(entry.artifactId, null); }
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(JSON.stringify(f.workspace.snapshot().history), history);
  const geometry = page.items.filter(item => item.entry.kind === 'template' && item.entry.category === 'Geometry');
  assert.equal(geometry.length, 8);
  assert.deepEqual(new Set(geometry.map(item => item.configuration.kind)), new Set(['cube','rounded-box','sphere','cone','cylinder','plane','torus','icosahedron']));
  const lights = page.items.filter(item => item.entry.kind === 'template' && ['haiyue.light.ambient','haiyue.light.directional','haiyue.light.point'].includes(item.entry.ref.templateId));
  assert.equal(lights.length, 3); assert.ok(lights.every(item => item.entry.category === 'Lighting'));
  const preset = page.items.find(item => item.entry.kind === 'preset' && item.entry.category === 'Lighting');
  assert.equal(preset.entry.source, 'unsupported'); assert.equal(preset.entry.status, 'unavailable'); assert.deepEqual(preset.entry.intents, []);
  await assert.rejects(f.action(page, preset, 'preset.apply', { targetEntityId: f.entityId }), /resource.action-unavailable/);
  assert.equal(f.requests.length, 0);
  for (const kind of ['font','spine','tilemap']) await assert.rejects(f.catalog.importAsset({ binding: page.binding, projectPath: 'assets/test.bin', kind, mimeType: 'application/octet-stream', license: 'internal-test', provenance: 'fixture', decodedBytes: 4 }), /resource.import-kind-unavailable/);
});

test('Lighting template, unsupported preset, real instance and environment asset follow separate existing workflows and reopen', async t => {
  const f = await resourceFixture(); t.after(f.close);
  let page = await f.page({ category: 'Lighting' });
  const template = page.items.find(item => item.entry.kind === 'template' && item.entry.ref.templateId === 'haiyue.light.point');
  const historyBefore = f.workspace.snapshot().history;
  const created = await f.action(page, template, 'template.create');
  assert.equal(created.result.status, 'completed'); const entityId = created.result.value.entity.id;
  assert.equal(f.requests.at(-1).toolId, 'entity.create'); assert.equal(f.requests.at(-1).args.kind, 'point-light');
  assert.notDeepEqual(f.workspace.snapshot().history, historyBefore);
  page = await f.page({ category: 'Lighting' });
  const instance = page.items.find(item => item.entry.kind === 'instance' && item.entry.ref.entityId === entityId && item.entry.ref.componentId === null);
  const location = await f.action(page, instance, 'resource.locate');
  assert.equal(f.catalog.resolveLocation(location.location).status, 'current');
  assert.equal(instance.entry.unused, 'inapplicable'); assert.ok(!instance.entry.intents.includes('asset.assign'));
  const asset = await f.importTexture();
  page = await f.page({ category: 'Lighting' });
  const texture = page.items.find(item => item.entry.kind === 'asset' && item.entry.ref.assetId === asset.assetId);
  assert.ok(texture.assignments.includes('texture.environment-diffuse'));
  const assigned = await f.action(page, texture, 'asset.assign', { targetEntityId: entityId, usage: 'texture.environment-diffuse' });
  assert.equal(assigned.result.status, 'completed'); assert.equal(f.requests.at(-1).toolId, 'asset.assign');
  const environment = f.workspace.queryGameDocument({ entityId, limit: 256 }).components.find(component => component.type === 'haiyue.light.environment');
  assert.equal(environment.value.diffuseAssetId, asset.assetId);
  page = await f.page({ kind: 'asset' });
  assert.equal(page.items[0].entry.unused, 'no'); assert.equal(page.items[0].locations[0].field, '/diffuseAssetId');
  const stable = page.items.map(item => item.entry);
  await f.workspace.save(); await f.workspace.reopen();
  assert.deepEqual((await f.page({ kind: 'asset' })).items.map(item => item.entry), stable);
  assert.equal(f.catalog.resolveLocation(location.location).status, 'historical');
  const count = f.workspace.gameSnapshot().assets.length;
  const again = await f.importTexture('assets/copy-of-sky.png'); assert.equal(again.assetId, asset.assetId); assert.equal(f.workspace.gameSnapshot().assets.length, count);
  const current = await f.page({ kind: 'asset' });
  const inspected = await f.action(current, current.items[0], 'asset.inspect'); assert.equal(inspected.item.health, 'verified');
});

test('unknown usage, partial component references and zero references cannot be confused by unused filtering', async t => {
  const f = await resourceFixture(); t.after(f.close); const asset = await f.importTexture();
  let page = await f.page({ kind: 'asset', unused: true }); assert.equal(page.total, 1); assert.equal(page.items[0].entry.usage.status, 'known');
  await execute(f, 'asset.assign', { baseRevision: f.workspace.gameSnapshot().revision, entityId: f.entityId, assetId: asset.assetId, usage: 'texture.environment-diffuse' });
  page = await f.page({ kind: 'asset' }); assert.equal(page.items[0].entry.unused, 'no');
  f.dependencyHook = result => ({ ...result, truncated: true });
  page = await f.page({ kind: 'asset' }); assert.equal(page.items[0].entry.usage.status, 'unknown'); assert.equal(page.items[0].locations.length, 1);
  assert.equal((await f.page({ unused: true })).total, 0);
  f.dependencyHook = null;
  const proposal = await execute(f, 'script.propose', { baseRevision: f.workspace.gameSnapshot().revision, entityId: f.entityId, text: 'Math.sin(time);', capabilities: ['read','input','debug'] });
  await execute(f, 'script.apply', { baseRevision: f.workspace.gameSnapshot().revision, proposalId: proposal.value.proposalId });
  page = await f.page({ kind: 'asset' }); assert.equal(page.items[0].entry.usage.status, 'unknown'); assert.equal(page.items[0].locations.length, 1);
  assert.equal((await f.page({ unused: true })).total, 0);
  const scripts = await f.page({ category: 'Script', kind: 'instance' }); assert.equal(scripts.total, 1);
  const located = await f.action(scripts, scripts.items[0], 'resource.locate'); assert.equal(located.location.target.kind, 'script'); assert.equal(f.catalog.resolveLocation(located.location).status, 'current');
});

test('forged kinds, references, operations, versions, getters and stale bindings never reach mutation ports', async t => {
  const f = await resourceFixture(); t.after(f.close); await f.importTexture();
  const page = await f.page(), template = page.items.find(item => item.entry.kind === 'template' && item.entry.status === 'available'), asset = page.items.find(item => item.entry.kind === 'asset');
  const before = JSON.stringify(f.workspace.gameSnapshot()), requestCount = f.requests.length;
  const request = { binding: page.binding, entry: template.entry, action: 'template.create' };
  for (const bad of [
    { ...request, entry: { ...template.entry, schemaVersion: 2 } },
    { ...request, entry: { ...template.entry, ref: asset.entry.ref } },
    { ...request, action: 'asset.assign', usage: 'texture.base-color', targetEntityId: f.entityId },
    { ...request, entry: { ...template.entry, ref: { ...template.entry.ref, registryVersion: '99.0.0' } } },
    { ...request, entry: { ...template.entry, artifactId: 'artifact:invented' } },
    { ...request, binding: { ...page.binding, projectId: 'project:foreign' } },
    { ...request, approved: true },
  ]) await assert.rejects(f.catalog.execute(bad));
  let getter = false; await assert.rejects(f.catalog.execute({ ...request, get entry() { getter = true; return template.entry; } })); assert.equal(getter, false);
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(f.requests.length, requestCount);
  const location = await f.action(page, asset, 'resource.locate');
  f.bindingVersion = '1.0.1'; await assert.rejects(f.catalog.execute(request), /resource.stale/); assert.equal(f.catalog.resolveLocation(location.location).status, 'historical');
  assert.throws(() => f.catalog.resolveLocation({ ...location.location, schemaVersion: 99 }));
});

test('missing and replaced bytes retain manifest identity, show failure, block assignment and can be rechecked', async t => {
  const f = await resourceFixture(); t.after(f.close); const asset = await f.importTexture();
  let page = await f.page({ kind: 'asset' }); const entryId = page.items[0].entry.catalogEntryId;
  await rm(asset.target);
  await assert.rejects(f.action(page, page.items[0], 'asset.inspect'), /resource.asset-missing/);
  page = await f.page({ kind: 'asset', status: 'unavailable' }); assert.equal(page.total, 1); assert.equal(page.items[0].health, 'missing'); assert.equal(page.items[0].entry.catalogEntryId, entryId);
  await assert.rejects(f.action(page, page.items[0], 'asset.assign', { targetEntityId: f.entityId, usage: 'texture.environment-diffuse' }), /resource.action-unavailable/);
  await writeFile(asset.target, asset.bytes); page = await f.catalog.refresh({ kind: 'asset' });
  assert.equal((await f.action(page, page.items[0], 'asset.inspect')).item.health, 'verified');
  page = await f.page({ kind: 'asset' }); await writeFile(asset.target, Buffer.from('wrong bytes'));
  const count = f.requests.length; await assert.rejects(f.action(page, page.items[0], 'asset.assign', { targetEntityId: f.entityId, usage: 'texture.environment-diffuse' }), /resource.asset-invalid/);
  assert.equal(f.requests.length, count); assert.equal((await f.page({ kind: 'asset' })).items[0].health, 'invalid');
});

test('project inventory excludes templates and duplicate entities, follows tools, undo, redo and project replacement', async t => {
  const f = await resourceFixture(); t.after(f.close);
  for (const category of ['Geometry', 'Material', 'Script', 'Texture']) assert.equal((await f.page({ projectOnly: true, category })).total, 0);
  assert.ok((await f.page({ kind: 'template' })).total > 0, 'creation catalog remains available outside project inventory');
  const created = await execute(f, 'entity.create', { baseRevision: f.workspace.gameSnapshot().revision, kind: 'rounded-box', name: '圆角棋盘', material: 'pbr' });
  assert.equal(created.status, 'completed');
  const geometry = await f.page({ projectOnly: true, category: 'Geometry', limit: 1 });
  assert.equal(geometry.total, 1); assert.equal(geometry.nextCursor, null);
  assert.equal(geometry.items[0].configuration.value.kind, 'rounded-box');
  assert.ok(geometry.items[0].entry.ref.componentId, 'component is the geometry resource');
  const materials = await f.page({ projectOnly: true, category: 'Material' });
  assert.equal(materials.total, 1); assert.equal(materials.items[0].configuration.value.material, 'pbr');
  assert.equal((await f.action(geometry, geometry.items[0], 'resource.locate')).kind, 'location');
  await f.workspace.undo(f.workspace.gameSnapshot().revision);
  assert.equal((await f.page({ projectOnly: true, category: 'Geometry' })).total, 0);
  assert.equal((await f.page({ projectOnly: true, category: 'Material' })).total, 0);
  await f.workspace.redo(f.workspace.gameSnapshot().revision);
  assert.equal((await f.page({ projectOnly: true, category: 'Geometry' })).total, 1);
  const configured = await execute(f, 'component.configure', { baseRevision: f.workspace.gameSnapshot().revision, entityId: created.value.entity.id, action: 'upsert', type: 'haiyue.material.pbr', version: '1.0.0', patch: { baseColor: [.9, .1, .2, 1] } });
  assert.equal(configured.status, 'completed');
  const effective = await f.page({ projectOnly: true, category: 'Material' });
  assert.equal(effective.total, 1, 'PBR override does not duplicate the underlying material slot');
  assert.equal(effective.items[0].configuration.type, 'haiyue.material.pbr');
  const asset = await f.importTexture();
  const textures = await f.page({ projectOnly: true, category: 'Texture' });
  assert.equal(textures.total, 1, 'environment-shaped image is still listed as a texture');
  assert.equal(textures.items[0].entry.ref.assetId, asset.assetId);
  await f.workspace.save(); await f.workspace.reopen();
  assert.equal((await f.page({ projectOnly: true, category: 'Texture' })).total, 1);
  await f.workspace.closeProject();
  assert.equal((await f.page({ projectOnly: true })).total, 0);
  await assert.rejects(f.page({ projectOnly: 'yes' }), /resource.query-invalid/);
});
