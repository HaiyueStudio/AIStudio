import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { resourceFixture } from './fixture.mjs';
import { seedResourceProject } from './large-fixture.mjs';

test('0/1/100/1000 entities and 200 scripts are actual Document inputs with bounded pages and no source text', { timeout: 45000 }, async t => {
  const f = await resourceFixture(); t.after(f.close);
  for (const count of [0, 1, 100, 1000]) {
    await seedResourceProject(f, count, count === 1000 ? 200 : 0);
    const before = JSON.stringify(f.workspace.gameSnapshot());
    const page = await f.page({ kind: 'instance', limit: 25 });
    assert.equal(page.total, count * 2 + (count === 1000 ? 200 : 0));
    assert.ok(page.items.length <= 25); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024);
    assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.doesNotMatch(JSON.stringify(page), /Math\.sin/);
    if (count === 1000) {
      const scripts = await f.page({ category: 'Script', kind: 'instance', limit: 25 }); assert.equal(scripts.total, 200); assert.ok(scripts.nextCursor);
      const result = await f.action(scripts, scripts.items[0], 'resource.locate'); assert.equal(result.location.target.kind, 'script');
    }
  }
});

test('oversize source and model external dependencies use existing controlled import rejection', async t => {
  const f = await resourceFixture(); t.after(f.close); await f.importTexture();
  const model = { asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: '../outside.bin' }] };
  await writeFile(path.join(f.directory, 'project/assets/external.gltf'), JSON.stringify(model));
  const handle = await open(path.join(f.directory, 'project/assets/huge.png'), 'w');
  try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
  const before = JSON.stringify(f.workspace.gameSnapshot()), binding = (await f.page()).binding;
  for (const spec of [{ projectPath: 'assets/huge.png', kind: 'texture', mimeType: 'image/png', width: 2, height: 1 }, { projectPath: 'assets/external.gltf', kind: 'model', mimeType: 'model/gltf+json' }]) {
    await assert.rejects(f.catalog.importAsset({ binding, license: 'internal-test', provenance: 'fixture:g06', decodedBytes: 128, ...spec }));
    assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before);
  }
});

test('proven use-site navigation validates exact component field and refuses fabricated or old sites', async t => {
  const f = await resourceFixture(); t.after(f.close); await f.importTexture();
  let page = await f.page({ kind: 'asset' });
  await f.action(page, page.items[0], 'asset.assign', { targetEntityId: f.entityId, usage: 'texture.environment-diffuse' });
  page = await f.page({ kind: 'asset' }); const item = page.items[0], site = item.locations[0];
  const input = { binding: page.binding, entry: item.entry, ref: site.ref, field: site.field }, location = f.catalog.locateUsage(input);
  assert.equal(location.target.kind, 'component'); assert.equal(location.target.field, '/diffuseAssetId'); assert.equal(f.catalog.resolveLocation(location).status, 'current');
  assert.throws(() => f.catalog.locateUsage({ ...input, field: '/specularAssetId' }), /location-unproven/);
  assert.throws(() => f.catalog.locateUsage({ ...input, ref: { ...site.ref, entityId: 'entity:foreign' } }), /location-unproven/);
  await f.workspace.newProject(null, 'Elsewhere'); assert.throws(() => f.catalog.locateUsage(input), /stale/); assert.equal(f.catalog.resolveLocation(location).status, 'historical');
});
