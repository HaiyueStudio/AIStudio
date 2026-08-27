import test from 'node:test';
import assert from 'node:assert/strict';
import { CartesianTransform3D, Entity, World } from '@haiyue/engine';
import { PhysicsPlayRuntime } from '../dist/physics-play-runtime.js';
import { PlaySimulation } from '../dist/play-simulation.js';
import { backendFailureFixture, jointFixture, platformerFixture, racingFixture, shooterFixture, staleJointFixture } from './fixtures/g07-physics-fixtures.mjs';

async function runFixture(fixture) {
  const authoringBefore = JSON.stringify(fixture);
  const world = new World(fixture.id);
  const entitiesByStableId = new Map();
  const stableIdByEntityId = new Map();
  for (const source of fixture.entities) {
    const entity = new Entity(source.name);
    const position = source.transform.position, rotation = source.transform.rotationDegrees, scale = source.transform.scale;
    entity.addComponent(new CartesianTransform3D({
      position: [position.x, position.y, position.z],
      rotation: [rotation.x * Math.PI / 180, rotation.y * Math.PI / 180, rotation.z * Math.PI / 180],
      scale: [scale.x, scale.y, scale.z],
    }));
    world.addEntity(entity);
    entitiesByStableId.set(source.id, entity);
    stableIdByEntityId.set(entity.id, source.id);
  }
  const runtime = await PhysicsPlayRuntime.create({ world, sceneEntities: fixture.entities, entitiesByStableId, stableIdByEntityId, tickRateHz: 60 });
  const physicsApi = runtime.api();
  const initialPhysics = { masses: {} };
  for (const source of fixture.entities) {
    try { initialPhysics.masses[source.id] = physicsApi.getMass(source.id); } catch { /* Descriptor-only entities do not own bodies. */ }
  }
  if (fixture.id === 'g07-racing') {
    initialPhysics.hit = physicsApi.hitTest({ x: 4, y: 0 });
    initialPhysics.ray = physicsApi.raycast('2d', { x: -2, y: 0 }, { x: 1, y: 0 }, 10);
    initialPhysics.overlap = physicsApi.overlap('2d', { x: 4, y: 0 }, { x: 2, y: 2 });
  }
  const events = [];
  const y = [];
  const simulation = new PlaySimulation({
    tickRateHz: 60, maxSubSteps: fixture.ticks, seed: fixture.seed,
    onTick: (step, input) => {
      runtime.beforeTick(input, step.deltaMs);
      world.update(step.timeMs, step.deltaMs);
      runtime.afterTick(step.tick);
      events.push(...runtime.events());
      y.push(entitiesByStableId.get('entity:player')?.getComponent(CartesianTransform3D)?.position[1] ?? null);
    },
    readState: () => ({
      physics: runtime.state(),
      transforms: [...entitiesByStableId].sort((left, right) => left[0].localeCompare(right[0])).map(([id, entity]) => ({ id, position: [...entity.getComponent(CartesianTransform3D).position] })),
    }),
  });
  simulation.loadReplay({ schemaVersion: 1, tickRateHz: 60, seed: fixture.seed, events: fixture.replay });
  simulation.step(fixture.ticks);
  const beforeDispose = runtime.status();
  const trace = simulation.snapshot().trace;
  runtime.dispose();
  const afterDispose = runtime.status();
  world.destroy();
  return { events, y, trace, beforeDispose, afterDispose, initialPhysics, authoringUnchanged: JSON.stringify(fixture) === authoringBefore };
}

test('seeded platformer lands, ground-probes and jumps with repeatable fixed-step hashes', async () => {
  const first = await runFixture(platformerFixture());
  const second = await runFixture(platformerFixture());
  assert.deepEqual(first.trace.map(item => item.stateHash), second.trace.map(item => item.stateHash));
  assert.ok(first.events.some(event => event.dimension === '3d' && event.kind === 'collision' && event.phase === 'enter'));
  const landedY = Math.min(...first.y.filter(Number.isFinite).slice(30, 80));
  const jumpPeakY = Math.max(...first.y.filter(Number.isFinite).slice(80));
  assert.ok(landedY < 0.6, `expected player to land near y=0.5 before jump; observed y=${landedY}`);
  assert.ok(jumpPeakY > 1.2, `expected player jump peak above y=1.2; observed y=${jumpPeakY}`);
  assert.ok(first.initialPhysics.masses['entity:player'] > 0);
  assert.equal(first.initialPhysics.masses['entity:ground'], 0);
  assert.deepEqual(
    { ...first.beforeDispose.resources, activeContacts: 0 },
    { worlds: 1, bodies: 2, colliders: 2, joints: 0, activeContacts: 0 },
  );
  assert.ok(first.beforeDispose.resources.activeContacts <= 1);
  assert.deepEqual(first.afterDispose.resources, { worlds: 0, bodies: 0, colliders: 0, joints: 0, activeContacts: 0 });
});

test('seeded racer collides with the track boundary through Box2D', async () => {
  const result = await runFixture(racingFixture());
  assert.ok(result.events.some(event => event.dimension === '2d' && event.kind === 'collision' && event.phase === 'enter'
    && [event.entityAId, event.entityBId].includes('entity:car') && [event.entityAId, event.entityBId].includes('entity:track-wall')));
  assert.ok(result.initialPhysics.masses['entity:car'] > 0);
  assert.equal(result.initialPhysics.hit.entityId, 'entity:track-wall');
  assert.equal(result.initialPhysics.ray.entityId, 'entity:car');
  assert.ok(result.initialPhysics.overlap.includes('entity:track-wall'));
  assert.ok(result.initialPhysics.overlap.every(id => id === 'entity:track-wall' || id === 'entity:car'));
  assert.equal(result.trace.length, 90);
  assert.equal(result.afterDispose.resources.bodies, 0);
});

test('seeded shooter reports a bullet trigger hit through Rapier CCD', async () => {
  const result = await runFixture(shooterFixture());
  const phases = result.events.filter(event => event.dimension === '3d' && event.kind === 'trigger'
    && [event.entityAId, event.entityBId].includes('entity:bullet') && [event.entityAId, event.entityBId].includes('entity:hit-trigger'))
    .map(event => event.phase);
  assert.ok(phases.includes('enter'));
  assert.ok(phases.includes('stay'));
  assert.ok(phases.includes('exit'));
  assert.equal(result.trace.length, 40);
});

test('stable joint references create one backend joint and release it on stop', async () => {
  const result = await runFixture(jointFixture());
  assert.equal(result.beforeDispose.resources.joints, 1);
  assert.deepEqual(result.afterDispose.resources, { worlds: 0, bodies: 0, colliders: 0, joints: 0, activeContacts: 0 });
  assert.equal(result.authoringUnchanged, true);
});

test('Play physics can stop and restart without mutating authoring data or retaining resources', async () => {
  const fixture = racingFixture();
  const first = await runFixture(fixture);
  const second = await runFixture(fixture);
  assert.equal(first.authoringUnchanged, true);
  assert.equal(second.authoringUnchanged, true);
  assert.deepEqual(first.afterDispose.resources, second.afterDispose.resources);
  assert.deepEqual(first.trace.map(item => item.stateHash), second.trace.map(item => item.stateHash));
});

test('stale joint targets fail closed and release installed systems', async () => {
  const world = new World('g07-stale-joint');
  const sceneEntities = staleJointFixture();
  const entitiesByStableId = new Map(), stableIdByEntityId = new Map();
  for (const source of sceneEntities) {
    const entity = new Entity(source.name); entity.addComponent(new CartesianTransform3D()); world.addEntity(entity);
    entitiesByStableId.set(source.id, entity); stableIdByEntityId.set(entity.id, source.id);
  }
  await assert.rejects(PhysicsPlayRuntime.create({ world, sceneEntities, entitiesByStableId, stableIdByEntityId, tickRateHz: 60 }), /physics\.stale-entity: joint target/);
  assert.equal(world.systems.size, 0);
  world.destroy();
});

test('backend load failure and cancellation never install a late physics world', async () => {
  const sceneEntities = backendFailureFixture();
  const setup = () => {
    const world = new World('g07-backend-failure');
    const entitiesByStableId = new Map(), stableIdByEntityId = new Map();
    for (const source of sceneEntities) {
      const entity = new Entity(source.name); entity.addComponent(new CartesianTransform3D()); world.addEntity(entity);
      entitiesByStableId.set(source.id, entity); stableIdByEntityId.set(entity.id, source.id);
    }
    return { world, entitiesByStableId, stableIdByEntityId };
  };
  const failed = setup();
  await assert.rejects(PhysicsPlayRuntime.create({ ...failed, sceneEntities, tickRateHz: 60, loadRapierBackend: async () => { throw new Error('wasm unavailable'); } }), /wasm unavailable/);
  assert.equal(failed.world.systems.size, 0);
  failed.world.destroy();

  const late = setup();
  let resolveBackend;
  const deferred = new Promise(resolve => { resolveBackend = resolve; });
  const controller = new AbortController();
  const start = PhysicsPlayRuntime.create({ ...late, sceneEntities, tickRateHz: 60, loadRapierBackend: () => deferred, signal: controller.signal });
  controller.abort(new Error('user stopped Play'));
  await assert.rejects(start, /user stopped Play/);
  assert.equal(late.world.systems.size, 0);
  resolveBackend?.(null);
  await Promise.resolve();
  assert.equal(late.world.systems.size, 0);
  late.world.destroy();
});
