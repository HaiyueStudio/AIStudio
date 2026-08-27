import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRegistry } from '../dist/components/registry.js';

test('G07 registry exposes serializable 2D/3D physics and gameplay descriptors', () => {
  const registry = new ComponentRegistry();
  const required = [
    'haiyue.physics.world.2d', 'haiyue.physics.world.3d',
    'haiyue.physics.rigidbody.2d', 'haiyue.physics.rigidbody.3d',
    'haiyue.physics.collider.2d', 'haiyue.physics.collider.3d',
    'haiyue.physics.material', 'haiyue.physics.joint.2d', 'haiyue.physics.joint.3d',
    'haiyue.gameplay.character', 'haiyue.gameplay.ground-probe',
  ];
  const snapshot = registry.snapshot();
  for (const type of required) {
    const definition = registry.get(type, '1.0.0');
    assert.equal(definition.serializable, true);
    assert.ok(definition.effect === 'data' || definition.runtimeAdapter);
    assert.ok(snapshot.definitions.some(candidate => candidate.type === type));
  }
});

test('G07 physics schemas reject invalid mass, layer, shape dimensions and transform scale', () => {
  const registry = new ComponentRegistry();
  assert.throws(() => registry.create({
    id: 'component:bad-density', type: 'haiyue.physics.collider.3d', version: '1.0.0',
    value: { density: -1 },
  }), /density must be >= 0/);
  assert.throws(() => registry.create({
    id: 'component:bad-layer', type: 'haiyue.physics.collider.2d', version: '1.0.0',
    value: { categoryBits: 65_536 },
  }), /categoryBits must be <= 65535/);
  assert.throws(() => registry.create({
    id: 'component:bad-size', type: 'haiyue.physics.collider.3d', version: '1.0.0',
    value: { size: { x: 1, y: 0, z: 1 } },
  }), /size\.y must be >= 0\.000001/);
  assert.throws(() => registry.create({
    id: 'component:bad-scale', type: 'haiyue.transform.3d', version: '1.0.0',
    value: { scale: { x: 1, y: 0, z: 1 } },
  }), /scale\.y must be >= 0\.000001/);
});

test('joint targets remain stable entity ids and backend handles never enter component data', () => {
  const registry = new ComponentRegistry();
  const joint = registry.create({
    id: 'component:joint', type: 'haiyue.physics.joint.3d', version: '1.0.0',
    value: { bodyAEntityId: 'entity:anchor', bodyBEntityId: 'entity:platform', type: 'prismatic' },
  });
  assert.equal(joint.value.bodyAEntityId, 'entity:anchor');
  assert.equal(joint.value.bodyBEntityId, 'entity:platform');
  assert.equal(JSON.stringify(joint).includes('handle'), false);
  assert.throws(() => registry.create({
    id: 'component:bad-joint', type: 'haiyue.physics.joint.3d', version: '1.0.0',
    value: { bodyAEntityId: '42' },
  }), /bodyAEntityId does not match/);
});
