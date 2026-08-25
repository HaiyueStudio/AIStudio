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
function numberSchema(minimum?: number, maximum?: number): JsonObject { return { type: 'number', ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) }; }
function numberArraySchema(length: number, minimum?: number, maximum?: number): JsonObject { return { type: 'array', minItems: length, maxItems: length, items: numberSchema(minimum, maximum) }; }

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
  if (type === 'integer') { if (!Number.isSafeInteger(value)) invalid(path, 'must be an integer'); return; }
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
