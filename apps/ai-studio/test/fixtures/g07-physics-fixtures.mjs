import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins';

const registry = new ComponentRegistry();
let sequence = 0;

function component(type, value = {}) {
  sequence += 1;
  return registry.create({ id: `component:g07-${sequence}`, type, version: '1.0.0', value });
}

function entity(id, name, position, components, scale = { x: 1, y: 1, z: 1 }) {
  return Object.freeze({
    id, name,
    transform: Object.freeze({ position: Object.freeze(position), rotationDegrees: Object.freeze({ x: 0, y: 0, z: 0 }), scale: Object.freeze(scale) }),
    components: Object.freeze(components),
  });
}

export function platformerFixture() {
  return Object.freeze({
    id: 'g07-platformer', seed: 'g07-platformer-seed', ticks: 150,
    replay: Object.freeze([{ kind: 'action', tick: 80, order: 0, source: 'synthetic', action: 'Jump', phase: 'down' }, { kind: 'action', tick: 81, order: 1, source: 'synthetic', action: 'Jump', phase: 'up' }]),
    entities: Object.freeze([
      entity('entity:physics-world', 'Physics World', { x: 0, y: 0, z: 0 }, [component('haiyue.physics.world.3d', { gravity: { x: 0, y: -9.81, z: 0 } })]),
      entity('entity:ground', 'Ground', { x: 0, y: -0.5, z: 0 }, [
        component('haiyue.physics.rigidbody.3d', { type: 'static' }),
        component('haiyue.physics.collider.3d', { shape: 'box', size: { x: 20, y: 1, z: 20 }, density: 0 }),
      ]),
      entity('entity:player', 'Player', { x: 0, y: 2, z: 0 }, [
        component('haiyue.physics.rigidbody.3d', { type: 'dynamic', allowSleep: false, lockRotations: [true, true, true] }),
        component('haiyue.physics.collider.3d', { shape: 'sphere', size: { x: 1, y: 1, z: 1 }, radius: 0.5 }),
        component('haiyue.gameplay.character', { dimension: '3d', jumpImpulse: 5 }),
        component('haiyue.gameplay.ground-probe', { dimension: '3d', distance: 0.62, radius: 0.2 }),
      ]),
    ]),
  });
}

export function racingFixture() {
  return Object.freeze({
    id: 'g07-racing', seed: 'g07-racing-seed', ticks: 90, replay: Object.freeze([]),
    entities: Object.freeze([
      entity('entity:physics-world', 'Physics World', { x: 0, y: 0, z: 0 }, [component('haiyue.physics.world.2d', { gravity: { x: 0, y: 0 } })]),
      entity('entity:track-wall', 'Track Wall', { x: 4, y: 0, z: 0 }, [
        component('haiyue.physics.rigidbody.2d', { type: 'static' }),
        component('haiyue.physics.collider.2d', { shape: 'box', size: { x: 1, y: 10 }, density: 0 }),
      ]),
      entity('entity:car', 'Car', { x: 0, y: 0, z: 0 }, [
        component('haiyue.physics.rigidbody.2d', { type: 'dynamic', fixedRotation: true, allowSleep: false, bullet: true, initialVelocity: { x: 6, y: 0 } }),
        component('haiyue.physics.collider.2d', { shape: 'circle', size: { x: 1, y: 1 }, radius: 0.5 }),
      ]),
    ]),
  });
}

export function shooterFixture() {
  return Object.freeze({
    id: 'g07-shooter', seed: 'g07-shooter-seed', ticks: 40, replay: Object.freeze([]),
    entities: Object.freeze([
      entity('entity:physics-world', 'Physics World', { x: 0, y: 0, z: 0 }, [component('haiyue.physics.world.3d', { gravity: { x: 0, y: 0, z: 0 } })]),
      entity('entity:hit-trigger', 'Hit Trigger', { x: 3, y: 0, z: 0 }, [
        component('haiyue.physics.rigidbody.3d', { type: 'static' }),
        component('haiyue.physics.collider.3d', { shape: 'box', size: { x: 1, y: 2, z: 2 }, density: 0, trigger: true }),
      ]),
      entity('entity:bullet', 'Bullet', { x: 0, y: 0, z: 0 }, [
        component('haiyue.physics.rigidbody.3d', { type: 'dynamic', allowSleep: false, ccd: true, initialVelocity: { x: 20, y: 0, z: 0 } }),
        component('haiyue.physics.collider.3d', { shape: 'sphere', size: { x: 1, y: 1, z: 1 }, radius: 0.25 }),
      ]),
    ]),
  });
}

export function staleJointFixture() {
  return Object.freeze([
    entity('entity:physics-world', 'Physics World', { x: 0, y: 0, z: 0 }, [component('haiyue.physics.world.2d', { gravity: { x: 0, y: 0 } })]),
    entity('entity:joint-owner', 'Broken Joint', { x: 0, y: 0, z: 0 }, [component('haiyue.physics.joint.2d', { bodyAEntityId: 'entity:missing-a', bodyBEntityId: 'entity:missing-b' })]),
  ]);
}

export function jointFixture() {
  return Object.freeze({
    id: 'g07-joint', seed: 'g07-joint-seed', ticks: 10, replay: Object.freeze([]),
    entities: Object.freeze([
      entity('entity:physics-world', 'Physics World', { x: 0, y: 0, z: 0 }, [component('haiyue.physics.world.2d', { gravity: { x: 0, y: 0 } })]),
      entity('entity:joint-anchor', 'Joint Anchor', { x: 0, y: 0, z: 0 }, [
        component('haiyue.physics.rigidbody.2d', { type: 'static' }),
        component('haiyue.physics.collider.2d', { shape: 'circle', size: { x: 1, y: 1 }, radius: 0.25, density: 0 }),
      ]),
      entity('entity:joint-body', 'Joint Body', { x: 2, y: 0, z: 0 }, [
        component('haiyue.physics.rigidbody.2d', { type: 'dynamic', allowSleep: false }),
        component('haiyue.physics.collider.2d', { shape: 'circle', size: { x: 1, y: 1 }, radius: 0.25 }),
      ]),
      entity('entity:joint-owner', 'Distance Joint', { x: 0, y: 0, z: 0 }, [
        component('haiyue.physics.joint.2d', { type: 'distance', bodyAEntityId: 'entity:joint-anchor', bodyBEntityId: 'entity:joint-body', length: 2 }),
      ]),
    ]),
  });
}

export function backendFailureFixture() {
  return Object.freeze([
    entity('entity:physics-world', 'Physics World', { x: 0, y: 0, z: 0 }, [component('haiyue.physics.world.3d', { gravity: { x: 0, y: 0, z: 0 }, loadTimeoutMs: 100 })]),
  ]);
}
