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
  assert.deepEqual(created, [[ [1, 2, 3, 4], 'image/png' ]]);
  assert.equal(assets[0].url, 'blob:controlled-texture');
  assert.equal(assets[1].source, '{}');
  assert.equal(JSON.stringify(assets).includes('projectPath'), false);
  releasePreviewAssetUrls(assets, platform);
  assert.deepEqual(revoked, ['blob:controlled-texture']);
});

test('preview transfer fails closed on descriptor drift, encoded length and aggregate budgets', async () => {
  const revoked = [];
  const platform = { createObjectUrl() { return 'blob:owned-before-failure'; }, revokeObjectUrl(url) { revoked.push(url); }, decodeText() { return '{}'; } };
  await assert.rejects(loadPreviewAssets({ assets: manifest, entities: [{ components: [{ enabled: true, value: { textureId, animationId } }] }] }, async (id) => id === textureId
    ? { assetId: id, kind: 'texture', mimeType: 'image/png', byteLength: 4, base64: 'AQIDBA==' }
    : { assetId: id, kind: 'texture', mimeType: 'image/png', byteLength: 2, base64: 'e30=' }, platform), /descriptor changed/);
  assert.deepEqual(revoked, ['blob:owned-before-failure']);
  assert.throws(() => decodeBase64('AQI=', 4), /byte length changed/);
  await assert.rejects(loadPreviewAssets({ assets: [{ id: textureId, kind: 'texture', mimeType: 'image/png', byteLength: 64 * 1024 * 1024 + 1, decodedBytes: 1 }], entities: [{ components: [{ enabled: true, value: { id: textureId } }] }] }, async () => { throw new Error('must not read'); }, platform), /aggregate source or decode budget/);
});
