import test from 'node:test';
import assert from 'node:assert/strict';
import { Entity, Mesh3D, PbrMaterial } from '@haiyue/engine';
import { BlinnPhongMaterial, BlinnPhongRenderSystem } from '@haiyue/engine/experimental';
import { DirectionalLight } from '@haiyue/engine/lighting';
import { attachSceneEntityVisuals, installSceneEntityMaterialRenderers, isRenderableSceneKind } from '../dist/scene-entity-rendering.js';

test('renderer projects built-in geometry, Engine materials and lights from Scene snapshots', () => {
  const sphere = new Entity('Sphere');
  attachSceneEntityVisuals(sphere, { kind: 'sphere', appearance: { material: 'pbr', color: [0.2, 0.7, 1, 1] } });
  const mesh = sphere.getComponent(Mesh3D);
  assert.ok(mesh);
  assert.ok(mesh.material instanceof PbrMaterial);
  assert.equal(isRenderableSceneKind('sphere'), true);

  const sun = new Entity('Sun');
  attachSceneEntityVisuals(sun, { kind: 'directional-light', light: { color: [1, 0.95, 0.8], intensity: 1.5, direction: [-1, -1, 0], castShadow: true } });
  const light = sun.getComponent(DirectionalLight);
  assert.ok(light);
  assert.equal(light.intensity, 1.5);
  assert.deepEqual(light.direction, [-1, -1, 0]);

  const board = new Entity('Board');
  attachSceneEntityVisuals(board, { kind: 'plane', appearance: { material: 'pbr', color: [0.1, 0.2, 0.3, 1] } });
  const plane = board.getComponent(Mesh3D).geometry;
  assert.deepEqual([...new Set([...plane.positions].filter((_, index) => index % 3 === 1))], [0]);
  assert.deepEqual([...new Set([...plane.normals].filter((_, index) => index % 3 === 1))], [1]);
  assert.deepEqual([Math.min(...plane.positions.filter((_, index) => index % 3 === 0)), Math.max(...plane.positions.filter((_, index) => index % 3 === 0))], [-0.5, 0.5]);
  assert.deepEqual([Math.min(...plane.positions.filter((_, index) => index % 3 === 2)), Math.max(...plane.positions.filter((_, index) => index % 3 === 2))], [-0.5, 0.5]);
});

test('renderer installs the optional Blinn-Phong material adapter on every rendered Scene', () => {
  let registration;
  let installedSystem;
  const render3DSystem = {
    materialRenderers: { unregister() {} },
    registerMaterialRenderer(value) { registration = value; return this; },
  };
  const scene = {
    cameraEntity: new Entity('Camera'),
    render3DSystem,
    addSystem(system, renderOptions) { installedSystem = system; assert.equal(renderOptions, false); return this; },
  };

  installSceneEntityMaterialRenderers({}, scene);

  assert.ok(installedSystem instanceof BlinnPhongRenderSystem);
  assert.equal(registration.materialType, BlinnPhongMaterial);
});
