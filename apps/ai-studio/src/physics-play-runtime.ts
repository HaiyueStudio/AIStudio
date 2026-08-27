import { CartesianTransform3D, Entity, type World } from '@haiyue/engine';
import { Transform2D } from '@haiyue/engine/components';
import {
  Physics2DBody,
  Physics2DJoint,
  Physics2DSystem,
  Physics2DTo3DTransformSync,
  Physics2DTo3DTransformSyncSystem,
  Physics3DBody,
  Physics3DJoint,
  Physics3DSystem,
  type Physics2DContactEvent,
  type Physics3DContactEvent,
} from '@haiyue/engine/physics';
import { createRapierPhysics3DBackend } from '@haiyue/engine/physics/backend';
import type { ReplayInputSnapshot, SimulationStateValue } from '@haiyue/engine/experimental/simulation';

export interface PhysicsSceneComponent {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface PhysicsSceneEntity {
  readonly id: string;
  readonly name: string;
  readonly transform: Readonly<{
    position: Readonly<{ x: number; y: number; z: number }>;
    rotationDegrees: Readonly<{ x: number; y: number; z: number }>;
    scale: Readonly<{ x: number; y: number; z: number }>;
  }>;
  readonly components?: readonly PhysicsSceneComponent[];
}

export interface PhysicsRuntimeEvent {
  readonly tick: number;
  readonly dimension: '2d' | '3d';
  readonly phase: 'enter' | 'stay' | 'exit';
  readonly kind: 'collision' | 'trigger';
  readonly entityAId: string;
  readonly entityBId: string;
}

export interface PhysicsRuntimeStatus {
  readonly state: 'ready' | 'disposed';
  readonly dimensions: readonly Readonly<{ dimension: '2d' | '3d'; backend: string; state: 'ready' }> [];
  readonly resources: Readonly<{ worlds: number; bodies: number; colliders: number; joints: number; activeContacts: number }>;
}

export interface PhysicsPlayRuntimeOptions {
  readonly world: World;
  readonly sceneEntities: readonly PhysicsSceneEntity[];
  readonly entitiesByStableId: ReadonlyMap<string, Entity>;
  readonly stableIdByEntityId: ReadonlyMap<number, string>;
  readonly tickRateHz: number;
  readonly loadRapierBackend?: typeof createRapierPhysics3DBackend;
  readonly signal?: AbortSignal;
}

interface RuntimeBody {
  readonly dimension: '2d' | '3d';
  readonly stableId: string;
  readonly entity: Entity;
  readonly body: Physics2DBody | Physics3DBody;
  readonly character: PhysicsSceneComponent | null;
  readonly groundProbe: PhysicsSceneComponent | null;
}

const MATERIAL = 'haiyue.physics.material';

/** Owns only Play runtime physics; every descriptor remains immutable authoring data. */
export class PhysicsPlayRuntime {
  private readonly bodies = new Map<string, RuntimeBody>();
  private readonly system2d: Physics2DSystem | null;
  private readonly system3d: Physics3DSystem | null;
  private readonly sync2d: Physics2DTo3DTransformSyncSystem | null;
  private eventsValue: readonly PhysicsRuntimeEvent[] = Object.freeze([]);
  private disposed = false;

  private constructor(
    private readonly options: PhysicsPlayRuntimeOptions,
    systems: Readonly<{ system2d: Physics2DSystem | null; system3d: Physics3DSystem | null; sync2d: Physics2DTo3DTransformSyncSystem | null }>,
  ) {
    this.system2d = systems.system2d;
    this.system3d = systems.system3d;
    this.sync2d = systems.sync2d;
  }

  static async create(options: PhysicsPlayRuntimeOptions): Promise<PhysicsPlayRuntime> {
    throwIfAborted(options.signal);
    const world2d = uniqueEnabledComponent(options.sceneEntities, 'haiyue.physics.world.2d');
    const world3d = uniqueEnabledComponent(options.sceneEntities, 'haiyue.physics.world.3d');
    const has2d = hasEnabledType(options.sceneEntities, 'haiyue.physics.rigidbody.2d') || hasEnabledType(options.sceneEntities, 'haiyue.physics.collider.2d') || hasEnabledType(options.sceneEntities, 'haiyue.physics.joint.2d');
    const has3d = hasEnabledType(options.sceneEntities, 'haiyue.physics.rigidbody.3d') || hasEnabledType(options.sceneEntities, 'haiyue.physics.collider.3d') || hasEnabledType(options.sceneEntities, 'haiyue.physics.joint.3d');
    if (has2d && !world2d) throw new Error('physics.capability-missing: 2D physics components require one enabled haiyue.physics.world.2d descriptor.');
    if (has3d && !world3d) throw new Error('physics.capability-missing: 3D physics components require one enabled haiyue.physics.world.3d descriptor.');

    let system2d: Physics2DSystem | null = null;
    let system3d: Physics3DSystem | null = null;
    let sync2d: Physics2DTo3DTransformSyncSystem | null = null;
    if (world2d) {
      const value = world2d.value;
      if (value.backend !== 'box2d') throw new Error(`physics.backend-unsupported: ${String(value.backend)}.`);
      const gravity = vec2(value.gravity, 'physics world 2D gravity');
      system2d = new Physics2DSystem({
        gravity: [gravity.x, gravity.y], pixelsPerMeter: finite(value.pixelsPerMeter, 0.001, 100_000, 'pixelsPerMeter'),
        fixedTimeStep: 1 / options.tickRateHz, maxSubSteps: 1,
        velocityIterations: integer(value.velocityIterations, 1, 64, 'velocityIterations'), positionIterations: integer(value.positionIterations, 1, 64, 'positionIterations'), priority: -200,
      });
      sync2d = new Physics2DTo3DTransformSyncSystem({ priority: -190 });
    }
    if (world3d) {
      try {
        const value = world3d.value;
        if (value.backend !== 'rapier3d') throw new Error(`physics.backend-unsupported: ${String(value.backend)}.`);
        const timeoutMs = integer(value.loadTimeoutMs, 100, 60_000, 'loadTimeoutMs');
        const backend = await withTimeout((options.loadRapierBackend ?? createRapierPhysics3DBackend)(), timeoutMs, 'physics.backend-load-timeout', options.signal);
        throwIfAborted(options.signal);
        const gravity = vec3(value.gravity, 'physics world 3D gravity');
        system3d = new Physics3DSystem({ backend, gravity: [gravity.x, gravity.y, gravity.z], fixedTimeStep: 1 / options.tickRateHz, maxSubSteps: 1, solverIterations: integer(value.solverIterations, 1, 64, 'solverIterations'), priority: -200 });
      } catch (cause) {
        cleanupSystem(options.world, sync2d);
        cleanupSystem(options.world, system2d);
        throw cause;
      }
    }

    throwIfAborted(options.signal);
    const runtime = new PhysicsPlayRuntime(options, { system2d, system3d, sync2d });
    try {
      runtime.installBodies();
      runtime.installJoints();
      if (system2d) options.world.addSystem(system2d);
      if (system3d) options.world.addSystem(system3d);
      if (sync2d) options.world.addSystem(sync2d);
      // Synchronize descriptors and create opaque backend resources without advancing time.
      system2d?.update(options.world, 0, 0);
      system3d?.update(options.world, 0, 0);
      runtime.applyInitialVelocities();
      return runtime;
    } catch (cause) {
      runtime.dispose();
      throw cause;
    }
  }

  beforeTick(input: ReplayInputSnapshot, deltaMs: number): void {
    this.assertReady();
    for (const runtime of this.bodies.values()) {
      if (!runtime.character) continue;
      const descriptor = runtime.character.value;
      const grounded = this.grounded(runtime.stableId);
      const control = grounded ? 1 : finite(descriptor.airControl, 0, 1, 'airControl');
      const acceleration = finite(descriptor.acceleration, 0, 100_000, 'acceleration') * control * deltaMs / 1_000;
      const maxSpeed = finite(descriptor.maxSpeed, 0, 100_000, 'maxSpeed');
      const moveX = inputValue(input, stringValue(descriptor.moveActionX, 'moveActionX'));
      const moveY = inputValue(input, stringValue(descriptor.moveActionY, 'moveActionY'));
      const jump = input.actions.find(candidate => candidate.action === descriptor.jumpAction)?.down === true;
      if (runtime.dimension === '2d' && this.system2d && runtime.body instanceof Physics2DBody) {
        const velocity = { x: 0, y: 0 };
        if (!this.system2d.getLinearVelocity(runtime.body, velocity)) continue;
        velocity.x = approach(velocity.x, moveX * maxSpeed, acceleration);
        if (moveY) velocity.y = approach(velocity.y, moveY * maxSpeed, acceleration);
        this.system2d.setLinearVelocity(runtime.body, velocity.x, velocity.y);
        if (jump && grounded) this.system2d.applyLinearImpulse(runtime.body, 0, finite(descriptor.jumpImpulse, 0, 100_000_000, 'jumpImpulse'));
      } else if (runtime.dimension === '3d' && this.system3d && runtime.body instanceof Physics3DBody) {
        const velocity = { x: 0, y: 0, z: 0 };
        if (!this.system3d.getLinearVelocity(runtime.body, velocity)) continue;
        velocity.x = approach(velocity.x, moveX * maxSpeed, acceleration);
        velocity.z = approach(velocity.z, moveY * maxSpeed, acceleration);
        this.system3d.setLinearVelocity(runtime.body, velocity.x, velocity.y, velocity.z);
        if (jump && grounded) this.system3d.applyLinearImpulse(runtime.body, 0, finite(descriptor.jumpImpulse, 0, 100_000_000, 'jumpImpulse'), 0);
      }
    }
  }

  afterTick(tick: number): void {
    this.assertReady();
    const maximum = Math.max(
      enabledWorldEventBudget(this.options.sceneEntities, 'haiyue.physics.world.2d'),
      enabledWorldEventBudget(this.options.sceneEntities, 'haiyue.physics.world.3d'),
    );
    const output: PhysicsRuntimeEvent[] = [];
    if (this.system2d) output.push(...this.system2d.events().map(event => this.projectEvent(tick, '2d', event)));
    if (this.system3d) output.push(...this.system3d.events().map(event => this.projectEvent(tick, '3d', event)));
    output.sort((left, right) => left.dimension.localeCompare(right.dimension) || left.entityAId.localeCompare(right.entityAId) || left.entityBId.localeCompare(right.entityBId) || phaseOrder(left.phase) - phaseOrder(right.phase));
    this.eventsValue = Object.freeze(output.slice(0, maximum));
  }

  events(): readonly PhysicsRuntimeEvent[] { return this.eventsValue; }

  status(): PhysicsRuntimeStatus {
    const snapshots = [this.system2d?.resourceSnapshot(), this.system3d?.resourceSnapshot()].filter(Boolean);
    return Object.freeze({
      state: this.disposed ? 'disposed' : 'ready',
      dimensions: Object.freeze([
        ...(this.system2d ? [{ dimension: '2d' as const, backend: this.system2d.backendId, state: 'ready' as const }] : []),
        ...(this.system3d ? [{ dimension: '3d' as const, backend: this.system3d.backendId, state: 'ready' as const }] : []),
      ]),
      resources: Object.freeze({
        worlds: this.disposed ? 0 : snapshots.length,
        bodies: snapshots.reduce((sum, item) => sum + (item?.bodies ?? 0), 0),
        colliders: snapshots.reduce((sum, item) => sum + (item?.colliders ?? 0), 0),
        joints: snapshots.reduce((sum, item) => sum + (item?.joints ?? 0), 0),
        activeContacts: snapshots.reduce((sum, item) => sum + (item?.activeContacts ?? 0), 0),
      }),
    });
  }

  state(): SimulationStateValue {
    return Object.freeze({
      status: this.status() as unknown as SimulationStateValue,
      bodies: Object.freeze([...this.bodies.values()].sort((left, right) => left.stableId.localeCompare(right.stableId)).map(runtime => this.bodySnapshot(runtime) as unknown as SimulationStateValue)),
      events: this.eventsValue as unknown as SimulationStateValue,
    });
  }

  api(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      status: () => this.status(),
      body: (target?: Entity | number | string) => this.bodySnapshot(this.resolveBody(target)),
      getMass: (target?: Entity | number | string) => this.bodySnapshot(this.resolveBody(target)).mass,
      getVelocity: (target?: Entity | number | string) => this.bodySnapshot(this.resolveBody(target)).velocity,
      events: () => this.events(),
      grounded: (target?: Entity | number | string) => this.grounded(this.resolveBody(target).stableId),
      setVelocity: (target: Entity | number | string, velocity: unknown) => this.setVelocity(this.resolveBody(target), velocity),
      setAngularVelocity: (target: Entity | number | string, velocity: unknown) => this.setAngularVelocity(this.resolveBody(target), velocity),
      applyForce: (target: Entity | number | string, force: unknown) => this.applyForce(this.resolveBody(target), force),
      applyImpulse: (target: Entity | number | string, impulse: unknown) => this.applyImpulse(this.resolveBody(target), impulse),
      wake: (target: Entity | number | string, awake = true) => this.wake(this.resolveBody(target), awake),
      teleport: (target: Entity | number | string, position: unknown) => this.teleport(this.resolveBody(target), position),
      stop: (target: Entity | number | string) => this.stopBody(this.resolveBody(target)),
      hitTest: (point: unknown) => this.hitTest(point),
      raycast: (dimension: '2d' | '3d', origin: unknown, direction: unknown, maxDistance?: number) => this.raycast(dimension, origin, direction, maxDistance),
      overlap: (dimension: '2d' | '3d', center: unknown, size: unknown, limit?: number) => this.overlap(dimension, center, size, limit),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.system2d) { this.options.world.removeSystem(this.system2d); this.system2d.destroy(); }
    if (this.system3d) { this.options.world.removeSystem(this.system3d); this.system3d.destroy(); }
    if (this.sync2d) { this.options.world.removeSystem(this.sync2d); this.sync2d.destroy(); }
    this.bodies.clear();
    this.eventsValue = Object.freeze([]);
  }

  private installBodies(): void {
    for (const source of this.options.sceneEntities) {
      const rigid2d = enabledComponent(source, 'haiyue.physics.rigidbody.2d');
      const collider2d = enabledComponent(source, 'haiyue.physics.collider.2d');
      const rigid3d = enabledComponent(source, 'haiyue.physics.rigidbody.3d');
      const collider3d = enabledComponent(source, 'haiyue.physics.collider.3d');
      if (Boolean(rigid2d) !== Boolean(collider2d)) throw new Error(`physics.component-pair-missing: ${source.id} requires both 2D rigidbody and collider.`);
      if (Boolean(rigid3d) !== Boolean(collider3d)) throw new Error(`physics.component-pair-missing: ${source.id} requires both 3D rigidbody and collider.`);
      if (rigid2d && rigid3d) throw new Error(`physics.dimension-conflict: ${source.id} cannot own 2D and 3D rigid bodies.`);
      const entity = this.options.entitiesByStableId.get(source.id);
      if (!entity) throw new Error(`physics.stale-entity: ${source.id}.`);
      const character = enabledComponent(source, 'haiyue.gameplay.character') ?? null;
      const groundProbe = enabledComponent(source, 'haiyue.gameplay.ground-probe') ?? null;
      if (rigid2d && collider2d) this.install2dBody(source, entity, rigid2d, collider2d, character, groundProbe);
      if (rigid3d && collider3d) this.install3dBody(source, entity, rigid3d, collider3d, character, groundProbe);
    }
  }

  private install2dBody(source: PhysicsSceneEntity, entity: Entity, rigid: PhysicsSceneComponent, collider: PhysicsSceneComponent, character: PhysicsSceneComponent | null, groundProbe: PhysicsSceneComponent | null): void {
    if (!this.system2d) throw new Error('physics.capability-missing: Box2D world is unavailable.');
    const scale = source.transform.scale;
    if (collider.value.shape === 'circle' && Math.abs(scale.x - scale.y) > 1e-6) throw new Error(`physics.invalid-scale: circle ${source.id} requires uniform x/y scale.`);
    const size = vec2(collider.value.size, 'collider 2D size');
    const material = this.material(collider.value.materialEntityId);
    const transform = new Transform2D({ x: source.transform.position.x, y: source.transform.position.y, rotation: source.transform.rotationDegrees.z * Math.PI / 180 });
    entity.addComponent(transform);
    entity.addComponent(new Physics2DTo3DTransformSync({ plane: 'xy', fixedAxisValue: source.transform.position.z, syncRotation: true, rotationAxis: 'z' }));
    const body = new Physics2DBody({
      type: enumValue(rigid.value.type, ['static', 'dynamic', 'kinematic'], 'rigidbody 2D type'), shape: enumValue(collider.value.shape, ['box', 'circle'], 'collider 2D shape'),
      width: size.x * scale.x, height: size.y * scale.y, radius: finite(collider.value.radius, 0.000001, 100_000, 'radius') * scale.x,
      density: finite(collider.value.density, 0, 100_000, 'density'), friction: material.friction, restitution: material.restitution,
      fixedRotation: boolean(rigid.value.fixedRotation, 'fixedRotation'), linearDamping: finite(rigid.value.linearDamping, 0, 1_000, 'linearDamping'), angularDamping: finite(rigid.value.angularDamping, 0, 1_000, 'angularDamping'),
      bullet: boolean(rigid.value.bullet, 'bullet'), allowSleep: boolean(rigid.value.allowSleep, 'allowSleep'), isSensor: boolean(collider.value.trigger, 'trigger'),
      categoryBits: integer(collider.value.categoryBits, 1, 65_535, 'categoryBits'), maskBits: integer(collider.value.maskBits, 0, 65_535, 'maskBits'), groupIndex: integer(collider.value.groupIndex, -32_768, 32_767, 'groupIndex'), syncTransform: boolean(rigid.value.syncTransform, 'syncTransform'),
    });
    entity.addComponent(body);
    this.bodies.set(source.id, Object.freeze({ dimension: '2d', stableId: source.id, entity, body, character, groundProbe }));
  }

  private install3dBody(source: PhysicsSceneEntity, entity: Entity, rigid: PhysicsSceneComponent, collider: PhysicsSceneComponent, character: PhysicsSceneComponent | null, groundProbe: PhysicsSceneComponent | null): void {
    if (!this.system3d) throw new Error('physics.capability-missing: Rapier world is unavailable.');
    const scale = source.transform.scale;
    const shape = enumValue(collider.value.shape, ['box', 'sphere', 'capsule', 'cylinder'], 'collider 3D shape');
    if (shape === 'sphere' && (Math.abs(scale.x - scale.y) > 1e-6 || Math.abs(scale.x - scale.z) > 1e-6)) throw new Error(`physics.invalid-scale: sphere ${source.id} requires uniform scale.`);
    if ((shape === 'capsule' || shape === 'cylinder') && Math.abs(scale.x - scale.z) > 1e-6) throw new Error(`physics.invalid-scale: ${shape} ${source.id} requires uniform x/z scale.`);
    const size = vec3(collider.value.size, 'collider 3D size');
    const material = this.material(collider.value.materialEntityId);
    const body = new Physics3DBody({
      type: enumValue(rigid.value.type, ['static', 'dynamic', 'kinematic'], 'rigidbody 3D type'), shape,
      width: size.x * scale.x, height: size.y * scale.y, depth: size.z * scale.z, radius: finite(collider.value.radius, 0.000001, 100_000, 'radius') * scale.x, halfHeight: finite(collider.value.halfHeight, 0, 100_000, 'halfHeight') * scale.y,
      density: finite(collider.value.density, 0, 100_000, 'density'), friction: material.friction, restitution: material.restitution,
      linearDamping: finite(rigid.value.linearDamping, 0, 1_000, 'linearDamping'), angularDamping: finite(rigid.value.angularDamping, 0, 1_000, 'angularDamping'), gravityScale: finite(rigid.value.gravityScale, -100, 100, 'gravityScale'),
      ccd: boolean(rigid.value.ccd, 'ccd'), allowSleep: boolean(rigid.value.allowSleep, 'allowSleep'), isSensor: boolean(collider.value.trigger, 'trigger'), categoryBits: integer(collider.value.categoryBits, 1, 65_535, 'categoryBits'), maskBits: integer(collider.value.maskBits, 0, 65_535, 'maskBits'),
      lockTranslations: bool3(rigid.value.lockTranslations, 'lockTranslations'), lockRotations: bool3(rigid.value.lockRotations, 'lockRotations'), syncTransform: boolean(rigid.value.syncTransform, 'syncTransform'),
    });
    entity.addComponent(body);
    this.bodies.set(source.id, Object.freeze({ dimension: '3d', stableId: source.id, entity, body, character, groundProbe }));
  }

  private installJoints(): void {
    for (const source of this.options.sceneEntities) {
      const owner = this.options.entitiesByStableId.get(source.id);
      if (!owner) throw new Error(`physics.stale-entity: ${source.id}.`);
      const joint2d = enabledComponent(source, 'haiyue.physics.joint.2d');
      if (joint2d) {
        const bodyA = this.requireJointBody(joint2d.value.bodyAEntityId, '2d');
        const bodyB = this.requireJointBody(joint2d.value.bodyBEntityId, '2d');
        const anchor = vec2(joint2d.value.anchor, 'joint 2D anchor'), anchorA = vec2(joint2d.value.anchorA, 'joint 2D anchorA'), anchorB = vec2(joint2d.value.anchorB, 'joint 2D anchorB');
        const limits = numberPair(joint2d.value.limits, 'joint 2D limits');
        owner.addComponent(new Physics2DJoint({ type: enumValue(joint2d.value.type, ['revolute', 'distance'], 'joint 2D type'), bodyA: bodyA.entity, bodyB: bodyB.entity, anchor: [anchor.x, anchor.y], anchorA: [anchorA.x, anchorA.y], anchorB: [anchorB.x, anchorB.y], collideConnected: boolean(joint2d.value.collideConnected, 'collideConnected'), enableLimit: boolean(joint2d.value.enableLimit, 'enableLimit'), lowerAngle: limits[0], upperAngle: limits[1], enableMotor: boolean(joint2d.value.enableMotor, 'enableMotor'), motorSpeed: finite(joint2d.value.motorSpeed, -100_000, 100_000, 'motorSpeed'), maxMotorTorque: finite(joint2d.value.maxMotorTorque, 0, 100_000_000, 'maxMotorTorque'), length: finite(joint2d.value.length, 0, 100_000, 'length'), frequencyHz: finite(joint2d.value.frequencyHz, 0, 10_000, 'frequencyHz'), dampingRatio: finite(joint2d.value.dampingRatio, 0, 1, 'dampingRatio') }));
      }
      const joint3d = enabledComponent(source, 'haiyue.physics.joint.3d');
      if (joint3d) {
        const bodyA = this.requireJointBody(joint3d.value.bodyAEntityId, '3d');
        const bodyB = this.requireJointBody(joint3d.value.bodyBEntityId, '3d');
        const anchorA = vec3(joint3d.value.anchorA, 'joint 3D anchorA'), anchorB = vec3(joint3d.value.anchorB, 'joint 3D anchorB'), axis = vec3(joint3d.value.axis, 'joint 3D axis');
        owner.addComponent(new Physics3DJoint({ type: enumValue(joint3d.value.type, ['fixed', 'spherical', 'revolute', 'prismatic', 'spring', 'rope'], 'joint 3D type'), bodyA: bodyA.entity, bodyB: bodyB.entity, anchorA: [anchorA.x, anchorA.y, anchorA.z], anchorB: [anchorB.x, anchorB.y, anchorB.z], axis: [axis.x, axis.y, axis.z], collideConnected: boolean(joint3d.value.collideConnected, 'collideConnected'), limits: numberPair(joint3d.value.limits, 'joint 3D limits'), restLength: finite(joint3d.value.restLength, 0, 100_000, 'restLength'), maxLength: finite(joint3d.value.maxLength, 0, 100_000, 'maxLength'), stiffness: finite(joint3d.value.stiffness, 0, 100_000_000, 'stiffness'), damping: finite(joint3d.value.damping, 0, 100_000_000, 'damping') }));
      }
    }
  }

  private applyInitialVelocities(): void {
    for (const source of this.options.sceneEntities) {
      const runtime = this.bodies.get(source.id);
      if (!runtime) continue;
      const rigid = enabledComponent(source, runtime.dimension === '2d' ? 'haiyue.physics.rigidbody.2d' : 'haiyue.physics.rigidbody.3d');
      if (!rigid) continue;
      this.setVelocity(runtime, rigid.value.initialVelocity);
      this.setAngularVelocity(runtime, rigid.value.initialAngularVelocity);
    }
  }

  private material(reference: unknown): Readonly<{ friction: number; restitution: number }> {
    if (typeof reference !== 'string' || reference.startsWith('entity:unbound')) return Object.freeze({ friction: 0.5, restitution: 0.1 });
    const source = this.options.sceneEntities.find(candidate => candidate.id === reference);
    if (!source) throw new Error(`physics.stale-entity: material entity ${reference}.`);
    const component = enabledComponent(source, MATERIAL);
    if (!component) throw new Error(`physics.material-missing: ${reference}.`);
    return Object.freeze({ friction: finite(component.value.friction, 0, 10, 'friction'), restitution: finite(component.value.restitution, 0, 1, 'restitution') });
  }

  private requireJointBody(reference: unknown, dimension: '2d' | '3d'): RuntimeBody {
    const id = stringValue(reference, 'joint target');
    const body = this.bodies.get(id);
    if (!body) throw new Error(`physics.stale-entity: joint target ${id}.`);
    if (body.dimension !== dimension) throw new Error(`physics.joint-dimension-mismatch: ${id}.`);
    return body;
  }

  private projectEvent(tick: number, dimension: '2d' | '3d', event: Physics2DContactEvent | Physics3DContactEvent): PhysicsRuntimeEvent {
    const entityAId = this.options.stableIdByEntityId.get(event.entityA.id);
    const entityBId = this.options.stableIdByEntityId.get(event.entityB.id);
    if (!entityAId || !entityBId) throw new Error('physics.stale-entity: contact event cannot be projected.');
    return Object.freeze({ tick, dimension, phase: event.phase, kind: event.kind, entityAId, entityBId });
  }

  private resolveBody(target?: Entity | number | string): RuntimeBody {
    if (target === undefined) {
      const first = this.bodies.values().next().value as RuntimeBody | undefined;
      if (!first) throw new Error('physics.body-missing: no runtime body exists.');
      return first;
    }
    const stableId = typeof target === 'string' ? target : target instanceof Entity ? this.options.stableIdByEntityId.get(target.id) : this.options.stableIdByEntityId.get(target);
    const body = stableId ? this.bodies.get(stableId) : undefined;
    if (!body) throw new Error(`physics.body-missing: ${String(target)}.`);
    return body;
  }

  private bodySnapshot(runtime: RuntimeBody): Readonly<Record<string, unknown>> {
    if (runtime.dimension === '2d' && this.system2d && runtime.body instanceof Physics2DBody) {
      const velocity = { x: 0, y: 0 };
      this.system2d.getLinearVelocity(runtime.body, velocity);
      return Object.freeze({ entityId: runtime.stableId, dimension: '2d', mass: this.system2d.getBodyMass(runtime.body), velocity: Object.freeze(velocity), angularVelocity: this.system2d.getAngularVelocity(runtime.body), awake: true, grounded: this.grounded(runtime.stableId) });
    }
    if (runtime.dimension === '3d' && this.system3d && runtime.body instanceof Physics3DBody) {
      const velocity = { x: 0, y: 0, z: 0 }, angularVelocity = { x: 0, y: 0, z: 0 };
      this.system3d.getLinearVelocity(runtime.body, velocity); this.system3d.getAngularVelocity(runtime.body, angularVelocity);
      return Object.freeze({ entityId: runtime.stableId, dimension: '3d', mass: this.system3d.getBodyMass(runtime.body), velocity: Object.freeze(velocity), angularVelocity: Object.freeze(angularVelocity), awake: true, grounded: this.grounded(runtime.stableId) });
    }
    throw new Error(`physics.body-unavailable: ${runtime.stableId}.`);
  }

  private grounded(stableId: string): boolean {
    const runtime = this.bodies.get(stableId);
    if (!runtime?.groundProbe) return false;
    const probe = runtime.groundProbe.value;
    const transform = runtime.entity.getComponent(CartesianTransform3D);
    if (!transform) return false;
    const direction = vec3(probe.direction, 'ground probe direction');
    const distance = finite(probe.distance, 0.000001, 100_000, 'ground probe distance');
    const radius = finite(probe.radius, 0, 100_000, 'ground probe radius');
    const maskBits = integer(probe.maskBits, 0, 65_535, 'ground probe maskBits');
    if (runtime.dimension === '3d' && this.system3d) {
      const center: [number, number, number] = [transform.position[0] + direction.x * distance, transform.position[1] + direction.y * distance, transform.position[2] + direction.z * distance];
      return this.system3d.queryShape({ type: 'sphere', position: center, radius: Math.max(radius, 0.0001) }, { maskBits, limit: 16 }).some(entity => entity !== runtime.entity);
    }
    if (runtime.dimension === '2d' && this.system2d) {
      const x = transform.position[0] + direction.x * distance, y = transform.position[1] + direction.y * distance;
      return this.system2d.queryAabb([x - radius, y - radius], [x + radius, y + radius], { maskBits, limit: 16 }).some(entity => entity !== runtime.entity);
    }
    return false;
  }

  private setVelocity(runtime: RuntimeBody, value: unknown): boolean {
    if (runtime.dimension === '2d' && this.system2d && runtime.body instanceof Physics2DBody) { const vector = vec2(value, 'velocity'); return this.system2d.setLinearVelocity(runtime.body, vector.x, vector.y); }
    if (runtime.dimension === '3d' && this.system3d && runtime.body instanceof Physics3DBody) { const vector = vec3(value, 'velocity'); return this.system3d.setLinearVelocity(runtime.body, vector.x, vector.y, vector.z); }
    return false;
  }
  private setAngularVelocity(runtime: RuntimeBody, value: unknown): boolean {
    if (runtime.dimension === '2d' && this.system2d && runtime.body instanceof Physics2DBody) return this.system2d.setAngularVelocity(runtime.body, finite(value, -100_000, 100_000, 'angular velocity'));
    if (runtime.dimension === '3d' && this.system3d && runtime.body instanceof Physics3DBody) { const vector = vec3(value, 'angular velocity'); return this.system3d.setAngularVelocity(runtime.body, vector.x, vector.y, vector.z); }
    return false;
  }
  private applyForce(runtime: RuntimeBody, value: unknown): boolean {
    if (runtime.dimension === '2d' && this.system2d && runtime.body instanceof Physics2DBody) { const vector = vec2(value, 'force'); return this.system2d.applyForce(runtime.body, vector.x, vector.y); }
    if (runtime.dimension === '3d' && this.system3d && runtime.body instanceof Physics3DBody) { const vector = vec3(value, 'force'); return this.system3d.applyForce(runtime.body, vector.x, vector.y, vector.z); }
    return false;
  }
  private applyImpulse(runtime: RuntimeBody, value: unknown): boolean {
    if (runtime.dimension === '2d' && this.system2d && runtime.body instanceof Physics2DBody) { const vector = vec2(value, 'impulse'); return this.system2d.applyLinearImpulse(runtime.body, vector.x, vector.y); }
    if (runtime.dimension === '3d' && this.system3d && runtime.body instanceof Physics3DBody) { const vector = vec3(value, 'impulse'); return this.system3d.applyLinearImpulse(runtime.body, vector.x, vector.y, vector.z); }
    return false;
  }
  private wake(runtime: RuntimeBody, awake: unknown): boolean {
    const value = boolean(awake, 'awake');
    if (runtime.dimension === '2d' && this.system2d && runtime.body instanceof Physics2DBody) return this.system2d.setBodyAwake(runtime.body, value);
    if (runtime.dimension === '3d' && this.system3d && runtime.body instanceof Physics3DBody) return this.system3d.setBodyAwake(runtime.body, value);
    return false;
  }
  private teleport(runtime: RuntimeBody, value: unknown): boolean {
    if (runtime.dimension === '2d' && this.system2d && runtime.body instanceof Physics2DBody) { const position = vec2(value, 'position'); return this.system2d.teleportBody(runtime.body, position.x, position.y); }
    if (runtime.dimension === '3d' && this.system3d && runtime.body instanceof Physics3DBody) { const position = vec3(value, 'position'); return this.system3d.teleportBody(runtime.body, [position.x, position.y, position.z]); }
    return false;
  }
  private stopBody(runtime: RuntimeBody): boolean {
    return runtime.dimension === '2d' ? this.setVelocity(runtime, { x: 0, y: 0 }) && this.setAngularVelocity(runtime, 0) : this.setVelocity(runtime, { x: 0, y: 0, z: 0 }) && this.setAngularVelocity(runtime, { x: 0, y: 0, z: 0 });
  }
  private hitTest(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!this.system2d) throw new Error('physics.capability-missing: 2d.');
    const point = vec2(value, 'point');
    const entity = this.system2d.hitTest(this.options.world, point.x, point.y);
    return entity ? Object.freeze({ entityId: this.stableId(entity) }) : null;
  }
  private raycast(dimension: '2d' | '3d', origin: unknown, direction: unknown, maximum = 1_000): Readonly<Record<string, unknown>> | null {
    const maxDistance = finite(maximum, 0.000001, 1_000_000, 'maxDistance');
    if (dimension === '2d' && this.system2d) { const from = vec2(origin, 'origin'), vector = vec2(direction, 'direction'), hit = this.system2d.castRay([from.x, from.y], [vector.x, vector.y], maxDistance); return hit ? Object.freeze({ entityId: this.stableId(hit.entity), distance: hit.distance, point: hit.point, normal: hit.normal }) : null; }
    if (dimension === '3d' && this.system3d) { const from = vec3(origin, 'origin'), vector = vec3(direction, 'direction'), hit = this.system3d.castRay([from.x, from.y, from.z], [vector.x, vector.y, vector.z], maxDistance); return hit ? Object.freeze({ entityId: this.stableId(hit.entity), distance: hit.distance, point: Object.freeze(hit.point), normal: Object.freeze(hit.normal) }) : null; }
    throw new Error(`physics.capability-missing: ${dimension}.`);
  }
  private overlap(dimension: '2d' | '3d', center: unknown, size: unknown, maximum = 256): readonly string[] {
    const limit = integer(maximum, 1, 1_000, 'limit');
    if (dimension === '2d' && this.system2d) { const point = vec2(center, 'center'), extent = vec2(size, 'size'); return Object.freeze(this.system2d.queryAabb([point.x - extent.x / 2, point.y - extent.y / 2], [point.x + extent.x / 2, point.y + extent.y / 2], { limit }).map(entity => this.stableId(entity))); }
    if (dimension === '3d' && this.system3d) { const point = vec3(center, 'center'), extent = vec3(size, 'size'); return Object.freeze(this.system3d.queryShape({ type: 'box', position: [point.x, point.y, point.z], width: extent.x, height: extent.y, depth: extent.z }, { limit }).map(entity => this.stableId(entity))); }
    throw new Error(`physics.capability-missing: ${dimension}.`);
  }
  private stableId(entity: Entity): string { const id = this.options.stableIdByEntityId.get(entity.id); if (!id) throw new Error(`physics.stale-entity: runtime entity ${entity.id}.`); return id; }
  private assertReady(): void { if (this.disposed) throw new Error('physics.runtime-disposed'); }
}

function uniqueEnabledComponent(entities: readonly PhysicsSceneEntity[], type: string): PhysicsSceneComponent | null {
  const matches = entities.flatMap(entity => entity.components?.filter(component => component.enabled && component.type === type) ?? []);
  if (matches.length > 1) throw new Error(`physics.world-duplicate: ${type}.`);
  return matches[0] ?? null;
}
function hasEnabledType(entities: readonly PhysicsSceneEntity[], type: string): boolean { return entities.some(entity => enabledComponent(entity, type)); }
function enabledComponent(entity: PhysicsSceneEntity, type: string): PhysicsSceneComponent | undefined { return entity.components?.find(component => component.enabled && component.type === type); }
function enabledWorldEventBudget(entities: readonly PhysicsSceneEntity[], type: string): number { const world = uniqueEnabledComponent(entities, type); return world ? integer(world.value.maxEventsPerTick, 1, 1_024, 'maxEventsPerTick') : 0; }
function inputValue(input: ReplayInputSnapshot, action: string): number { return input.actions.find(candidate => candidate.action === action)?.value ?? 0; }
function approach(value: number, target: number, maximumDelta: number): number { return value < target ? Math.min(target, value + maximumDelta) : Math.max(target, value - maximumDelta); }
function phaseOrder(value: PhysicsRuntimeEvent['phase']): number { return value === 'enter' ? 0 : value === 'stay' ? 1 : 2; }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${code}: exceeded ${timeoutMs}ms.`)), timeoutMs); }),
      new Promise<never>((_, reject) => { abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('physics.backend-load-cancelled')); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('physics.runtime-cancelled'); }
function cleanupSystem(world: World, system: { destroy(): unknown } | null): void { if (!system) return; world.removeSystem(system as never); system.destroy(); }
function finite(value: unknown, minimum: number, maximum: number, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`physics.descriptor-invalid: ${label}.`); return value; }
function integer(value: unknown, minimum: number, maximum: number, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`physics.descriptor-invalid: ${label}.`); return Number(value); }
function boolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new Error(`physics.descriptor-invalid: ${label}.`); return value; }
function stringValue(value: unknown, label: string): string { if (typeof value !== 'string' || !value) throw new Error(`physics.descriptor-invalid: ${label}.`); return value; }
function enumValue<const T extends string>(value: unknown, allowed: readonly T[], label: string): T { if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`physics.descriptor-invalid: ${label}.`); return value as T; }
function vec2(value: unknown, label: string): Readonly<{ x: number; y: number }> { if (!isRecord(value)) throw new Error(`physics.descriptor-invalid: ${label}.`); return Object.freeze({ x: finite(value.x, -1e12, 1e12, `${label}.x`), y: finite(value.y, -1e12, 1e12, `${label}.y`) }); }
function vec3(value: unknown, label: string): Readonly<{ x: number; y: number; z: number }> { if (!isRecord(value)) throw new Error(`physics.descriptor-invalid: ${label}.`); return Object.freeze({ x: finite(value.x, -1e12, 1e12, `${label}.x`), y: finite(value.y, -1e12, 1e12, `${label}.y`), z: finite(value.z, -1e12, 1e12, `${label}.z`) }); }
function bool3(value: unknown, label: string): [boolean, boolean, boolean] { if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== 'boolean')) throw new Error(`physics.descriptor-invalid: ${label}.`); return [value[0] as boolean, value[1] as boolean, value[2] as boolean]; }
function numberPair(value: unknown, label: string): [number, number] { if (!Array.isArray(value) || value.length !== 2) throw new Error(`physics.descriptor-invalid: ${label}.`); return [finite(value[0], -1e12, 1e12, `${label}[0]`), finite(value[1], -1e12, 1e12, `${label}[1]`)]; }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
