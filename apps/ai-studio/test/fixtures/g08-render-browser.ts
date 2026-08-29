import { Camera3D, CartesianTransform3D, Entity, HaiyueEngine, Mesh3D, SphericalTransform3D, createBox3D, createPlane3D } from '@haiyue/engine';
import { OutlineTarget } from '@haiyue/engine/components';
import { DirectionalLight } from '@haiyue/engine/lighting';
import { BasicMaterial } from '@haiyue/engine/material';
import { RenderEffectsPlayRuntime, type RenderEffectComponent } from '@haiyue/ai-studio-script-preview/effects';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
let sequence = 0;
const component = (type: string, value: Record<string, unknown>): RenderEffectComponent => ({ id: `component:g08-browser-${++sequence}`, type, version: '1.0.0', enabled: true, value });
const postPass = (kind: string, order: number) => ({ kind, enabled: true, order, radius: 1, sigma: 2, feedback: 0.9, sharpness: 0.15, intensity: 2.5, sampleCount: 12, maxBlurPixels: 32, blendMode: 'add', quality: 'medium', visibleColor: [1, 0.75, 0.12, 1], hiddenColor: [0.1, 0.02, 0.01, 1] });

const descriptors = [
  { id: 'entity:settings', name: 'Render Settings', components: [
    component('haiyue.render.profile', { profile: 'batched', msaaSamples: 1, clearColor: [0.012, 0.018, 0.035, 1], devicePixelRatio: 1, maxRenderPixels: 1_000_000 }),
    component('haiyue.render.postprocess-stack', { passes: [postPass('outline', 10), postPass('fxaa', 20)] }),
  ] },
  { id: 'entity:hero', name: 'Hero', components: [
    component('haiyue.material.pbr', { baseColor: [0.04, 0.75, 1, 1], metallic: 0.15, roughness: 0.28, emissiveFactor: [0, 0.05, 0.12], normalScale: 1, occlusionStrength: 1, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, baseColorAssetId: 'asset:unbound-base-color', normalAssetId: 'asset:unbound-normal' }),
    component('haiyue.particles.3d', { maxParticles: 256, emissionRate: 70, burst: 50, duration: 30, loop: true, seed: 17, lifetime: [0.8, 1.5], speed: [1, 2.5], startSize: [0.08, 0.18], endSize: [0, 0.04], startColor: [1, 0.45, 0.08, 1], endColor: [1, 0.04, 0.01, 0], blendMode: 'additive', playing: true, emitting: true, direction: [0, 1, 0], spreadDegrees: 35, gravity: [0, -0.5, 0], rotationDegrees: [0, 360], angularVelocityDegrees: [-90, 90], shape: 'sphere', shapeSize: [0, 0, 0], shapeRadius: 0.45, radial: true, opacity: 1, depthTest: true, depthWrite: false, sortMode: 'none' }),
  ] },
  { id: 'entity:ground', name: 'Goal Platform', components: [
    component('haiyue.material.pbr', { baseColor: [0.22, 0.08, 0.38, 1], metallic: 0, roughness: 0.82, emissiveFactor: [0.04, 0, 0.08], normalScale: 1, occlusionStrength: 1, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, baseColorAssetId: 'asset:unbound-base-color', normalAssetId: 'asset:unbound-normal' }),
  ] },
  { id: 'entity:sun', name: 'Sun', components: [
    component('haiyue.light.directional', { color: [1, 0.92, 0.78], intensity: 2.4, direction: [-0.45, -1, -0.35], castShadow: true, shadow: { mapSize: 1024, extent: 18, near: 0.1, far: 50, bias: 0.0015, normalBias: 0.02 } }),
  ] },
  { id: 'entity:environment', name: 'Environment', components: [
    component('haiyue.light.environment', { intensity: 0.65, rotationDegrees: 0, diffuseColor: [0.18, 0.25, 0.42], specularColor: [0.65, 0.8, 1], diffuseAssetId: 'asset:unbound-diffuse', specularAssetId: 'asset:unbound-specular' }),
  ] },
] as const;

const profile = RenderEffectsPlayRuntime.engineProfile(descriptors);
const engine = new HaiyueEngine({ canvas, renderProfile: profile.renderProfile, msaaSamples: profile.msaaSamples, clearColor: profile.clearColor, devicePixelRatio: 1, recoverDeviceLost: true });
await engine.init();
const camera = new Entity('Camera').addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 3, near: 0.1, far: 100 })).addComponent(new SphericalTransform3D({ target: [0, 1, 0], radius: 11, theta: Math.PI * 0.18, phi: Math.PI * 0.25 }));
const scene = engine.createScene({ name: 'G08 visual evidence', camera, render3D: true, render2D: false, gui: false });
const settings = new Entity('Render Settings').addComponent(new CartesianTransform3D());
const hero = new Entity('Hero').addComponent(new CartesianTransform3D({ position: [0, 1.25, 0] })).addComponent(new Mesh3D(createBox3D({ width: 2.2, height: 2.2, depth: 2.2 }), new BasicMaterial({ color: [0.04, 0.75, 1, 1] }))).addComponent(new OutlineTarget());
const ground = new Entity('Goal Platform').addComponent(new CartesianTransform3D({ position: [0, -0.05, 0] })).addComponent(new Mesh3D(createPlane3D({ width: 13, height: 10, normal: 'y' }), new BasicMaterial({ color: [0.22, 0.08, 0.38, 1] })));
const sun = new Entity('Sun').addComponent(new CartesianTransform3D()).addComponent(new DirectionalLight({ direction: [-0.45, -1, -0.35], intensity: 2.4, castShadow: true }));
const environment = new Entity('Environment').addComponent(new CartesianTransform3D());
for (const entity of [settings, hero, ground, sun, environment]) scene.add(entity);
const entitiesByStableId = new Map([['entity:settings', settings], ['entity:hero', hero], ['entity:ground', ground], ['entity:sun', sun], ['entity:environment', environment]]);
const runtime = await RenderEffectsPlayRuntime.create({ engine, scene, sceneEntities: descriptors, entitiesByStableId });
engine.switchScene(scene);
let tick = 0;
engine.on('update', () => runtime.beforeTick(++tick));
engine.run();
await new Promise<void>((resolve) => {
  let frames = 0;
  const complete = () => {
    if (++frames < 40) { requestAnimationFrame(complete); return; }
    document.body.dataset.renderStatus = 'passed';
    document.body.dataset.manifest = JSON.stringify(runtime.manifest());
    resolve();
  };
  requestAnimationFrame(complete);
});

window.addEventListener('beforeunload', () => { runtime.dispose(); engine.destroy(); }, { once: true });
