import test from 'node:test';
import assert from 'node:assert/strict';
import { Entity, Mesh3D } from '@haiyue/engine';
import { createAuthoringPlane } from '@haiyue/ai-studio-editor-plugins/render';
import { attachSceneEntityVisuals } from '../dist/scene-entity-rendering.js';

test('authoring and preview planes share vertices, front normals and UV orientation in all three planes', () => {
  for (const [plane, normal] of [[undefined, 2], ['xy', 2], ['xz', 1], ['yz', 0]]) {
    const expected = createAuthoringPlane(plane);
    const entity = new Entity('Plane');
    attachSceneEntityVisuals(entity, { kind: 'plane', components: [{ type: 'haiyue.render.geometry', value: { kind: 'plane', ...(plane ? { plane } : {}) } }] });
    const actual = entity.getComponent(Mesh3D).geometry;
    assert.deepEqual(actual.positions, expected.positions); assert.deepEqual(actual.normals, expected.normals);
    for (let i = 0; i < actual.positions.length; i += 3) {
      assert.equal(actual.positions[i + normal], 0);
      assert.equal(actual.normals[i + normal], 1);
    }
    for (const axis of [0, 1, 2].filter(axis => axis !== normal)) assert.ok([...actual.positions].filter((_, index) => index % 3 === axis).some(value => value !== 0));
    entity.removeComponent(Mesh3D);
  }
  assert.throws(() => createAuthoringPlane('zx'), /Geometry plane/);
});

test('rounded-box authoring and Play share real curved geometry, bounds, radius and subdivision settings', async () => {
  const { createAuthoringRoundedBox } = await import('@haiyue/ai-studio-editor-plugins/render');
  const { createBox3D } = await import('@haiyue/engine');
  for (const value of [{}, { radius: 0.15, segments: 6 }, { radius: 0.5, segments: 1 }, { radius: 0, segments: 4 }]) {
    const expected = createAuthoringRoundedBox(value);
    const entity = new Entity('Rounded');
    attachSceneEntityVisuals(entity, { kind: 'rounded-box', components: [{ type: 'haiyue.render.geometry', value: { kind: 'rounded-box', ...value } }] });
    const actual = entity.getComponent(Mesh3D).geometry;
    assert.deepEqual(actual.positions, expected.positions); assert.deepEqual(actual.normals, expected.normals);
    for (const axis of [0, 1, 2]) {
      const coords = [...actual.positions].filter((_, i) => i % 3 === axis);
      assert.equal(Math.min(...coords), -0.5); assert.equal(Math.max(...coords), 0.5);
    }
    if (value.radius !== 0) {
      assert.ok(actual.positions.length > createBox3D().positions.length);
      assert.ok([...actual.normals].some(n => Math.abs(n) > 0.01 && Math.abs(n) < 0.99), 'rounded corners must contain smooth off-axis normals');
      assert.equal([...actual.positions].some((_, i, p) => i % 3 === 0 && p.slice(i, i + 3).every(n => Math.abs(n) === 0.5)), false, 'sharp box corners must be absent');
    } else assert.deepEqual(actual.positions, createBox3D().positions);
    entity.removeComponent(Mesh3D);
  }
});
