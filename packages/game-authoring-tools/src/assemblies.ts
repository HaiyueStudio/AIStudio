import { Ajv } from 'ajv';
import { asStableId, type GameDocumentOperationV2, type GameDocumentV2, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { geometryDefinition } from '@haiyue/ai-studio-editor-plugins/render';
import type { ProjectWorkspace } from '@haiyue/ai-studio-editor-plugins';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';
import { GameToolProtocolError } from './types.js';

// Private, versioned document setting. All writes are ordinary Document History operations.
const SETTING = 'studio.assemblies.v1';
const key = { type: 'string', pattern: '^(?!constructor$|prototype$)[a-zA-Z][a-zA-Z0-9_-]{0,47}$' };
const vec = { type: 'object', additionalProperties: false, required: ['x', 'y', 'z'], properties: { x: { type: 'number', minimum: -100000, maximum: 100000 }, y: { type: 'number', minimum: -100000, maximum: 100000 }, z: { type: 'number', minimum: -100000, maximum: 100000 } } };
const transform = { type: 'object', additionalProperties: false, required: ['position', 'rotationDegrees', 'scale'], properties: { position: vec, rotationDegrees: vec, scale: vec } };
const color = { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number', minimum: 0, maximum: 1 } };
const geometry = ['cube', 'rounded-box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron'];
const part = { type: 'object', additionalProperties: false, required: ['key', 'kind', 'transform'], properties: {
  key, parentKey: key, kind: { enum: ['empty', ...geometry] }, transform,
  radius: { type: 'number', minimum: 0, maximum: 0.5 }, segments: { type: 'integer', minimum: 1, maximum: 16 }, plane: { enum: ['xy', 'xz', 'yz'] },
  material: { enum: ['basic', 'pbr', 'blinn-phong', 'normal'] }, color, colorSlot: key,
} };
const requirement = { type: 'object', additionalProperties: false, required: ['label', 'partKeys'], properties: {
  label: { type: 'string', minLength: 1, maxLength: 240 }, partKeys: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: key }, distinctColors: { type: 'integer', minimum: 1, maximum: 64 },
} };
const blueprint = { type: 'object', additionalProperties: false, required: ['name', 'parts', 'requirements'], properties: {
  name: { type: 'string', minLength: 1, maxLength: 80 }, parts: { type: 'array', minItems: 1, maxItems: 64, items: part },
  requirements: { type: 'array', minItems: 1, maxItems: 32, items: requirement },
} };
const base = { baseRevision: { type: 'integer', minimum: 0 }, assemblyId: key };
const schema = (properties: JsonObject, required: string[]) => ({ type: 'object', additionalProperties: false, required, properties });
export const ASSEMBLY_SCHEMAS = {
  'assembly.create': schema({ ...base, blueprint }, ['baseRevision', 'assemblyId', 'blueprint']),
  'assembly.inspect': schema(base, ['baseRevision', 'assemblyId']),
  'assembly.instantiate': schema({ ...base, prototypeDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, instances: { type: 'array', minItems: 1, maxItems: 32, items: schema({ name: { type: 'string', minLength: 1, maxLength: 80 }, transform, colors: { type: 'object', maxProperties: 64, propertyNames: key, additionalProperties: color } }, ['name', 'transform']) } }, ['baseRevision', 'assemblyId', 'prototypeDigest', 'instances']),
} as const;
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = Object.fromEntries(Object.entries(ASSEMBLY_SCHEMAS).map(([id, value]) => [id, ajv.compile(value)]));
const validateBlueprint = ajv.compile(blueprint);
const validateColors = ajv.compile({type:'object',maxProperties:64,propertyNames:key,additionalProperties:color});
const identity: JsonObject = { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
interface Binding { rootId: StableId; partIds: Record<string, StableId>; colors: JsonObject; }
interface Assembly { schemaVersion: 1; blueprint: JsonObject; prototype: Binding; instances: Binding[]; }
function fail(code: string, message: string): never { throw new GameToolProtocolError(`assembly.${code}`, message); }
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function digest(value: unknown): `sha256:${string}` { return `sha256:${sha256(canonicalStringify(value as JsonValue))}`; }
function same(a: unknown, b: unknown): boolean { return canonicalStringify(a as JsonValue) === canonicalStringify(b as JsonValue); }
function parts(value: JsonObject): JsonObject[] { return value.parts as JsonObject[]; }
function requirements(value: JsonObject): JsonObject[] { return value.requirements as JsonObject[]; }

export function normalizeAssemblyArguments(id: string, raw: JsonObject): JsonObject {
  if (raw.baseRevision === undefined) throw new GameToolProtocolError('tool.arguments-invalid', `${id} arguments invalid; missing required fields: baseRevision.`);
  const validate = validators[id];
  if (!validate?.(raw)) fail('arguments-invalid', `${id}: ${ajv.errorsText(validate?.errors, { separator: '; ' }).slice(0, 600)}. Read this tool's schema before retrying.`);
  if (id === 'assembly.create') validateRecipe(raw.blueprint as JsonObject);
  return raw;
}
function validateRecipe(recipe: JsonObject): void {
  if (!validateBlueprint(recipe)) fail('blueprint-invalid', 'Unsupported assembly blueprint.');
  const rows = parts(recipe), keys = new Set(rows.map(row => row.key));
  if (keys.size !== rows.length) fail('blueprint-invalid', 'Part keys must be unique.');
  const visited = new Set<JsonValue>();
  for (const row of rows) {
    if (row.parentKey && !visited.has(row.parentKey)) fail('blueprint-invalid', 'Parts must be parent-first; parentKey must reference an earlier part.');
    visited.add(row.key!);
    if (row.kind === 'empty' && ['material', 'color', 'colorSlot', 'radius', 'segments', 'plane'].some(k => row[k] !== undefined)) fail('blueprint-invalid', 'Empty grouping parts cannot carry visual properties.');
    if (row.kind !== 'empty' && (!row.material || !row.color)) fail('blueprint-invalid', `Part ${row.key} needs an explicit material and color.`);
    if ((row.radius !== undefined || row.segments !== undefined) && row.kind !== 'rounded-box') fail('blueprint-invalid', 'Rounding parameters require rounded-box.');
    if (row.plane !== undefined && row.kind !== 'plane') fail('blueprint-invalid', 'plane orientation requires plane geometry.');
    if (Object.values((row.transform as JsonObject).scale as JsonObject).some(n => Number(n) <= 0)) fail('blueprint-invalid', 'Part scale must be positive.');
  }
  for (const r of requirements(recipe)) {
    if ((r.partKeys as JsonValue[]).some(k => !keys.has(k))) fail('blueprint-invalid', `Requirement ${r.label} references an unknown part.`);
    const colors = new Set(rows.filter(p => (r.partKeys as JsonValue[]).includes(p.key!) && p.color).map(p => canonicalStringify(p.color!)));
    if (r.distinctColors && colors.size < Number(r.distinctColors)) fail('requirements-unmet', `Requirement ${r.label} needs ${r.distinctColors} distinct colors; blueprint has ${colors.size}.`);
  }
}
function registry(document: GameDocumentV2): Record<string, Assembly> {
  const raw = document.settings[SETTING];
  if (raw === undefined) return {};
  if (!object(raw) || Object.keys(raw).length > 64 || Buffer.byteLength(canonicalStringify(raw)) > 512 * 1024) fail('registry-invalid', 'Assembly registry is invalid or exceeds its storage budget.');
  const boundIds = new Set<string>();
  for (const value of Object.values(raw)) {
    if (!object(value) || Object.keys(value).some(k => !['schemaVersion','blueprint','prototype','instances'].includes(k)) || value.schemaVersion !== 1 || !object(value.blueprint) || !object(value.prototype) || !Array.isArray(value.instances) || value.instances.length > 256) fail('registry-invalid', 'Unsupported stored assembly version or shape.');
    validateRecipe(value.blueprint);
    for (const b of [value.prototype, ...value.instances]) {
      if (!object(b) || typeof b.rootId !== 'string' || !/^entity:[A-Za-z0-9._:-]{3,120}$/.test(b.rootId) || !object(b.partIds) || !object(b.colors) || Object.values(b.partIds).some(id => typeof id !== 'string' || !/^entity:[A-Za-z0-9._:-]{3,120}$/.test(id))) fail('registry-invalid', 'Invalid assembly instance binding.');
      const roleKeys = parts(value.blueprint).map(p => String(p.key)), slots = new Set(parts(value.blueprint).flatMap(p => p.colorSlot ? [String(p.colorSlot)] : []));
      if (Object.keys(b).some(k => !['rootId','partIds','colors'].includes(k)) || Object.keys(b.partIds).length !== roleKeys.length || roleKeys.some(k => !b.partIds || !Object.hasOwn(b.partIds as JsonObject,k)) || !validateColors(b.colors) || Object.keys(b.colors).some(k => !slots.has(k))) fail('registry-invalid','Stored part roles or color slots are invalid.');
      for (const id of [b.rootId,...Object.values(b.partIds)]) { if (boundIds.has(String(id))) fail('registry-invalid','Assembly instances must have distinct entity bindings.'); boundIds.add(String(id)); }
    }
  }
  return structuredClone(raw) as unknown as Record<string, Assembly>;
}
function inspectBinding(document: GameDocumentV2, assembly: Assembly, binding: Binding): string[] {
  const problems: string[] = [], root = document.entities.find(e => e.id === binding.rootId);
  if (!root) problems.push(`Missing root ${binding.rootId}.`);
  const actualColors = new Map<string, string>();
  for (const p of parts(assembly.blueprint)) {
    const id = binding.partIds[String(p.key)], entity = document.entities.find(e => e.id === id);
    if (!entity) { problems.push(`Missing part ${p.key}.`); continue; }
    if (entity.parentId !== (p.parentKey ? binding.partIds[String(p.parentKey)] : binding.rootId)) problems.push(`Part ${p.key}: parent differs from blueprint.`);
    const components = document.components.filter(c => entity.componentIds.includes(c.id as StableId));
    const component = (type: string) => components.find(c => c.type === type && c.enabled)?.value;
    const prototypeEntity = document.entities.find(e => e.id === assembly.prototype.partIds[String(p.key)]);
    const prototypePointer = prototypeEntity && document.components.find(c => prototypeEntity.componentIds.includes(c.id) && c.type === 'haiyue.interaction.pointer' && c.enabled);
    if (prototypePointer && !same(component('haiyue.interaction.pointer') ?? null, prototypePointer.value)) problems.push(`Part ${p.key} (${id}): pointer interaction differs from prototype; replicas are snapshots, configure every existing instance or configure the prototype before copying.`);
    const expectedGeometry: JsonObject = { kind: p.kind!, ...(p.radius !== undefined ? { radius: p.radius } : {}), ...(p.segments !== undefined ? { segments: p.segments } : {}), ...(p.plane ? { plane: p.plane } : {}) };
    const actualGeometry = component('haiyue.render.geometry');
    if (p.kind !== 'empty' && (!actualGeometry || !same(geometryDefinition(String(p.kind), expectedGeometry), geometryDefinition(String(actualGeometry.kind), actualGeometry)))) problems.push(`Part ${p.key}: geometry differs from blueprint.`);
    if (!same(component('haiyue.transform.3d') ?? null, p.transform)) problems.push(`Part ${p.key}: local transform differs from blueprint.`);
    if (p.kind !== 'empty') {
      const authored = component('haiyue.render.material'), pbr = component('haiyue.material.pbr');
      const material = authored?.material === 'pbr' && pbr ? { ...authored, color: pbr.baseColor } : authored, expectedColor = p.colorSlot && binding.colors[String(p.colorSlot)] || p.color;
      if (!material || material.material !== p.material || !same(material.color ?? null, expectedColor)) problems.push(`Part ${p.key}: material/color differs from blueprint.`);
      if (material?.color) actualColors.set(String(p.key), canonicalStringify(material.color));
    }
  }
  for (const r of requirements(assembly.blueprint)) {
    const colors = new Set((r.partKeys as string[]).flatMap(k => actualColors.has(k) ? [actualColors.get(k)!] : []));
    if (r.distinctColors && colors.size < Number(r.distinctColors)) problems.push(`${r.label}: requires ${r.distinctColors} distinct colors, found ${colors.size}.`);
  }
  return problems;
}
function prototypeDigest(document: GameDocumentV2, a: Assembly): `sha256:${string}` {
  const ids = new Set<string>([a.prototype.rootId, ...Object.values(a.prototype.partIds)]);
  const entities = document.entities.filter(e => ids.has(e.id)), componentIds = new Set<string>(entities.flatMap(e => e.componentIds));
  return digest({ blueprint: a.blueprint, entities, components: document.components.filter(c => componentIds.has(c.id)) });
}
export function inspectAssembly(document: GameDocumentV2, args: JsonObject): JsonObject {
  if (args.baseRevision !== document.revision) fail('revision-stale', 'Read the current revision before inspecting the assembly.');
  const a = registry(document)[String(args.assemblyId)];
  if (!a) fail('missing', 'Create the assembly prototype first.');
  const problems = inspectBinding(document, a, a.prototype);
  const instances = a.instances.map(b => ({ rootId: b.rootId, problems: inspectBinding(document, a, b) }));
  const failures = instances.filter(i => i.problems.length);
  const pointerParts = parts(a.blueprint).filter(p => {
    const entity = document.entities.find(e => e.id === a.prototype.partIds[String(p.key)]);
    return entity && document.components.some(c => entity.componentIds.includes(c.id) && c.type === 'haiyue.interaction.pointer' && c.enabled);
  }).map(p => String(p.key));
  const opaqueUnconfiguredParts = parts(a.blueprint).filter(p => p.kind !== 'empty' && !pointerParts.includes(String(p.key))).map(p => String(p.key));
  const interaction = { pointerParts, opaqueUnconfiguredParts,
    guidance: pointerParts.length && opaqueUnconfiguredParts.length ? 'These unconfigured mesh parts may occlude configured targets. For decorations choose penetrable=true; alternatively configure pointer events on the visible mesh and map its returned part id to the motion owner. Empty interactions do not prove a background hit. Verify actual native drags and camera invariance.' : 'Bind returned stable part ids. Configure every intended hit surface before replication and test real pointer gestures; role keys are not exact entity names.' };

  return { assemblyId: args.assemblyId!, revision: document.revision, interaction, valid: !problems.length && instances.every(i => !i.problems.length), prototype: { rootId: a.prototype.rootId, partIds: a.prototype.partIds, problems: problems.slice(0,32), problemCount: problems.length }, instanceCount: 1 + instances.length, failures: failures.slice(0,32).map(i => ({ rootId:i.rootId, problems:i.problems.slice(0,8) })), failuresTruncated: failures.length > 32, prototypeDigest: prototypeDigest(document, a), requirements: a.blueprint.requirements!, visualReview: 'Structural checks verify document parts, parent-local transforms and material colors. Inspect multiple preview angles for visibility, occlusion and appearance; this is not a visual verdict.' };
}
export function planAssembly(id: string, args: JsonObject, workspace: ProjectWorkspace, callId: StableId): { operations: GameDocumentOperationV2[]; value: JsonObject } {
  const document = workspace.gameSnapshot(), all = registry(document), assemblyId = String(args.assemblyId);
  const operations: GameDocumentOperationV2[] = [];
  const generated = (role: string) => asStableId(`entity:assembly:${sha256(`${callId}:${role}`).slice(0, 24)}`);
  const make = (recipe: JsonObject, label: string, rootTransform: JsonObject, colors: JsonObject, ordinal: number, source?: Assembly): Binding => {
    const slotKeys = new Set(parts(recipe).flatMap(p => p.colorSlot ? [String(p.colorSlot)] : []));
    if (Object.keys(colors).some(k => !slotKeys.has(k))) fail('slot-invalid', 'Color overrides must use blueprint colorSlot keys.');
    // Blueprint keys (including "root") must never share the implicit root's ID domain.
    const rootId = generated(`${ordinal}:root`), partIds = Object.fromEntries(parts(recipe).map(p => [String(p.key), generated(`${ordinal}:part:${p.key}`)]));
    const sourceIds = source ? new Map([[source.prototype.rootId,rootId], ...Object.entries(source.prototype.partIds).map(([k,id]) => [id,partIds[k]!] as const)]) : new Map<StableId,StableId>();
    const remap = (v: JsonValue): JsonValue => typeof v === 'string' ? sourceIds.get(v as StableId) ?? v : Array.isArray(v) ? v.map(remap) : object(v) ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,remap(x)])) : v;
    const add = (entityId: StableId, name: string, parentId: StableId | null, values: [string, JsonObject][]) => {
      operations.push({ op: 'entity.add', entity: { id: entityId, sceneId: workspace.primarySceneId(), name: name.slice(0,80), parentId, order: document.entities.length + operations.length, componentIds: [] } });
      const oldId = [...sourceIds].find(([,id]) => id === entityId)?.[0];
      const old = document.entities.find(e => e.id === oldId);
      const originals = old ? document.components.filter(c => old.componentIds.includes(c.id)) : [];
      const entries = originals.length ? originals.map(c => ({type:c.type,value:values.find(([type]) => type === c.type)?.[1] ?? c.value,enabled:c.enabled,seed:c.id,version:c.version})) : values.map(([type,value]) => ({type,value,enabled:true,seed:type,version:'1.0.0'}));
      const bodyColor = values.find(([type]) => type === 'haiyue.render.material')?.[1].color;
      for (const c of entries) {
        const value = c.type === 'haiyue.material.pbr' && bodyColor ? {...c.value,baseColor:bodyColor} : c.value;
        operations.push({ op:'component.add',entityId,component:workspace.componentRegistry.create({id:asStableId(`component:assembly:${sha256(`${entityId}:${c.seed}`).slice(0,24)}`),type:asStableId(c.type),version:c.version,enabled:c.enabled,value:remap(value) as JsonObject}) });
      }
    };
    add(rootId, label, null, [['haiyue.transform.3d', rootTransform]]);
    for (const p of parts(recipe)) {
      const values: [string, JsonObject][] = [['haiyue.transform.3d', p.transform as JsonObject]];
      if (p.kind !== 'empty') values.push(['haiyue.render.geometry', { kind: p.kind!, ...(p.radius !== undefined ? { radius: p.radius } : {}), ...(p.segments !== undefined ? { segments: p.segments } : {}), ...(p.plane ? { plane: p.plane } : {}) }], ['haiyue.render.material', { material: p.material!, color: p.colorSlot && colors[String(p.colorSlot)] || p.color! }]);
      add(partIds[String(p.key)]!, `${label} · ${p.key}`, p.parentKey ? partIds[String(p.parentKey)]! : rootId, values);
    }
    // Validate the effective recipe too: slot overrides may not erase promised color separation.
    validateRecipe({ ...recipe, parts: parts(recipe).map(p => ({ ...p, ...(p.colorSlot && colors[String(p.colorSlot)] ? { color: colors[String(p.colorSlot)]! } : {}) })) });
    return { rootId, partIds, colors };
  };
  let value: JsonObject;
  if (id === 'assembly.create') {
    if (all[assemblyId]) fail('exists', 'This assembly already exists. Inspect and repair its prototype instead of recreating it.');
    if (Object.keys(all).length >= 64) fail('budget', 'Assembly registry is full.');
    const recipe = args.blueprint as JsonObject;
    const prototype = make(recipe, String(recipe.name), identity, {}, 0);
    all[assemblyId] = { schemaVersion: 1, blueprint: recipe, prototype, instances: [] };
    value = { assemblyId, prototype: prototype as unknown as JsonObject, nextCall: { toolId: 'assembly.inspect', arguments: { assemblyId, baseRevision: document.revision + 1 } } };
  } else {
    const a = all[assemblyId]; if (!a) fail('missing', 'Create the assembly prototype first.');
    const prototypeIds = new Set([a.prototype.rootId,...Object.values(a.prototype.partIds)]);
    if (document.scripts.some(script => prototypeIds.has(script.entityId as StableId))) fail('prototype-script-binding', 'Keep shared gameplay scripts on an external controller and bind returned instance ids. Script-bearing prototypes cannot be safely replicated without rewriting script references.');
    const problems = inspectBinding(document, a, a.prototype);
    if (problems.length) fail('prototype-invalid', `${problems.slice(0,4).join(' ')} Repair the prototype before replication.`);
    if (args.prototypeDigest !== prototypeDigest(document, a)) fail('prototype-stale', 'The prototype changed. Call assembly.inspect and copy the new prototypeDigest.');
    const created = (args.instances as JsonObject[]).map((i, n) => make(a.blueprint, String(i.name), i.transform as JsonObject, (i.colors ?? {}) as JsonObject, n, a));
    if (a.instances.length + created.length > 256) fail('budget', 'An assembly supports at most 256 instances.');
    all[assemblyId] = { ...a, instances: [...a.instances, ...created] };
    value = { assemblyId, instances: created as unknown as JsonValue, instanceCount: 1 + all[assemblyId]!.instances.length, prototypeRetained: true };
  }
  if (operations.length > 512) fail('batch-too-large', 'This batch exceeds 512 document operations. Request fewer instances; keep the same prototype.');
  const setting = all as unknown as JsonObject;
  if (Buffer.byteLength(canonicalStringify(setting)) > 512 * 1024) fail('budget', 'Assembly definitions exceed the project storage budget.');
  operations.push({ op: 'setting.set', key: SETTING, value: setting });
  return { operations, value };
}

/** Compact approved-plan constraints, stored in the existing durable plan content. */
export const ASSEMBLY_EXPECTATIONS_SCHEMA: JsonObject = { type:'array', maxItems:16, items: schema({ assemblyId:key, label:{type:'string',minLength:1,maxLength:240}, partKeys:{type:'array',minItems:1,maxItems:64,uniqueItems:true,items:key}, distinctColors:{type:'integer',minimum:1,maximum:64}, minimumInstances:{type:'integer',minimum:1,maximum:257} }, ['assemblyId','label','partKeys','minimumInstances']) };
const validateExpectations = ajv.compile(ASSEMBLY_EXPECTATIONS_SCHEMA);
export function normalizeAssemblyExpectations(value: unknown): readonly JsonObject[] {
  if (!validateExpectations(value)) fail('plan-invalid', 'assemblies must declare assemblyId, label, partKeys and minimumInstances.');
  const rows = value as JsonObject[];
  if (new Set(rows.map(r => r.assemblyId)).size !== rows.length) fail('plan-invalid','Assembly ids in the plan must be unique.');
  return structuredClone(rows);
}
export function assertAssemblyPlan(document: GameDocumentV2, expectations: readonly JsonObject[], toolId: string, args: JsonObject): void {
  normalizeAssemblyExpectations(expectations);
  if (!expectations.length) return;
  if (toolId === 'assembly.create') {
    const expected = expectations.find(e => e.assemblyId === args.assemblyId);
    if (!expected || !object(args.blueprint)) fail('plan-mismatch', 'Create an assembly declared in the approved plan.');
    validateRecipe(args.blueprint);
    const recipeParts = parts(args.blueprint), keys = new Set(recipeParts.map(p => p.key));
    if ((expected.partKeys as string[]).some(k => !keys.has(k))) fail('plan-mismatch', `${expected.label}: blueprint omits approved part roles.`);
    const colors = new Set(recipeParts.filter(p => (expected.partKeys as string[]).includes(String(p.key)) && p.color).map(p => canonicalStringify(p.color!)));
    if (expected.distinctColors && colors.size < Number(expected.distinctColors)) fail('plan-mismatch', `${expected.label}: blueprint omits approved independent colors.`);
  }
  if (toolId === 'entity.create-many' && Array.isArray(args.entities) && args.entities.filter(e => object(e) && geometry.includes(String(e.kind))).length > 1) fail('prototype-required', 'The approved plan declares composite assemblies. Build them with assembly.create, inspect the prototype, then use assembly.instantiate; do not substitute a batch of unrelated primitives. Lights and single auxiliary entities remain available.');
  if (!['preview.validate','task.evaluate'].includes(toolId)) return;
  const all = registry(document);
  for (const expected of expectations) {
    const a = all[String(expected.assemblyId)];
    if (!a) fail('plan-incomplete', `${expected.label}: the approved assembly has not been created. Use assembly.create.`);
    if (1 + a.instances.length < Number(expected.minimumInstances)) fail('plan-incomplete', `${expected.label}: needs ${expected.minimumInstances} instances including the prototype; found ${1 + a.instances.length}.`);
    for (const b of [a.prototype, ...a.instances]) {
      const problems = inspectBinding(document,a,b);
      for (const k of expected.partKeys as string[]) if (!b.partIds[k]) problems.push(`Missing approved part ${k}.`);
      const colors = new Set((expected.partKeys as string[]).flatMap(k => {
        const entity = document.entities.find(e => e.id === b.partIds[k]);
        const material = entity && document.components.find(c => entity.componentIds.includes(c.id) && c.type === 'haiyue.render.material' && c.enabled);
        return material?.value.color ? [canonicalStringify(material.value.color)] : [];
      }));
      if (expected.distinctColors && colors.size < Number(expected.distinctColors)) problems.push('Approved color separation is missing.');
      if (problems.length) fail('plan-incomplete', `${expected.label}: ${problems.slice(0,4).join(' ')}`);
    }
  }
}
