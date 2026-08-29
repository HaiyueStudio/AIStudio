import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRegistry } from '../dist/components/registry.js';
import { ControlledAssetCatalog } from '../dist/assets/catalog.js';

const REQUIRED = [
  'haiyue.render.profile', 'haiyue.material.pbr', 'haiyue.light.environment', 'haiyue.render.fog', 'haiyue.render.postprocess-stack',
  'haiyue.particles.2d', 'haiyue.particles.3d', 'haiyue.animation.transform-clips', 'haiyue.animation.2d', 'haiyue.animation.state',
  'haiyue.audio.mixer', 'haiyue.audio.source', 'haiyue.model.gltf', 'haiyue.asset.reference',
];

test('G08 registry round-trips render, effects, animation, audio and asset descriptors', () => {
  const registry = new ComponentRegistry();
  for (const [index, type] of REQUIRED.entries()) {
    const definition = registry.get(type, '1.0.0');
    const created = registry.create({ id: `component:g08-${index}`, type, version: '1.0.0' });
    assert.deepEqual(registry.validate(JSON.parse(JSON.stringify(created))), created);
    assert.equal(definition.owner, 'g08-render-assets-effects-adapters');
    assert.equal(definition.serializable, true);
    assert.equal(JSON.stringify(created).includes('GPU'), false);
    assert.equal(JSON.stringify(created).includes('AudioContext'), false);
  }
});

test('post-process, particles and render budgets fail closed at schema boundaries', () => {
  const registry = new ComponentRegistry();
  assert.throws(() => registry.create({ id: 'component:bad-profile', type: 'haiyue.render.profile', version: '1.0.0', value: { maxRenderPixels: 1 } }), /maxRenderPixels must be >= 65536/);
  assert.throws(() => registry.create({ id: 'component:bad-particles', type: 'haiyue.particles.3d', version: '1.0.0', value: { maxParticles: 20_001 } }), /maxParticles must be <= 20000/);
  assert.throws(() => registry.create({ id: 'component:bad-stack', type: 'haiyue.render.postprocess-stack', version: '1.0.0', value: { passes: [{ kind: 'bloom' }] } }), /passes\[0\]/);
});

test('controlled asset catalog enforces containment, format, license, decode and image budgets', () => {
  const catalog = new ControlledAssetCatalog({ maxSourceBytes: 32, maxDecodedBytes: 128, maxImageDimension: 32 });
  const bytes = pngHeader(4, 4);
  const entry = catalog.import({ projectPath: 'assets/ui/tile.png', bytes, mimeType: 'image/png', kind: 'texture', license: 'internal-test', provenance: 'fixture:g08', decodedBytes: 64, width: 4, height: 4 });
  assert.match(entry.id, /^asset:[a-f0-9]{24}$/);
  assert.equal(catalog.import({ projectPath: 'assets/ui/tile.png', bytes, mimeType: 'image/png', kind: 'texture', license: 'internal-test', provenance: 'fixture:g08', decodedBytes: 64, width: 4, height: 4 }), entry);
  assert.equal(catalog.search({ kind: 'texture' })[0], entry);
  assert.equal(catalog.assignment(entry.id, 'texture.base-color').value.assetId, entry.id);
  assert.equal(catalog.assignment(entry.id, 'texture.metallic-roughness').value.usage, 'texture.metallic-roughness');
  assert.equal(catalog.assignment(entry.id, 'texture.occlusion').value.usage, 'texture.occlusion');
  assert.equal(catalog.assignment(entry.id, 'texture.emissive').value.usage, 'texture.emissive');
  const restored = ControlledAssetCatalog.fromManifest(JSON.parse(JSON.stringify(catalog.settingValue())), { maxSourceBytes: 32, maxDecodedBytes: 128, maxImageDimension: 32 });
  assert.deepEqual(restored.manifest(), catalog.manifest());
  const corrupt = JSON.parse(JSON.stringify(catalog.settingValue())); corrupt[0].id = 'asset:000000000000000000000000';
  assert.throws(() => ControlledAssetCatalog.fromManifest(corrupt), /does not match its digest/);
  const environment = catalog.import({ projectPath: 'assets/sky.png', bytes: pngHeader(8, 4), mimeType: 'image/png', kind: 'texture', license: 'internal-test', provenance: 'fixture:g08-environment', decodedBytes: 128, width: 8, height: 4 });
  assert.equal(catalog.assignment(environment.id, 'texture.environment-diffuse').value.usage, 'texture.environment-diffuse');
  assert.throws(() => catalog.assignment(entry.id, 'texture.environment-specular'), /2:1 equirectangular/);
  assert.throws(() => catalog.import({ projectPath: '../secret.png', bytes, mimeType: 'image/png', kind: 'texture', license: 'internal-test', provenance: 'fixture', decodedBytes: 4 }), /stay under assets/);
  assert.throws(() => catalog.import({ projectPath: 'C:\\secret.png', bytes, mimeType: 'image/png', kind: 'texture', license: 'internal-test', provenance: 'fixture', decodedBytes: 4 }), /Absolute asset paths/);
  assert.throws(() => catalog.import({ projectPath: 'assets/model.exe', bytes, mimeType: 'model/gltf-binary', kind: 'model', license: 'internal-test', provenance: 'fixture', decodedBytes: 4 }), /format/);
  assert.throws(() => catalog.import({ projectPath: 'assets/ui/mismatch.png', bytes, mimeType: 'image/png', kind: 'texture', license: 'internal-test', provenance: 'fixture', decodedBytes: 64, width: 8, height: 2 }), /do not match/);
  assert.throws(() => catalog.import({ projectPath: 'assets/ui/fake.png', bytes: new Uint8Array(24), mimeType: 'image/png', kind: 'texture', license: 'internal-test', provenance: 'fixture', decodedBytes: 24, width: 1, height: 1 }), /signature/);
  const gltf = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.invalid/model.bin' }] }));
  assert.throws(() => new ControlledAssetCatalog().import({ projectPath: 'assets/model.gltf', bytes: gltf, mimeType: 'model/gltf+json', kind: 'model', license: 'internal-test', provenance: 'fixture', decodedBytes: gltf.length }), /external URI/);
});

function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}
