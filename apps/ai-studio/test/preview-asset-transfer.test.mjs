import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase64, loadPreviewAssets, releasePreviewAssetUrls } from '../dist/preview-asset-transfer.js';

const textureId = 'asset:0123456789abcdef01234567';
const animationId = 'asset:89abcdef0123456701234567';
const manifest = [
  { id: textureId, kind: 'texture', mimeType: 'image/png', byteLength: 4, decodedBytes: 16 },
  { id: animationId, kind: 'animation', mimeType: 'application/vnd.haiyue.animation+json', byteLength: 2, decodedBytes: 2 },
];

test('preview transfer reads only enabled referenced assets and releases owned URLs', async () => {
  const reads = []; const created = []; const revoked = [];
  const platform = { createObjectUrl(bytes, mimeType) { created.push([[...bytes], mimeType]); return 'blob:controlled-texture'; }, revokeObjectUrl(url) { revoked.push(url); }, decodeText(bytes) { return new TextDecoder().decode(bytes); } };
  const assets = await loadPreviewAssets({ assets: manifest, entities: [{ components: [{ enabled: true, value: { baseColorAssetId: textureId, animationAssetId: animationId } }, { enabled: false, value: { ignored: textureId } }] }] }, async (id) => {
    reads.push(id);
    return id === textureId
      ? { assetId: id, kind: 'texture', mimeType: 'image/png', byteLength: 4, base64: 'AQIDBA==' }
      : { assetId: id, kind: 'animation', mimeType: 'application/vnd.haiyue.animation+json', byteLength: 2, base64: 'e30=' };
  }, platform);
  assert.deepEqual(reads, [textureId, animationId]);
  assert.deepEqual(created, []);
  assert.deepEqual([...new Uint8Array(await assets[0].blob.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(assets[0].url, undefined);
  assert.equal(assets[0].blob.type, 'image/png');
  assert.equal(assets[1].source, '{}');
  assert.equal(JSON.stringify(assets).includes('projectPath'), false);
  releasePreviewAssetUrls(assets, platform);
  assert.deepEqual(revoked, []);
});

test('preview transfer fails closed on descriptor drift, encoded length and aggregate budgets', async () => {
  const revoked = [];
  const platform = { createObjectUrl() { return 'blob:owned-before-failure'; }, revokeObjectUrl(url) { revoked.push(url); }, decodeText() { return '{}'; } };
  await assert.rejects(loadPreviewAssets({ assets: manifest, entities: [{ components: [{ enabled: true, value: { textureId, animationId } }] }] }, async (id) => id === textureId
    ? { assetId: id, kind: 'texture', mimeType: 'image/png', byteLength: 4, base64: 'AQIDBA==' }
    : { assetId: id, kind: 'texture', mimeType: 'image/png', byteLength: 2, base64: 'e30=' }, platform), /descriptor changed/);
  assert.deepEqual(revoked, []);
  assert.throws(() => decodeBase64('AQI=', 4), /byte length changed/);
  await assert.rejects(loadPreviewAssets({ assets: [{ id: textureId, kind: 'texture', mimeType: 'image/png', byteLength: 64 * 1024 * 1024 + 1, decodedBytes: 1 }], entities: [{ components: [{ enabled: true, value: { id: textureId } }] }] }, async () => { throw new Error('must not read'); }, platform), /aggregate source or decode budget/);
});

test('preview transfer discards texture bytes when disposal aborts a pending read', async () => {
  const revoked = [];
  const controller = new AbortController();
  let resolveAnimation;
  const animationResponse = new Promise((resolve) => { resolveAnimation = resolve; });
  const platform = { createObjectUrl() { return 'blob:owned-before-abort'; }, revokeObjectUrl(url) { revoked.push(url); }, decodeText() { return '{}'; } };
  const loading = loadPreviewAssets({ assets: manifest, entities: [{ components: [{ enabled: true, value: { textureId, animationId } }] }] }, async (id) => id === textureId
    ? { assetId: id, kind: 'texture', mimeType: 'image/png', byteLength: 4, base64: 'AQIDBA==' }
    : animationResponse, platform, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('Preview disposed'));
  resolveAnimation({ assetId: animationId, kind: 'animation', mimeType: 'application/vnd.haiyue.animation+json', byteLength: 2, base64: 'e30=' });
  await assert.rejects(loading, /Preview disposed/);
  assert.deepEqual(revoked, []);
});

test('texture owners share decoded images, choose slot color spaces and retain recovery sources until the final release', async (t) => {
  const { loadControlledMaterialTexture } = await import('../dist/scene-material-textures.js');
  const original = globalThis.createImageBitmap; t.after(() => { globalThis.createImageBitmap = original; });
  let decoded = 0, closed = 0, releases = 0; const loads = [];
  const bitmap = { close() { closed++; } };
  globalThis.createImageBitmap = async () => { decoded++; return bitmap; };
  const engine = { assetManager: { async loadTexture(source, options) { loads.push({ source, options }); let released = false; return { value: {}, release() { if (!released) { released = true; releases++; } } }; } } };
  const asset = { id: textureId, mimeType: 'image/png', byteLength: 4, blob: new Blob([new Uint8Array([1,2,3,4])], { type: 'image/png' }) };
  const signal = new AbortController().signal;
  const color = await loadControlledMaterialTexture(engine, asset, signal, 'baseColor');
  const normal = await loadControlledMaterialTexture(engine, asset, signal, 'normal');
  assert.equal(decoded, 1); assert.equal(color.texture, bitmap); assert.equal(normal.texture, bitmap);
  assert.deepEqual(loads.map(load => load.options.format), ['rgba8unorm-srgb', 'rgba8unorm']);
  color.release(); await Promise.resolve(); assert.equal(closed, 0);
  normal.release(); normal.release(); await Promise.resolve(); assert.equal(closed, 1); assert.equal(releases, 2);
});

test('texture upload failure and a late cancelled decode release their source and preserve the asset diagnostic', async (t) => {
  const { loadControlledMaterialTexture } = await import('../dist/scene-material-textures.js');
  const original = globalThis.createImageBitmap; t.after(() => { globalThis.createImageBitmap = original; });
  let closed = 0; const bitmap = { close() { closed++; } };
  const asset = { id: textureId, mimeType: 'image/png', byteLength: 1, blob: new Blob(['x'], { type: 'image/png' }) };
  globalThis.createImageBitmap = async () => bitmap;
  const engine = { assetManager: { async loadTexture() { throw Error('upload rejected'); } } };
  await assert.rejects(loadControlledMaterialTexture(engine, asset, new AbortController().signal, 'baseColor'), /texture.load-failed: asset:.*upload rejected/);
  await Promise.resolve(); assert.equal(closed, 1);
  let resolve; globalThis.createImageBitmap = () => new Promise(done => { resolve = done; });
  const controller = new AbortController(); const pending = loadControlledMaterialTexture(engine, asset, controller.signal, 'baseColor');
  controller.abort(); resolve(bitmap);
  await assert.rejects(pending, /abort/i); await Promise.resolve(); assert.equal(closed, 2);
});
