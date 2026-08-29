import test from 'node:test';
import assert from 'node:assert/strict';
import { CartesianTransform3D, Entity, Mesh3D, World } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine/geometry';
import { DirectionalLight } from '@haiyue/engine/lighting';
import { PbrMaterial } from '@haiyue/engine/material';
import { GltfModelComponent } from '@haiyue/extensions/gltf';
import { Animation2DComponent } from '@haiyue/extensions/animation';
import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins';
import { RenderEffectsPlayRuntime } from '@haiyue/ai-studio-script-preview';
import { genreVisualFixtures } from './fixtures/g08-visual-fixtures.mjs';

const registry = new ComponentRegistry();
let id = 0;
const component = (type, value = {}) => registry.create({ id: `component:g08-runtime-${++id}`, type, version: '1.0.0', value });

function harness(components) {
  const listeners = new Map();
  const engine = {
    width: 800, height: 600,
    on(name, listener) { listeners.set(name, listener); return this; },
    off(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); return this; },
    emit(name) { listeners.get(name)?.(); },
  };
  const world = new World('g08-runtime');
  const entity = new Entity('Effect owner').addComponent(new CartesianTransform3D());
  world.addEntity(entity);
  const render3DSystem = { priority: 0, requiresIsolatedPass: false, passes: [] };
  const scene = { world, render3DSystem, activeCameraEntity: entity, addSystem(system) { world.addSystem(system); return this; } };
  const source = { id: 'entity:effect-owner', name: 'Effect owner', components };
  return { engine, world, entity, scene, source, map: new Map([[source.id, entity]]) };
}

test('render profile is deterministic and bounded for screenshot reconstruction', () => {
  const profile = RenderEffectsPlayRuntime.engineProfile([{ id: 'entity:profile', name: 'Profile', components: [component('haiyue.render.profile', { profile: 'simple', msaaSamples: 4, clearColor: [0.1, 0.2, 0.3, 1], devicePixelRatio: 2, maxRenderPixels: 1_000_000 })] }]);
  assert.deepEqual(profile, { renderProfile: 'simple', msaaSamples: 4, clearColor: { r: 0.1, g: 0.2, b: 0.3, a: 1 }, devicePixelRatio: 2, maxRenderPixels: 1_000_000 });
});

test('post-process ordering, enable state, device loss and teardown remain observable', async () => {
  const pass = (kind, order, enabled) => ({ kind, enabled, order, radius: 1, sigma: 2, feedback: 0.9, sharpness: 0.15, intensity: 1, sampleCount: 12, maxBlurPixels: 32, blendMode: 'add', quality: 'medium', visibleColor: [1, 1, 1, 1], hiddenColor: [0.1, 0.04, 0.02, 1] });
  const setup = harness([component('haiyue.render.postprocess-stack', { passes: [pass('fxaa', 20, true), pass('grayscale', 10, false), pass('outline', 15, true)] })]);
  const runtime = await RenderEffectsPlayRuntime.create({ engine: setup.engine, scene: setup.scene, sceneEntities: [setup.source], entitiesByStableId: setup.map });
  assert.deepEqual(runtime.manifest().viewport, { width: 800, height: 600, pixelWidth: 800, pixelHeight: 600 });
  assert.deepEqual(runtime.manifest().postprocess.map(item => [item.kind, item.enabled]), [['grayscale', false], ['outline', true], ['fxaa', true]]);
  assert.equal(setup.world.systems.size, 1);
  setup.engine.width = 320; setup.engine.height = 240;
  assert.deepEqual(runtime.manifest().viewport, { width: 320, height: 240, pixelWidth: 320, pixelHeight: 240 });
  setup.engine.emit('device-lost'); assert.equal(runtime.manifest().device, 'lost');
  setup.engine.emit('device-restored'); assert.equal(runtime.manifest().device, 'active');
  runtime.dispose(); runtime.dispose();
  assert.equal(setup.world.systems.size, 0);
  assert.deepEqual(runtime.manifest().owners, { materials: 0, textures: 0, models: 0, lighting: 0, fog: 0, particles2d: 0, particles3d: 0, animations2d: 0, animations3d: 0, audio: 0 });
  setup.world.destroy();

  const disabled = harness([{ ...component('haiyue.render.postprocess-stack', { passes: [pass('fxaa', 1, true)] }), enabled: false }]);
  const disabledRuntime = await RenderEffectsPlayRuntime.create({ engine: disabled.engine, scene: disabled.scene, sceneEntities: [disabled.source], entitiesByStableId: disabled.map });
  assert.deepEqual(disabledRuntime.manifest().postprocess, []);
  assert.equal(disabled.world.systems.size, 0);
  disabledRuntime.dispose(); disabled.world.destroy();

  const enabled = harness([component('haiyue.render.postprocess-stack', { passes: [pass('fxaa', 1, true)] })]);
  const enabledRuntime = await RenderEffectsPlayRuntime.create({ engine: enabled.engine, scene: enabled.scene, sceneEntities: [enabled.source], entitiesByStableId: enabled.map });
  assert.deepEqual(enabledRuntime.manifest().postprocess.map(item => [item.kind, item.enabled]), [['fxaa', true]]);
  assert.equal(enabled.world.systems.size, 1);
  enabledRuntime.dispose();
  assert.equal(enabled.world.systems.size, 0);
  enabled.world.destroy();
});

test('public Animation3DMixer and controlled audio owners run and release without mutating descriptors', async () => {
  let released = 0;
  const animation = component('haiyue.animation.transform-clips', { clips: [{ name: 'Idle', durationTicks: 10, loop: false, from: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, to: { position: { x: 10, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }] });
  const audio = component('haiyue.audio.source', { assetIds: ['asset:test-audio'], autoplay: false });
  const setup = harness([animation, audio]);
  const before = JSON.stringify(setup.source);
  const runtime = await RenderEffectsPlayRuntime.create({ engine: setup.engine, scene: { ...setup.scene, render3DSystem: null }, sceneEntities: [setup.source], entitiesByStableId: setup.map, resolveAudioAsset: async () => ({ url: 'blob:g08-audio', release() { released++; } }) });
  runtime.beforeTick(5);
  const transform = setup.entity.getComponent(CartesianTransform3D);
  assert.ok(Math.abs(transform.position[0] - 5) < 0.001);
  assert.ok(Math.abs(transform.rotation[1] - Math.PI / 4) < 0.001);
  assert.ok(Math.abs(transform.scale[0] - 1.5) < 0.001);
  assert.equal(runtime.manifest().owners.animations3d, 1);
  assert.equal(runtime.manifest().owners.audio, 1);
  runtime.dispose();
  assert.equal(runtime.manifest().owners.animations3d, 0);
  assert.equal(released, 1);
  assert.equal(JSON.stringify(setup.source), before);
  setup.world.destroy();
});

test('audio unlock listeners are installed only while the Play owner is live', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const listeners = new Map();
  class SuspendedAudioContext {
    state = 'suspended';
    destination = {};
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    async decodeAudioData() { return {}; }
    async resume() {}
    async close() {}
  }
  globalThis.window = {
    AudioContext: SuspendedAudioContext,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  globalThis.fetch = async () => ({ ok: true, async arrayBuffer() { return new ArrayBuffer(8); } });
  const setup = harness([component('haiyue.audio.source', { assetIds: ['asset:test-audio'], autoplay: true })]);
  try {
    const runtime = await RenderEffectsPlayRuntime.create({ engine: setup.engine, scene: { ...setup.scene, render3DSystem: null }, sceneEntities: [setup.source], entitiesByStableId: setup.map, resolveAudioAsset: async () => ({ url: 'blob:g08-audio', release() {} }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...listeners.keys()].sort(), ['keydown', 'pointerdown']);
    runtime.dispose();
    assert.equal(listeners.size, 0);
  } finally {
    setup.world.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('2D and 3D particle owners install bounded systems and tear down to zero', async () => {
  const setup = harness([
    component('haiyue.particles.2d', { maxParticles: 32, burst: 4 }),
    component('haiyue.particles.3d', { maxParticles: 64, burst: 8 }),
  ]);
  const runtime = await RenderEffectsPlayRuntime.create({ engine: setup.engine, scene: setup.scene, sceneEntities: [setup.source], entitiesByStableId: setup.map });
  assert.equal(runtime.manifest().owners.particles2d, 1);
  assert.equal(runtime.manifest().owners.particles3d, 1);
  assert.equal(setup.world.systems.size, 4);
  const simulations = [...setup.world.systems.values()].filter(system => system.name === 'Particle2DSystem' || system.name === 'Particle3DSystem');
  assert.equal(simulations.length, 2);
  setup.engine.emit('device-lost');
  assert.ok(simulations.every(system => system.disabled));
  setup.engine.emit('device-restored');
  assert.ok(simulations.every(system => !system.disabled));
  runtime.dispose();
  assert.equal(setup.world.systems.size, 0);
  setup.world.destroy();
});

test('audio fails closed without a controlled asset resolver and late start is cancelled', async () => {
  const setup = harness([component('haiyue.audio.source', { assetIds: ['asset:test-audio'] })]);
  await assert.rejects(RenderEffectsPlayRuntime.create({ engine: setup.engine, scene: { ...setup.scene, render3DSystem: null }, sceneEntities: [setup.source], entitiesByStableId: setup.map }), /asset-resolver-unavailable/);
  assert.equal(setup.world.systems.size, 0);
  setup.world.destroy();

  const late = harness([component('haiyue.audio.source', { assetIds: ['asset:test-audio'] })]);
  const controller = new AbortController();
  let resolve;
  let releasedLate = 0;
  const pending = new Promise(done => { resolve = done; });
  const start = RenderEffectsPlayRuntime.create({ engine: late.engine, scene: { ...late.scene, render3DSystem: null }, sceneEntities: [late.source], entitiesByStableId: late.map, signal: controller.signal, resolveAudioAsset: async () => pending });
  controller.abort(new Error('Play stopped'));
  resolve({ url: 'blob:late', release() { releasedLate++; } });
  await assert.rejects(start, /Play stopped/);
  assert.equal(releasedLate, 1);
  late.world.destroy();

  const partial = harness([component('haiyue.audio.source', { assetIds: ['asset:first', 'asset:second'] })]);
  let releasedPartial = 0;
  await assert.rejects(RenderEffectsPlayRuntime.create({
    engine: partial.engine,
    scene: { ...partial.scene, render3DSystem: null },
    sceneEntities: [partial.source],
    entitiesByStableId: partial.map,
    resolveAudioAsset: async (assetId) => {
      if (assetId === 'asset:second') throw new Error('second audio failed');
      return { url: 'blob:first', release() { releasedPartial++; } };
    },
  }), /second audio failed/);
  assert.equal(releasedPartial, 1);
  partial.world.destroy();
});

test('controlled texture and glTF assets install through public adapters and release on teardown', async () => {
  const setup = harness([
    component('haiyue.material.pbr', { baseColorAssetId: 'asset:test-color', metallicRoughnessAssetId: 'asset:test-metallic-roughness', normalAssetId: 'asset:unbound-normal', occlusionAssetId: 'asset:test-occlusion', emissiveAssetId: 'asset:test-emissive' }),
    component('haiyue.light.environment', { diffuseAssetId: 'asset:test-environment', specularAssetId: 'asset:unbound-specular' }),
    component('haiyue.model.gltf', { assetId: 'asset:test-model', autoLoad: false, loadTimeoutMs: 500 }),
  ]);
  setup.entity.addComponent(new Mesh3D(createBox3D(), new PbrMaterial()));
  let textureReleased = 0;
  let environmentReleased = 0;
  let modelReleased = 0;
  const runtime = await RenderEffectsPlayRuntime.create({
    engine: setup.engine,
    scene: setup.scene,
    sceneEntities: [setup.source],
    entitiesByStableId: setup.map,
    resolveTextureAsset: async () => ({ texture: 'blob:g08-texture', release() { textureReleased++; } }),
    resolveEnvironmentAsset: async () => ({ texture: {}, release() { environmentReleased++; } }),
    resolveModelAsset: async () => ({ url: 'blob:g08-model', release() { modelReleased++; } }),
  });
  assert.equal(runtime.manifest().owners.materials, 1);
  assert.equal(runtime.manifest().owners.textures, 5);
  assert.equal(runtime.manifest().owners.models, 1);
  assert.equal(runtime.manifest().owners.lighting, 1);
  assert.equal(setup.entity.getComponent(GltfModelComponent).src, 'blob:g08-model');
  assert.equal(setup.world.systems.size, 1);
  runtime.dispose();
  assert.equal(textureReleased, 4);
  assert.equal(environmentReleased, 1);
  assert.equal(modelReleased, 1);
  assert.equal(setup.world.systems.size, 0);
  setup.world.destroy();
});

test('scene-owned material and directional shadow state are restored on teardown', async () => {
  const setup = harness([
    component('haiyue.material.pbr'),
    component('haiyue.light.directional', { castShadow: true, shadow: { mapSize: 2048, extent: 30, near: 0.2, far: 90, bias: 0.002, normalBias: 0.04 } }),
  ]);
  const originalMaterial = new PbrMaterial({ roughness: 0.91 });
  const mesh = new Mesh3D(createBox3D(), originalMaterial);
  const originalShadow = { mapSize: 512, extent: 7, near: 0.3, far: 42, bias: 0.005, normalBias: 0.07 };
  const light = new DirectionalLight({ castShadow: false, shadow: originalShadow });
  setup.entity.addComponent(mesh).addComponent(light);
  const runtime = await RenderEffectsPlayRuntime.create({ engine: setup.engine, scene: setup.scene, sceneEntities: [setup.source], entitiesByStableId: setup.map });
  assert.notEqual(mesh.material, originalMaterial);
  assert.equal(light.castShadow, true);
  assert.equal(light.shadow.mapSize, 2048);
  runtime.dispose();
  assert.equal(mesh.material, originalMaterial);
  assert.equal(light.castShadow, false);
  assert.deepEqual(light.shadow, originalShadow);
  setup.world.destroy();
});

test('controlled HaiYue 2D animation installs public simulation/render owners and tears down', async () => {
  const setup = harness([component('haiyue.animation.2d', { assetId: 'asset:test-animation', autoplay: false })]);
  let released = 0;
  const runtime = await RenderEffectsPlayRuntime.create({
    engine: setup.engine,
    scene: setup.scene,
    sceneEntities: [setup.source],
    entitiesByStableId: setup.map,
    resolveAnimationAsset: async () => ({
      source: { format: 'haiyue-animation', version: '1.0', canvas: { width: 64, height: 64, coordinateSystem: 'screen-y-down' }, duration: 1, nodes: [] },
      release() { released++; },
    }),
  });
  assert.equal(runtime.manifest().owners.animations2d, 1);
  assert.ok(setup.entity.getComponent(Animation2DComponent));
  assert.equal(setup.world.systems.size, 2);
  runtime.dispose();
  assert.equal(released, 1);
  assert.equal(setup.world.systems.size, 0);
  setup.world.destroy();
});

test('seven genres share one component registry and explicit visual oracles', () => {
  assert.deepEqual(genreVisualFixtures.map(item => item.genre), ['snake', 'match-3', 'tetris', 'jigsaw', 'platformer', 'racing', 'shooter']);
  for (const fixture of genreVisualFixtures) {
    assert.ok(fixture.oracle.includes('board-readability') || fixture.oracle.some(item => item.includes('differentiation')));
    for (const descriptor of fixture.components) assert.deepEqual(registry.validate(descriptor), descriptor);
  }
});
