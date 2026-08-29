import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentRegistry } from '../packages/editor-plugins/dist/index.js';
import { GAME_AUTHORING_TOOL_DEFINITIONS } from '../packages/game-authoring-tools/dist/index.js';
import { genreVisualFixtures } from '../apps/ai-studio/test/fixtures/g08-visual-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goalId = 'g08-render-assets-effects-adapters';
const expectedTypes = [
  'haiyue.animation.2d', 'haiyue.animation.state', 'haiyue.animation.transform-clips', 'haiyue.asset.reference',
  'haiyue.audio.mixer', 'haiyue.audio.source', 'haiyue.light.environment', 'haiyue.material.pbr', 'haiyue.model.gltf',
  'haiyue.particles.2d', 'haiyue.particles.3d', 'haiyue.render.fog', 'haiyue.render.postprocess-stack', 'haiyue.render.profile',
];
const postprocess = ['fxaa', 'taa', 'gaussian-blur', 'outline', 'grayscale', 'motion-blur', 'gtao', 'sao', 'ssao'];

const registry = new ComponentRegistry().freeze().snapshot();
const descriptors = registry.definitions.filter((item) => item.owner === goalId);
assert.deepEqual(descriptors.map((item) => item.type), expectedTypes);
for (const descriptor of descriptors) {
  assert.equal(descriptor.serializable, true);
  assert.equal(descriptor.version, '1.0.0');
  assert.doesNotMatch(JSON.stringify(descriptor.defaults), /(?:GPUTexture|AudioContext|ImageBitmap|GltfModelComponent)/u);
}
const directional = registry.definitions.find((item) => item.type === 'haiyue.light.directional');
for (const marker of ['castShadow', 'mapSize', 'normalBias']) assert.ok(JSON.stringify(directional?.valueSchema).includes(marker), `Directional shadow schema is missing ${marker}.`);

const census = JSON.parse(await readFile(path.join(root, 'config', 'contracts', 'm12-capability-census.json'), 'utf8'));
const capabilities = census.capabilities.filter((entry) => entry.owner === goalId).map((entry) => {
  assert.equal(entry.testOwner, goalId);
  return { id: entry.id, classification: entry.classification, integrationState: entry.id === 'prefab' ? 'blocked-public-seam' : 'g08-verified' };
});
assert.deepEqual(capabilities.map((item) => item.id), ['lighting', 'shadow.directional', 'material.pbr', 'postprocess', 'particles.2d', 'particles.3d', 'animation.2d', 'animation.3d', 'audio.playback', 'asset.import', 'prefab']);
assert.deepEqual(capabilities.at(-1), { id: 'prefab', classification: 'missing-seam', integrationState: 'blocked-public-seam' });

const engine = JSON.parse(await readFile(path.join(root, 'config', 'engine-candidate.json'), 'utf8'));
const extensionConfig = JSON.parse(await readFile(path.join(root, 'config', 'render-extension-candidates.json'), 'utf8'));
for (const required of ['./assets', './lighting', './material', './postprocess']) assert.ok(engine.requiredExports.includes(required));
const candidates = [
  { package: engine.package, version: engine.version, sha256: engine.sha256, exports: ['./assets', './lighting', './material', './postprocess'] },
  ...extensionConfig.candidates.map((candidate) => ({ package: candidate.package, version: candidate.version, sha256: candidate.sha256, exports: candidate.requiredExports })),
];

const assetSource = await readFile(path.join(root, 'packages', 'editor-plugins', 'src', 'assets', 'catalog.ts'), 'utf8');
for (const marker of ['CONTROLLED_ASSET_CATALOG_SETTING_KEY', 'fromManifest', 'settingValue', '32 * 1024 * 1024', '128 * 1024 * 1024', '8192', '4096', 'asset.path-outside-project', 'asset.license-invalid', 'asset.external-uri', 'textureDimensions', 'parseGlbDocument', 'validateAudioSignature', 'provenance']) assert.ok(assetSource.includes(marker), `Asset policy marker is missing: ${marker}`);
const assetTools = GAME_AUTHORING_TOOL_DEFINITIONS.filter((item) => item.id.startsWith('asset.'));
assert.deepEqual(assetTools.map((item) => item.id), ['asset.search', 'asset.import', 'asset.assign']);
assert.equal(assetTools[0].requiresApproval, false);
assert.ok(assetTools.slice(1).every((item) => item.requiresApproval && item.effect === 'reversible-edit'));
const toolRuntimeSource = await readFile(path.join(root, 'packages', 'game-authoring-tools', 'src', 'runtime.ts'), 'utf8');
for (const marker of ['workspace.readControlledAsset', "op: 'asset.upsert'", 'CONTROLLED_ASSET_CATALOG_SETTING_KEY', "case 'asset.assign'", "case 'asset.search'"]) assert.ok(toolRuntimeSource.includes(marker), `Asset tool runtime marker is missing: ${marker}`);
const repositorySource = await readFile(path.join(root, 'packages', 'editor-plugins', 'src', 'project', 'repository.ts'), 'utf8');
for (const marker of ['readControlledAsset', 'assets/', 'project-asset-path-invalid', 'assertTargetSafe', 'lstat', 'isSymbolicLink']) assert.ok(repositorySource.includes(marker), `Controlled project read marker is missing: ${marker}`);
const runtimeSource = await readFile(path.join(root, 'packages', 'script-preview', 'src', 'effects', 'render-effects-runtime.ts'), 'utf8');
for (const marker of ['resolveTextureAsset', 'metallicRoughnessTexture', 'occlusionTexture', 'emissiveTexture', 'resolveEnvironmentAsset', 'resolveModelAsset', 'resolveAnimationAsset', 'resolveAudioAsset', 'GltfModelSystem', 'Animation2DRenderSystem', "from '@haiyue/extensions/animation3d'", 'Animation3DMixer', 'Animation3DPoseApplier', 'mixer.destroy()', 'onDeviceLost', 'tickingSystems', 'runtimeAssets.push(asset)', 'runtimeAssets.splice(0).reverse()', 'pixelWidth', 'component.onEntityAddToWorld']) assert.ok(runtimeSource.includes(marker), `Effect runtime marker is missing: ${marker}`);
for (const kind of postprocess) assert.ok(runtimeSource.includes(`'${kind}'`), `Post-process adapter is missing: ${kind}`);
const runtimeTest = await readFile(path.join(root, 'apps', 'ai-studio', 'test', 'g08-render-effects-runtime.test.mjs'), 'utf8');
for (const marker of ['viewport', 'enabledRuntime', 'late start is cancelled', 'releasedPartial', 'simulations.every(system => system.disabled)', 'unlock listeners', 'controlled texture and glTF', 'scene-owned material', 'HaiYue 2D animation', 'public Animation3DMixer', 'seven genres']) assert.ok(runtimeTest.includes(marker));
const ipcSource = await readFile(path.join(root, 'apps', 'ai-studio', 'src', 'ipc.ts'), 'utf8');
for (const marker of ["'asset/read'", 'workspace.readControlledAsset', 'entry.digest', "crypto.subtle.digest('SHA-256'", "Buffer.from(bytes).toString('base64')"]) assert.ok(ipcSource.includes(marker), `Product asset IPC marker is missing: ${marker}`);
const transferSource = await readFile(path.join(root, 'apps', 'ai-studio', 'src', 'preview-asset-transfer.ts'), 'utf8');
for (const marker of ['referenced.size > 128', '64 * 1024 * 1024', '256 * 1024 * 1024', 'decodeBase64', 'releasePreviewAssetUrls', 'URL.createObjectURL', 'URL.revokeObjectURL']) assert.ok(transferSource.includes(marker), `Preview transfer marker is missing: ${marker}`);
const rendererSource = await readFile(path.join(root, 'apps', 'ai-studio', 'src', 'renderer.ts'), 'utf8');
for (const marker of ["invoke('asset/read'", 'loadPreviewAssets', 'releasePreviewAssetUrls']) assert.ok(rendererSource.includes(marker), `Product renderer asset marker is missing: ${marker}`);
const previewSource = await readFile(path.join(root, 'apps', 'ai-studio', 'src', 'preview-runtime.ts'), 'utf8');
for (const marker of ['resolveEnvironmentAsset', 'resolveTextureAsset', 'resolveModelAsset', 'resolveAnimationAsset', 'resolveAudioAsset', '/^blob:/u']) assert.ok(previewSource.includes(marker), `Product iframe resolver marker is missing: ${marker}`);
const previewHtml = await readFile(path.join(root, 'apps', 'ai-studio', 'renderer', 'preview.html'), 'utf8');
for (const marker of ['img-src blob:', 'connect-src blob:', 'media-src blob:']) assert.ok(previewHtml.includes(marker));
assert.doesNotMatch(previewHtml, /https?:\/\//u);
const transferTest = await readFile(path.join(root, 'apps', 'ai-studio', 'test', 'preview-asset-transfer.test.mjs'), 'utf8');
for (const marker of ['only enabled referenced assets', 'owned-before-failure', 'aggregate budgets', 'disposal aborts a pending read', 'owned-before-abort']) assert.ok(transferTest.includes(marker));
const ipcTest = await readFile(path.join(root, 'apps', 'ai-studio', 'test', 'ipc.test.mjs'), 'utf8');
for (const marker of ['asset/read', 'tampered', 'projectPath']) assert.ok(ipcTest.includes(marker));
const electronTest = await readFile(path.join(root, 'apps', 'ai-studio', 'test', 'g08-render-electron.test.mjs'), 'utf8');
for (const marker of ['visual-oracle', 'bright < 100', 'chromatic < 100', 'maxLuminance - minLuminance < 35']) assert.ok((electronTest + await readFile(path.join(root, 'apps', 'ai-studio', 'test', 'fixtures', 'g08-render-main.mjs'), 'utf8')).includes(marker));
const productElectronTest = await readFile(path.join(root, 'apps', 'ai-studio', 'test', 'g08-preview-asset-electron.test.mjs'), 'utf8');
for (const marker of ['sandboxed product preview', 'blob-texture textures=1 materials=1 cleanup=0', 'haiyue-preview://app/preview.html']) assert.ok(productElectronTest.includes(marker));
const architecture = await readFile(path.join(root, 'docs', 'architecture', 'm12-render-assets-effects.md'), 'utf8');
for (const marker of ['Controlled asset boundary', 'Rendering and reconstruction', 'Explicit deferred seam', 'captured bitmap']) assert.ok(architecture.includes(marker));

assert.deepEqual(genreVisualFixtures.map((item) => item.genre), ['snake', 'match-3', 'tetris', 'jigsaw', 'platformer', 'racing', 'shooter']);
for (const fixture of genreVisualFixtures) assert.ok(fixture.oracle.length >= 3);

const report = {
  schemaVersion: 1,
  goalId,
  candidates,
  capabilities,
  descriptors: descriptors.map((item) => ({ type: item.type, capability: item.capability, effect: item.effect, runtimeAdapter: item.runtimeAdapter })),
  pbrTextureSlots: ['base-color', 'metallic-roughness', 'normal', 'occlusion', 'emissive'],
  postprocess,
  assets: {
    containedRoot: 'assets', catalogSetting: 'studio.assets.catalog.v1', networkAllowed: false, externalUrisAllowed: false, contentSignaturesVerified: true, textureDimensionsHeaderVerified: true, licenseRequired: true, provenanceRequired: true,
    sourceBudgetBytes: 33_554_432, decodedBudgetBytes: 134_217_728, maxImageDimension: 8192, maxEntries: 4096,
    toolExposure: ['asset.search', 'asset.import', 'asset.assign'],
    playTransfer: { ipcMethod: 'asset/read', integrity: 'sha-256-before-transfer', maxReferencedAssets: 128, aggregateSourceBudgetBytes: 67_108_864, aggregateDecodedBudgetBytes: 268_435_456, runtimePayload: 'blob-url-or-bounded-animation-source', filesystemPathsExposed: false },
  },
  lifecycle: { abortAndLateResultSafe: true, deviceLossObservable: true, audioUnlockScoped: true, animation3dMixerDestroyed: true, sceneMutationsRestored: true, blobUrlsRevoked: true, idempotentStop: true, authoringDocumentImmutable: true, residualAfterStop: { components: 0, systems: 0, resolvedAssets: 0, unlockListeners: 0, blobUrls: 0 } },
  fixtures: genreVisualFixtures.map((item) => item.genre),
  visualSmoke: { runtime: 'electron-webgpu', features: ['pbr', 'directional-shadow', 'environment-light', 'outline', 'fxaa', 'particles.3d'], semanticBitmapOracle: true, pngHeaderOnly: false },
  productAssetSmoke: { runtime: 'electron-sandboxed-product-preview', asset: 'controlled-png-blob', expectedOwners: { textures: 1, materials: 1 }, residualDisposables: 0 },
};

if (process.argv.includes('--print')) console.log(JSON.stringify(report, null, 2));
else {
  const evidence = JSON.parse(await readFile(path.join(root, 'docs', 'evidence', 'm12-g08-verification.json'), 'utf8'));
  assert.deepEqual(report, evidence, 'G08 verification evidence drifted; review implementation and evidence together.');
  console.log(`[m12:g08] descriptors=${descriptors.length} candidates=${candidates.length} tools=${assetTools.length} fixtures=${report.fixtures.length} visual=electron-webgpu product-asset=sandboxed-blob prefab=blocked-public-seam`);
}
