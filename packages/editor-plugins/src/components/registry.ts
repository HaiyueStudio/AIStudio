import {
  asStableId,
  createStudioServiceToken,
  type ComponentDefinitionV2,
  type GameComponentInstanceV2,
  type JsonObject,
  type JsonValue,
  type M12CapabilityId,
  type StableId,
} from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';

export interface ComponentRegistrySnapshot {
  readonly schemaVersion: 2;
  readonly digest: `sha256:${string}`;
  readonly definitions: readonly ComponentDefinitionV2[];
}

export interface ComponentCapabilityManifest {
  readonly schemaVersion: 2;
  readonly registryDigest: `sha256:${string}`;
  readonly components: readonly Readonly<{
    type: string;
    version: string;
    capability: M12CapabilityId;
    effect: ComponentDefinitionV2['effect'];
    risk: ComponentDefinitionV2['risk'];
    runtimeAdapter: string | null;
  }>[];
}

export const componentRegistryServiceToken = createStudioServiceToken<ComponentRegistry>('studio.component-registry');

export class ComponentRegistry {
  private readonly definitions = new Map<string, ComponentDefinitionV2>();
  private frozen = false;

  constructor(definitions: readonly ComponentDefinitionV2[] = BUILTIN_COMPONENT_DEFINITIONS) {
    for (const definition of definitions) this.register(definition);
  }

  register(input: unknown): ComponentDefinitionV2 {
    if (this.frozen) throw new ComponentRegistryError('component.registry-frozen', 'The component registry is frozen.');
    const definition = validateDefinition(input);
    const key = componentKey(definition.type, definition.version);
    if (this.definitions.has(key)) throw new ComponentRegistryError('component.definition-duplicate', `Component ${key} is already registered.`);
    validateSchemaVocabulary(definition.valueSchema, '$');
    const defaults = validateValueAgainstSchema(definition.valueSchema, definition.defaults, '$defaults');
    if (Buffer.byteLength(canonicalStringify(defaults)) > definition.validation.maxSerializedBytes) throw new ComponentRegistryError('component.defaults-oversized', `Defaults for ${key} exceed the component byte budget.`);
    const frozen = deepFreeze({ ...definition, defaults }) as ComponentDefinitionV2;
    this.definitions.set(key, frozen);
    return frozen;
  }

  freeze(): this { this.frozen = true; return this; }

  get(type: string, version: string): ComponentDefinitionV2 {
    const value = this.definitions.get(componentKey(type, version));
    if (!value) throw new ComponentRegistryError('component.definition-unknown', `Unknown component ${type}@${version}.`);
    return value;
  }

  validate(instance: unknown): GameComponentInstanceV2 {
    if (!isRecord(instance)) throw new ComponentRegistryError('component.instance-invalid', 'Component instance must be an object.');
    exactKeys(instance, ['id', 'type', 'version', 'enabled', 'value'], 'component instance');
    const id = asStableId(stringValue(instance.id, 'component id'), 'component id');
    const type = asStableId(stringValue(instance.type, 'component type'), 'component type');
    const version = semver(instance.version, 'component version');
    if (typeof instance.enabled !== 'boolean' || !isRecord(instance.value)) throw new ComponentRegistryError('component.instance-invalid', `Component ${id} has an invalid enabled/value field.`);
    const definition = this.get(type, version);
    const value = validateValueAgainstSchema(definition.valueSchema, instance.value, '$value');
    if (Buffer.byteLength(canonicalStringify(value)) > definition.validation.maxSerializedBytes) throw new ComponentRegistryError('component.value-oversized', `Component ${id} exceeds ${definition.validation.maxSerializedBytes} bytes.`);
    return deepFreeze({ id, type, version, enabled: instance.enabled, value }) as GameComponentInstanceV2;
  }

  create(input: Readonly<{ id: StableId; type: StableId; version: string; enabled?: boolean; value?: JsonObject }>): GameComponentInstanceV2 {
    const definition = this.get(input.type, input.version);
    const value = mergeObjects(definition.defaults as JsonObject, input.value ?? {});
    return this.validate({ id: input.id, type: input.type, version: input.version, enabled: input.enabled ?? true, value });
  }

  snapshot(): ComponentRegistrySnapshot {
    this.frozen = true;
    const definitions = Object.freeze([...this.definitions.values()].sort(compareDefinitions));
    return Object.freeze({ schemaVersion: 2, digest: `sha256:${sha256(canonicalStringify(definitions as unknown as JsonValue))}`, definitions });
  }

  capabilityManifest(): ComponentCapabilityManifest {
    const snapshot = this.snapshot();
    return Object.freeze({
      schemaVersion: 2,
      registryDigest: snapshot.digest,
      components: Object.freeze(snapshot.definitions.map((definition) => Object.freeze({
        type: definition.type, version: definition.version, capability: definition.capability,
        effect: definition.effect, risk: definition.risk, runtimeAdapter: definition.runtimeAdapter,
      }))),
    });
  }
}

export class ComponentRegistryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ComponentRegistryError'; }
}

const COMMON = Object.freeze({
  schemaVersion: 2,
  owner: 'studio.component-registry',
  validation: Object.freeze({ mode: 'json-schema', unknownProperties: 'reject', maxSerializedBytes: 64 * 1024 }),
  serializable: true,
  serialization: Object.freeze({ format: 'json', persistDisabled: true }),
  testOwner: 'test.component-registry',
} as const);

export const BUILTIN_COMPONENT_DEFINITIONS: readonly ComponentDefinitionV2[] = Object.freeze([
  definition('haiyue.transform.3d', 'document.v2', 'data', 'low', 'Transform 3D', 'Layout', 'inspector.transform', null,
    objectSchema({ position: vec3Schema(), rotationDegrees: vec3Schema(), scale: vec3Schema(0.000001) }, ['position', 'rotationDegrees', 'scale']),
    { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
  definition('haiyue.render.geometry', 'document.v2', 'gpu-owner', 'medium', 'Geometry', 'Rendering', 'inspector.geometry', 'adapter.render.geometry',
    objectSchema({ kind: { enum: ['cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron'] } }, ['kind']), { kind: 'cube' }),
  definition('haiyue.render.material', 'material.pbr', 'gpu-owner', 'medium', 'Material', 'Rendering', 'inspector.material', 'adapter.render.material',
    objectSchema({ material: { enum: ['basic', 'pbr', 'blinn-phong', 'normal'] }, color: numberArraySchema(4, 0, 1) }, ['material', 'color']),
    { material: 'basic', color: [0.16, 0.58, 1, 1] }),
  definition('haiyue.light.directional', 'lighting', 'gpu-owner', 'medium', 'Directional Light', 'Lighting', 'inspector.light', 'adapter.light.directional',
    objectSchema({ color: numberArraySchema(3, 0), intensity: numberSchema(0), direction: numberArraySchema(3), castShadow: { type: 'boolean' } }, ['color', 'intensity', 'direction', 'castShadow']),
    { color: [1, 1, 1], intensity: 1, direction: [-0.5, -1, -0.35], castShadow: true }),
  definition('haiyue.light.point', 'lighting', 'gpu-owner', 'medium', 'Point Light', 'Lighting', 'inspector.light', 'adapter.light.point',
    objectSchema({ color: numberArraySchema(3, 0), intensity: numberSchema(0), range: numberSchema(0.000001) }, ['color', 'intensity', 'range']),
    { color: [1, 0.9, 0.75], intensity: 2, range: 12 }),
  definition('haiyue.light.ambient', 'lighting', 'gpu-owner', 'low', 'Ambient Light', 'Lighting', 'inspector.light', 'adapter.light.ambient',
    objectSchema({ color: numberArraySchema(3, 0), intensity: numberSchema(0) }, ['color', 'intensity']),
    { color: [0.7, 0.8, 1], intensity: 0.25 }),
  definition('haiyue.script.binding', 'play.multi-script', 'runtime-owner', 'high', 'Script Binding', 'Gameplay', 'inspector.script-binding', 'adapter.script.binding',
    objectSchema({ scriptId: { type: 'string', pattern: '^script:[A-Za-z0-9._:-]{3,120}$' } }, ['scriptId']), { scriptId: 'script:unbound' }),
  definition('haiyue.camera.3d', 'camera.3d', 'gpu-owner', 'medium', 'Camera 3D', 'Camera', 'inspector.camera-3d', 'adapter.camera.3d',
    objectSchema({
      active: { type: 'boolean' }, projection: { enum: ['perspective', 'orthographic'] }, fovDegrees: numberSchema(1, 179),
      orthographicHeight: numberSchema(0.01, 10_000), near: numberSchema(0.0001, 1_000), far: numberSchema(0.001, 1_000_000), reverseZ: { type: 'boolean' },
      viewport: viewportSchema(),
    }, ['active', 'projection', 'fovDegrees', 'orthographicHeight', 'near', 'far', 'reverseZ', 'viewport']),
    { active: true, projection: 'perspective', fovDegrees: 45, orthographicHeight: 20, near: 0.1, far: 1_000, reverseZ: false, viewport: { x: 0, y: 0, width: 1, height: 1 } }),
  definition('haiyue.camera.2d', 'camera.2d', 'gpu-owner', 'medium', 'Camera 2D', 'Camera', 'inspector.camera-2d', 'adapter.camera.2d',
    objectSchema({
      active: { type: 'boolean' }, designWidth: numberSchema(1, 32_768), designHeight: numberSchema(1, 32_768), zoom: numberSchema(0.001, 1_000),
      near: numberSchema(-1_000_000, 1_000_000), far: numberSchema(-1_000_000, 1_000_000), viewportMode: { enum: ['expand', 'fit', 'fill', 'fixed'] }, viewport: viewportSchema(),
    }, ['active', 'designWidth', 'designHeight', 'zoom', 'near', 'far', 'viewportMode', 'viewport']),
    { active: true, designWidth: 800, designHeight: 600, zoom: 1, near: -1_000, far: 1_000, viewportMode: 'expand', viewport: { x: 0, y: 0, width: 1, height: 1 } }),
  definition('haiyue.camera.follow', 'camera.follow', 'runtime-owner', 'medium', 'Camera Follow', 'Camera', 'inspector.camera-follow', 'adapter.camera.follow',
    objectSchema({
      targetEntityId: { type: 'string', pattern: '^entity:[A-Za-z0-9._:-]{3,120}$' }, mode: { enum: ['position', 'look-at', 'position-and-look-at'] },
      offset: vec3Schema(), lookAtOffset: vec3Schema(), smoothing: numberSchema(0, 1),
      bounds: objectSchema({ enabled: { type: 'boolean' }, minimum: vec3Schema(), maximum: vec3Schema() }, ['enabled', 'minimum', 'maximum']),
    }, ['targetEntityId', 'mode', 'offset', 'lookAtOffset', 'smoothing', 'bounds']),
    { targetEntityId: 'entity:unbound', mode: 'position-and-look-at', offset: { x: 0, y: 8, z: 10 }, lookAtOffset: { x: 0, y: 0, z: 0 }, smoothing: 0.15, bounds: { enabled: false, minimum: { x: -1_000, y: -1_000, z: -1_000 }, maximum: { x: 1_000, y: 1_000, z: 1_000 } } }),
  definition('haiyue.input.action-map', 'input.keyboard', 'runtime-owner', 'medium', 'Input Action Map', 'Input', 'inspector.input-action-map', 'adapter.input.action-map',
    objectSchema({ actions: { type: 'array', minItems: 1, maxItems: 128, items: actionBindingSchema() } }, ['actions']),
    { actions: [{ name: 'MoveLeft', keys: ['ArrowLeft', 'KeyA'], pointerButtons: [], gamepadButtons: [], gamepadAxes: [] }, { name: 'MoveRight', keys: ['ArrowRight', 'KeyD'], pointerButtons: [], gamepadButtons: [], gamepadAxes: [] }, { name: 'Jump', keys: ['Space'], pointerButtons: [], gamepadButtons: [0], gamepadAxes: [] }, { name: 'Fire', keys: [], pointerButtons: [0], gamepadButtons: [7], gamepadAxes: [] }] }),
  definition('haiyue.interaction.pointer', 'interaction.pointer', 'runtime-owner', 'medium', 'Pointer Interaction', 'Input', 'inspector.pointer-interaction', 'adapter.interaction.pointer',
    objectSchema({ events: { type: 'array', minItems: 1, maxItems: 8, items: { enum: ['hover', 'click', 'move', 'down', 'up', 'drag', 'wheel', 'cancel'] } }, draggable: { type: 'boolean' }, capturePointer: { type: 'boolean' }, penetrable: { type: 'boolean' }, maxEventsPerTick: { type: 'integer', minimum: 1, maximum: 256 } }, ['events', 'draggable', 'capturePointer', 'penetrable', 'maxEventsPerTick']),
    { events: ['hover', 'click', 'drag'], draggable: true, capturePointer: true, penetrable: false, maxEventsPerTick: 32 }),
  definition('haiyue.simulation.settings', 'simulation.fixed-step', 'runtime-owner', 'medium', 'Simulation Settings', 'Gameplay', 'inspector.simulation-settings', 'adapter.simulation.settings',
    objectSchema({ tickRateHz: numberSchema(1, 240), seed: { type: 'string', pattern: '^.{1,256}$' }, maxSubSteps: { type: 'integer', minimum: 1, maximum: 10_000 } }, ['tickRateHz', 'seed', 'maxSubSteps']),
    { tickRateHz: 60, seed: 'haiyue-play', maxSubSteps: 1_000 }),
  definition('haiyue.physics.world.2d', 'physics.2d', 'runtime-owner', 'medium', 'Physics World 2D', 'Physics', 'inspector.physics-world-2d', 'adapter.physics.world-2d',
    objectSchema({ backend: { enum: ['box2d'] }, gravity: vec2Schema(), pixelsPerMeter: numberSchema(0.001, 100_000), velocityIterations: integerSchema(1, 64), positionIterations: integerSchema(1, 64), maxEventsPerTick: integerSchema(1, 1_024) }, ['backend', 'gravity', 'pixelsPerMeter', 'velocityIterations', 'positionIterations', 'maxEventsPerTick']),
    { backend: 'box2d', gravity: { x: 0, y: -980 }, pixelsPerMeter: 100, velocityIterations: 8, positionIterations: 3, maxEventsPerTick: 256 }),
  definition('haiyue.physics.world.3d', 'physics.3d', 'runtime-owner', 'medium', 'Physics World 3D', 'Physics', 'inspector.physics-world-3d', 'adapter.physics.world-3d',
    objectSchema({ backend: { enum: ['rapier3d'] }, gravity: vec3Schema(), solverIterations: integerSchema(1, 64), loadTimeoutMs: integerSchema(100, 60_000), maxEventsPerTick: integerSchema(1, 1_024) }, ['backend', 'gravity', 'solverIterations', 'loadTimeoutMs', 'maxEventsPerTick']),
    { backend: 'rapier3d', gravity: { x: 0, y: -9.81, z: 0 }, solverIterations: 6, loadTimeoutMs: 10_000, maxEventsPerTick: 256 }),
  definition('haiyue.physics.rigidbody.2d', 'physics.2d', 'runtime-owner', 'medium', 'Rigid Body 2D', 'Physics', 'inspector.rigidbody-2d', 'adapter.physics.rigidbody-2d',
    objectSchema({ type: { enum: ['static', 'dynamic', 'kinematic'] }, fixedRotation: { type: 'boolean' }, linearDamping: numberSchema(0, 1_000), angularDamping: numberSchema(0, 1_000), bullet: { type: 'boolean' }, allowSleep: { type: 'boolean' }, syncTransform: { type: 'boolean' }, initialVelocity: vec2Schema(), initialAngularVelocity: numberSchema(-100_000, 100_000) }, ['type', 'fixedRotation', 'linearDamping', 'angularDamping', 'bullet', 'allowSleep', 'syncTransform', 'initialVelocity', 'initialAngularVelocity']),
    { type: 'dynamic', fixedRotation: false, linearDamping: 0, angularDamping: 0, bullet: false, allowSleep: true, syncTransform: true, initialVelocity: { x: 0, y: 0 }, initialAngularVelocity: 0 }),
  definition('haiyue.physics.collider.2d', 'physics.2d', 'runtime-owner', 'medium', 'Collider 2D', 'Physics', 'inspector.collider-2d', 'adapter.physics.collider-2d',
    objectSchema({ shape: { enum: ['box', 'circle'] }, size: vec2PositiveSchema(), radius: numberSchema(0.000001, 100_000), density: numberSchema(0, 100_000), materialEntityId: entityReferenceSchema(), trigger: { type: 'boolean' }, categoryBits: integerSchema(1, 65_535), maskBits: integerSchema(0, 65_535), groupIndex: integerSchema(-32_768, 32_767) }, ['shape', 'size', 'radius', 'density', 'materialEntityId', 'trigger', 'categoryBits', 'maskBits', 'groupIndex']),
    { shape: 'box', size: { x: 1, y: 1 }, radius: 0.5, density: 1, materialEntityId: 'entity:unbound', trigger: false, categoryBits: 1, maskBits: 65_535, groupIndex: 0 }),
  definition('haiyue.physics.rigidbody.3d', 'physics.3d', 'runtime-owner', 'medium', 'Rigid Body 3D', 'Physics', 'inspector.rigidbody-3d', 'adapter.physics.rigidbody-3d',
    objectSchema({ type: { enum: ['static', 'dynamic', 'kinematic'] }, linearDamping: numberSchema(0, 1_000), angularDamping: numberSchema(0, 1_000), gravityScale: numberSchema(-100, 100), ccd: { type: 'boolean' }, allowSleep: { type: 'boolean' }, lockTranslations: booleanArraySchema(3), lockRotations: booleanArraySchema(3), syncTransform: { type: 'boolean' }, initialVelocity: vec3Schema(), initialAngularVelocity: vec3Schema() }, ['type', 'linearDamping', 'angularDamping', 'gravityScale', 'ccd', 'allowSleep', 'lockTranslations', 'lockRotations', 'syncTransform', 'initialVelocity', 'initialAngularVelocity']),
    { type: 'dynamic', linearDamping: 0, angularDamping: 0, gravityScale: 1, ccd: false, allowSleep: true, lockTranslations: [false, false, false], lockRotations: [false, false, false], syncTransform: true, initialVelocity: { x: 0, y: 0, z: 0 }, initialAngularVelocity: { x: 0, y: 0, z: 0 } }),
  definition('haiyue.physics.collider.3d', 'physics.3d', 'runtime-owner', 'medium', 'Collider 3D', 'Physics', 'inspector.collider-3d', 'adapter.physics.collider-3d',
    objectSchema({ shape: { enum: ['box', 'sphere', 'capsule', 'cylinder'] }, size: vec3PositiveSchema(), radius: numberSchema(0.000001, 100_000), halfHeight: numberSchema(0, 100_000), density: numberSchema(0, 100_000), materialEntityId: entityReferenceSchema(), trigger: { type: 'boolean' }, categoryBits: integerSchema(1, 65_535), maskBits: integerSchema(0, 65_535) }, ['shape', 'size', 'radius', 'halfHeight', 'density', 'materialEntityId', 'trigger', 'categoryBits', 'maskBits']),
    { shape: 'box', size: { x: 1, y: 1, z: 1 }, radius: 0.5, halfHeight: 0.5, density: 1, materialEntityId: 'entity:unbound', trigger: false, categoryBits: 1, maskBits: 65_535 }),
  definition('haiyue.physics.material', 'physics.2d', 'data', 'low', 'Physics Material', 'Physics', 'inspector.physics-material', null,
    objectSchema({ friction: numberSchema(0, 10), restitution: numberSchema(0, 1) }, ['friction', 'restitution']), { friction: 0.5, restitution: 0.1 }),
  definition('haiyue.physics.joint.2d', 'physics.2d', 'runtime-owner', 'medium', 'Joint 2D', 'Physics', 'inspector.joint-2d', 'adapter.physics.joint-2d',
    objectSchema({ type: { enum: ['revolute', 'distance'] }, bodyAEntityId: entityReferenceSchema(), bodyBEntityId: entityReferenceSchema(), anchor: vec2Schema(), anchorA: vec2Schema(), anchorB: vec2Schema(), collideConnected: { type: 'boolean' }, enableLimit: { type: 'boolean' }, limits: numberArraySchema(2), enableMotor: { type: 'boolean' }, motorSpeed: numberSchema(-100_000, 100_000), maxMotorTorque: numberSchema(0, 100_000_000), length: numberSchema(0, 100_000), frequencyHz: numberSchema(0, 10_000), dampingRatio: numberSchema(0, 1) }, ['type', 'bodyAEntityId', 'bodyBEntityId', 'anchor', 'anchorA', 'anchorB', 'collideConnected', 'enableLimit', 'limits', 'enableMotor', 'motorSpeed', 'maxMotorTorque', 'length', 'frequencyHz', 'dampingRatio']),
    { type: 'distance', bodyAEntityId: 'entity:unbound-a', bodyBEntityId: 'entity:unbound-b', anchor: { x: 0, y: 0 }, anchorA: { x: 0, y: 0 }, anchorB: { x: 0, y: 0 }, collideConnected: false, enableLimit: false, limits: [0, 0], enableMotor: false, motorSpeed: 0, maxMotorTorque: 0, length: 1, frequencyHz: 0, dampingRatio: 0 }),
  definition('haiyue.physics.joint.3d', 'physics.3d', 'runtime-owner', 'medium', 'Joint 3D', 'Physics', 'inspector.joint-3d', 'adapter.physics.joint-3d',
    objectSchema({ type: { enum: ['fixed', 'spherical', 'revolute', 'prismatic', 'spring', 'rope'] }, bodyAEntityId: entityReferenceSchema(), bodyBEntityId: entityReferenceSchema(), anchorA: vec3Schema(), anchorB: vec3Schema(), axis: vec3Schema(), collideConnected: { type: 'boolean' }, limits: numberArraySchema(2), restLength: numberSchema(0, 100_000), maxLength: numberSchema(0, 100_000), stiffness: numberSchema(0, 100_000_000), damping: numberSchema(0, 100_000_000) }, ['type', 'bodyAEntityId', 'bodyBEntityId', 'anchorA', 'anchorB', 'axis', 'collideConnected', 'limits', 'restLength', 'maxLength', 'stiffness', 'damping']),
    { type: 'fixed', bodyAEntityId: 'entity:unbound-a', bodyBEntityId: 'entity:unbound-b', anchorA: { x: 0, y: 0, z: 0 }, anchorB: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, collideConnected: false, limits: [0, 0], restLength: 1, maxLength: 1, stiffness: 30, damping: 3 }),
  definition('haiyue.gameplay.character', 'physics.3d', 'runtime-owner', 'medium', 'Character Controller', 'Gameplay', 'inspector.character-controller', 'adapter.gameplay.character',
    objectSchema({ dimension: { enum: ['2d', '3d'] }, moveActionX: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,95}$' }, moveActionY: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,95}$' }, jumpAction: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,95}$' }, maxSpeed: numberSchema(0, 100_000), acceleration: numberSchema(0, 100_000), airControl: numberSchema(0, 1), jumpImpulse: numberSchema(0, 100_000_000) }, ['dimension', 'moveActionX', 'moveActionY', 'jumpAction', 'maxSpeed', 'acceleration', 'airControl', 'jumpImpulse']),
    { dimension: '3d', moveActionX: 'MoveX', moveActionY: 'MoveY', jumpAction: 'Jump', maxSpeed: 8, acceleration: 40, airControl: 0.25, jumpImpulse: 5 }),
  definition('haiyue.gameplay.ground-probe', 'physics.raycast', 'runtime-owner', 'medium', 'Ground Probe', 'Gameplay', 'inspector.ground-probe', 'adapter.gameplay.ground-probe',
    objectSchema({ dimension: { enum: ['2d', '3d'] }, direction: vec3Schema(), distance: numberSchema(0.000001, 100_000), radius: numberSchema(0, 100_000), categoryBits: integerSchema(1, 65_535), maskBits: integerSchema(0, 65_535) }, ['dimension', 'direction', 'distance', 'radius', 'categoryBits', 'maskBits']),
    { dimension: '3d', direction: { x: 0, y: -1, z: 0 }, distance: 0.65, radius: 0.2, categoryBits: 1, maskBits: 65_535 }),
]);

function definition(
  type: string, capability: M12CapabilityId, effect: ComponentDefinitionV2['effect'], risk: ComponentDefinitionV2['risk'],
  label: string, category: string, inspector: string | null, runtimeAdapter: string | null, valueSchema: JsonObject, defaults: JsonObject,
): ComponentDefinitionV2 {
  return deepFreeze({
    ...COMMON, type, version: '1.0.0', capability, effect, risk, valueSchema, defaults,
    editor: { label, category, inspector }, runtimeAdapter,
  }) as ComponentDefinitionV2;
}

function objectSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return { type: 'object', additionalProperties: false, properties, required: [...required] };
}
function vec3Schema(exclusiveMinimum?: number): JsonObject {
  const member: JsonObject = exclusiveMinimum === undefined ? { type: 'number' } : { type: 'number', minimum: exclusiveMinimum };
  return objectSchema({ x: member, y: member, z: member }, ['x', 'y', 'z']);
}
function vec2Schema(): JsonObject { return objectSchema({ x: numberSchema(), y: numberSchema() }, ['x', 'y']); }
function vec2PositiveSchema(): JsonObject { return objectSchema({ x: numberSchema(0.000001), y: numberSchema(0.000001) }, ['x', 'y']); }
function vec3PositiveSchema(): JsonObject { return objectSchema({ x: numberSchema(0.000001), y: numberSchema(0.000001), z: numberSchema(0.000001) }, ['x', 'y', 'z']); }
function numberSchema(minimum?: number, maximum?: number): JsonObject { return { type: 'number', ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) }; }
function integerSchema(minimum?: number, maximum?: number): JsonObject { return { type: 'integer', ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) }; }
function numberArraySchema(length: number, minimum?: number, maximum?: number): JsonObject { return { type: 'array', minItems: length, maxItems: length, items: numberSchema(minimum, maximum) }; }
function booleanArraySchema(length: number): JsonObject { return { type: 'array', minItems: length, maxItems: length, items: { type: 'boolean' } }; }
function entityReferenceSchema(): JsonObject { return { type: 'string', pattern: '^entity:[A-Za-z0-9._:-]{3,120}$' }; }
function viewportSchema(): JsonObject { return objectSchema({ x: numberSchema(0, 1), y: numberSchema(0, 1), width: numberSchema(0.000001, 1), height: numberSchema(0.000001, 1) }, ['x', 'y', 'width', 'height']); }
function actionBindingSchema(): JsonObject {
  return objectSchema({
    name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,95}$' },
    keys: { type: 'array', maxItems: 32, items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]{0,63}$' } },
    pointerButtons: { type: 'array', maxItems: 32, items: { type: 'integer', minimum: 0, maximum: 31 } },
    gamepadButtons: { type: 'array', maxItems: 64, items: { type: 'integer', minimum: 0, maximum: 255 } },
    gamepadAxes: { type: 'array', maxItems: 32, items: objectSchema({ axis: { type: 'integer', minimum: 0, maximum: 63 }, direction: { enum: ['positive', 'negative', 'both'] }, deadZone: numberSchema(0, 0.999999), scale: numberSchema(0.000001, 10) }, ['axis', 'direction', 'deadZone', 'scale']) },
  }, ['name', 'keys', 'pointerButtons', 'gamepadButtons', 'gamepadAxes']);
}

function validateDefinition(input: unknown): ComponentDefinitionV2 {
  if (!isRecord(input) || input.schemaVersion !== 2) throw new ComponentRegistryError('component.definition-version-unsupported', 'Component definition schemaVersion must be 2.');
  exactKeys(input, ['schemaVersion', 'type', 'version', 'owner', 'capability', 'effect', 'risk', 'valueSchema', 'defaults', 'validation', 'editor', 'serializable', 'runtimeAdapter', 'serialization', 'testOwner'], 'component definition');
  const type = asStableId(stringValue(input.type, 'component type'), 'component type');
  const owner = asStableId(stringValue(input.owner, 'component owner'), 'component owner');
  const testOwner = asStableId(stringValue(input.testOwner, 'component test owner'), 'component test owner');
  const version = semver(input.version, 'component version');
  if (!CAPABILITIES.has(input.capability as M12CapabilityId) || !EFFECTS.has(input.effect as ComponentDefinitionV2['effect']) || !RISKS.has(input.risk as ComponentDefinitionV2['risk'])) throw new ComponentRegistryError('component.definition-invalid', `Component ${type} has invalid capability/effect/risk metadata.`);
  if (!isRecord(input.valueSchema) || !isRecord(input.defaults) || !isRecord(input.validation) || !isRecord(input.editor) || !isRecord(input.serialization)) throw new ComponentRegistryError('component.definition-invalid', `Component ${type} has invalid descriptor objects.`);
  exactKeys(input.validation, ['mode', 'unknownProperties', 'maxSerializedBytes'], 'component validation descriptor');
  exactKeys(input.editor, ['label', 'category', 'inspector'], 'component editor descriptor');
  exactKeys(input.serialization, ['format', 'persistDisabled'], 'component serialization descriptor');
  if (input.validation.mode !== 'json-schema' || input.validation.unknownProperties !== 'reject' || !Number.isSafeInteger(input.validation.maxSerializedBytes) || (input.validation.maxSerializedBytes as number) < 1 || (input.validation.maxSerializedBytes as number) > 1_048_576) throw new ComponentRegistryError('component.definition-invalid', `Component ${type} has an invalid validation descriptor.`);
  if (typeof input.editor.label !== 'string' || !input.editor.label.trim() || typeof input.editor.category !== 'string' || !input.editor.category.trim()) throw new ComponentRegistryError('component.definition-invalid', `Component ${type} has invalid editor metadata.`);
  const inspector = input.editor.inspector === null ? null : asStableId(stringValue(input.editor.inspector, 'component inspector'), 'component inspector');
  if (input.serializable !== true || input.serialization.format !== 'json' || typeof input.serialization.persistDisabled !== 'boolean') throw new ComponentRegistryError('component.definition-invalid', `Component ${type} is not supported by the v2 serializer.`);
  const runtimeAdapter = input.runtimeAdapter === null ? null : asStableId(stringValue(input.runtimeAdapter, 'runtime adapter'), 'runtime adapter');
  if (input.effect !== 'data' && !runtimeAdapter) throw new ComponentRegistryError('component.runtime-adapter-missing', `Component ${type} requires a runtime adapter.`);
  return deepFreeze({ ...input, type, version, owner, testOwner, runtimeAdapter, editor: { ...input.editor, inspector } }) as unknown as ComponentDefinitionV2;
}

function validateValueAgainstSchema(schema: Readonly<Record<string, unknown>>, value: unknown, path: string): JsonObject {
  validateNode(schema, value, path);
  if (!isRecord(value)) throw new ComponentRegistryError('component.value-invalid', `${path} must be an object.`);
  return cloneJson(value) as JsonObject;
}

function validateNode(schema: Readonly<Record<string, unknown>>, value: unknown, path: string): void {
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((entry) => canonicalStringify(entry as JsonValue) === canonicalStringify(value as JsonValue))) invalid(path, 'does not match the allowed values');
    return;
  }
  const type = schema.type;
  if (type === 'object') {
    if (!isRecord(value)) invalid(path, 'must be an object');
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) if (typeof key !== 'string' || !Object.hasOwn(value, key)) invalid(`${path}.${String(key)}`, 'is required');
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) invalid(`${path}.${key}`, 'is not allowed');
    for (const [key, member] of Object.entries(value)) if (isRecord(properties[key])) validateNode(properties[key], member, `${path}.${key}`);
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) invalid(path, 'must be an array');
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) invalid(path, 'has too few items');
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) invalid(path, 'has too many items');
    if (isRecord(schema.items)) value.forEach((item, index) => validateNode(schema.items as Readonly<Record<string, unknown>>, item, `${path}[${index}]`));
    return;
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'must be a finite number');
    if (typeof schema.minimum === 'number' && value < schema.minimum) invalid(path, `must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) invalid(path, `must be <= ${schema.maximum}`);
    return;
  }
  if (type === 'integer') {
    if (!Number.isSafeInteger(value)) invalid(path, 'must be an integer');
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) invalid(path, `must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) invalid(path, `must be <= ${schema.maximum}`);
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') invalid(path, 'must be a string');
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) invalid(path, 'does not match the required pattern');
    return;
  }
  if (type === 'boolean') { if (typeof value !== 'boolean') invalid(path, 'must be a boolean'); return; }
  if (type === 'null') { if (value !== null) invalid(path, 'must be null'); return; }
  throw new ComponentRegistryError('component.schema-unsupported', `${path} uses an unsupported schema type.`);
}

function validateSchemaVocabulary(schema: Readonly<Record<string, unknown>>, path: string): void {
  const allowed = new Set(['type', 'enum', 'additionalProperties', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'pattern']);
  for (const key of Object.keys(schema)) if (!allowed.has(key)) throw new ComponentRegistryError('component.schema-unsupported', `${path} uses unsupported keyword ${key}.`);
  if (isRecord(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) { if (!isRecord(child)) throw new ComponentRegistryError('component.schema-invalid', `${path}.properties.${key} must be a schema.`); validateSchemaVocabulary(child, `${path}.properties.${key}`); }
  if (isRecord(schema.items)) validateSchemaVocabulary(schema.items, `${path}.items`);
}

function invalid(path: string, reason: string): never { throw new ComponentRegistryError('component.value-invalid', `${path} ${reason}.`); }
function componentKey(type: string, version: string): string { return `${type}@${version}`; }
function compareDefinitions(left: ComponentDefinitionV2, right: ComponentDefinitionV2): number { return left.type.localeCompare(right.type) || left.version.localeCompare(right.version); }
function semver(value: unknown, label: string): string { if (typeof value !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value)) throw new ComponentRegistryError('component.definition-invalid', `${label} must be semantic version x.y.z.`); return value; }
function stringValue(value: unknown, label: string): string { if (typeof value !== 'string') throw new ComponentRegistryError('component.definition-invalid', `${label} must be a string.`); return value; }
function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void { const set = new Set(allowed); for (const key of Object.keys(value)) if (!set.has(key)) throw new ComponentRegistryError('component.unknown-field', `${label} contains unknown field ${key}.`); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function mergeObjects(left: JsonObject, right: JsonObject): JsonObject {
  const output = cloneJson(left) as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(right)) output[key] = isRecord(output[key]) && isRecord(value) ? mergeObjects(output[key] as JsonObject, value as JsonObject) : cloneJson(value);
  return output;
}
function cloneJson(value: unknown): JsonValue { if (Array.isArray(value)) return value.map(cloneJson); if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)])); if (value === null || typeof value === 'boolean' || typeof value === 'string') return value; if (typeof value === 'number' && Number.isFinite(value)) return value; throw new ComponentRegistryError('component.value-invalid', 'Component data must be finite JSON.'); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }

const CAPABILITIES = new Set<M12CapabilityId>([
  'agent.model-config', 'agent.usage', 'agent.cache', 'agent.context', 'task.evaluate', 'document.v2', 'component.registry', 'scene.transaction',
  'camera.2d', 'camera.3d', 'camera.follow', 'input.keyboard', 'input.pointer', 'input.inject', 'simulation.fixed-step', 'simulation.replay', 'interaction.pointer',
  'physics.2d', 'physics.3d', 'physics.raycast', 'lighting', 'shadow.directional', 'material.pbr', 'postprocess', 'particles.2d', 'particles.3d',
  'animation.2d', 'animation.3d', 'audio.playback', 'asset.import', 'prefab', 'play.multi-script', 'play.capture', 'play.inspect', 'diagnostics.query',
]);
const EFFECTS = new Set<ComponentDefinitionV2['effect']>(['data', 'runtime-owner', 'gpu-owner', 'audio-owner']);
const RISKS = new Set<ComponentDefinitionV2['risk']>(['low', 'medium', 'high']);
