import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera3D, Entity, SphericalTransform3D } from '@haiyue/engine';
import { applyProjectCamera, DEFAULT_PROJECT_CAMERA, normalizeProjectCamera, projectCameraFromSettings } from '../dist/index.js';

const topDown = {
  projection: 'orthographic', target: { x: 2, y: 0, z: -3 }, distance: 25,
  azimuthDegrees: 0, elevationDegrees: 90, fovDegrees: 45, orthographicSize: 24, near: 0.1, far: 1_000,
};

test('project camera defaults safely and rejects incomplete or unsafe snapshots', () => {
  assert.equal(projectCameraFromSettings({}), DEFAULT_PROJECT_CAMERA);
  assert.deepEqual(normalizeProjectCamera(topDown), topDown);
  assert.throws(() => normalizeProjectCamera({ ...topDown, far: 0.1 }), /far plane must be greater/);
  assert.throws(() => normalizeProjectCamera({ ...topDown, surprise: true }), /requires exactly/);
  assert.throws(() => normalizeProjectCamera({ ...topDown, target: { x: 0, y: Number.NaN, z: 0 } }), /finite number/);
});

test('top-down camera maps to the Engine spherical transform and aspect-correct orthographic bounds', () => {
  const cameraEntity = new Entity('Camera');
  const transform = new SphericalTransform3D();
  const projection = new Camera3D();
  cameraEntity.addComponent(transform);
  cameraEntity.addComponent(projection);
  applyProjectCamera({ cameraEntity }, normalizeProjectCamera(topDown), 16 / 9);

  assert.equal(transform.radius, 25);
  assert.equal(transform.theta, 0);
  assert.equal(transform.phi, 0.005);
  assert.deepEqual([...transform.target], [2, 0, -3]);
  assert.equal(projection.projectionType, 'orthographic');
  assert.equal(projection.orthoTop, 12);
  assert.equal(projection.orthoBottom, -12);
  assert.equal(projection.orthoRight, 12 * 16 / 9);
  assert.equal(projection.orthoLeft, -12 * 16 / 9);
});
