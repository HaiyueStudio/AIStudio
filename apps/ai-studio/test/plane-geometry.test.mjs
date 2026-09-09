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
