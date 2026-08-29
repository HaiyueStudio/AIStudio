import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { GameToolDefinition, GameToolEffect, GameToolRisk } from './types.js';

const empty = schema({}, []);
const entityId = Object.freeze({ type: 'string', pattern: '^entity:[A-Za-z0-9._:-]{3,120}$' });
const scriptId = Object.freeze({ type: 'string', pattern: '^script:[A-Za-z0-9._:-]{3,120}$' });
const componentId = Object.freeze({ type: 'string', pattern: '^component:[A-Za-z0-9._:-]{3,160}$' });
const componentType = Object.freeze({ type: 'string', pattern: '^[a-z][a-z0-9._:-]{2,159}$' });
const componentVersion = Object.freeze({ type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' });
const componentValue = Object.freeze({ type: 'object', maxProperties: 256 });
const revision = Object.freeze({ type: 'integer', minimum: 0 });
const assetId = Object.freeze({ type: 'string', pattern: '^asset:[a-f0-9]{24}$' });
const assetKind = Object.freeze({ enum: ['texture', 'model', 'audio', 'animation'] });
const assetUsage = Object.freeze({ enum: ['texture.base-color', 'texture.metallic-roughness', 'texture.normal', 'texture.occlusion', 'texture.emissive', 'texture.environment-diffuse', 'texture.environment-specular', 'model', 'audio', 'animation'] });
const entityKind = Object.freeze({ enum: ['empty', 'cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron', 'directional-light', 'point-light', 'ambient-light'] });
const materialKind = Object.freeze({ enum: ['basic', 'pbr', 'blinn-phong', 'normal'] });
const materialColor = Object.freeze({ type: 'array', minItems: 4, maxItems: 4, items: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }) });
const vec3 = Object.freeze({ type: 'object', additionalProperties: false, required: Object.freeze(['x', 'y', 'z']), properties: Object.freeze({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }) });
const transform = Object.freeze({ type: 'object', additionalProperties: false, required: Object.freeze(['position', 'rotationDegrees', 'scale']), properties: Object.freeze({ position: vec3, rotationDegrees: vec3, scale: vec3 }) });
const camera = Object.freeze({
  type: 'object', additionalProperties: false,
  required: Object.freeze(['projection', 'target', 'distance', 'azimuthDegrees', 'elevationDegrees', 'fovDegrees', 'orthographicSize', 'near', 'far']),
  properties: Object.freeze({
    projection: { enum: ['perspective', 'orthographic'] }, target: vec3,
    distance: { type: 'number', minimum: 0.5, maximum: 500 },
    azimuthDegrees: { type: 'number', minimum: -360, maximum: 360 },
    elevationDegrees: { type: 'number', minimum: -89.9, maximum: 90 },
    fovDegrees: { type: 'number', minimum: 10, maximum: 120 },
    orthographicSize: { type: 'number', minimum: 0.5, maximum: 500 },
    near: { type: 'number', minimum: 0.01, maximum: 100 },
    far: { type: 'number', minimum: 0.1, maximum: 10_000 },
  }),
});
const resultSchema = Object.freeze({ type: 'object' }) as JsonObject;

export const GAME_AUTHORING_TOOL_DEFINITIONS: readonly GameToolDefinition[] = Object.freeze([
  definition('project.snapshot', 'Project snapshot', 'Read the current project identity, revision and log health.', 'observe', 'low', empty, ['studio.project-workspace']),
  definition('engine.capabilities.describe', 'Describe engine capabilities', 'Read the frozen Component Registry capability manifest and its digest. Use this before adding gameplay components.', 'observe', 'low', empty, ['studio.component-registry']),
  definition('component.describe', 'Describe component', 'Read one versioned component schema, defaults, runtime adapter, effect and risk from the authoritative registry.', 'observe', 'low', schema({ type: componentType, version: componentVersion }, ['type'], ['version']), ['studio.component-registry']),
  definition('component.get', 'Get component', 'Read one component by id, or the first matching component on an entity by type and optional version.', 'observe', 'low', schema({ componentId, entityId, type: componentType, version: componentVersion }, [], ['componentId', 'entityId', 'type', 'version']), ['studio.project-workspace']),
  definition('camera.get', 'Get camera', 'Read the persisted main project camera used by both the authoring viewport and isolated game preview.', 'observe', 'low', empty, ['studio.project-workspace']),
  definition('scene.list-entities', 'List entities', 'Read a bounded immutable scene entity summary.', 'observe', 'low', empty, ['studio.scene-authoring']),
  definition('entity.get', 'Get entity', 'Read one immutable entity snapshot.', 'observe', 'low', schema({ entityId }, ['entityId']), ['studio.scene-authoring']),
  definition('script.get', 'Get script', 'Read one bounded project script snapshot.', 'observe', 'low', schema({ entityId, scriptId }, [], ['entityId', 'scriptId']), ['studio.script-preview']),
  definition('diagnostics.query', 'Query diagnostics', 'Query bounded redacted Operation Log summaries.', 'observe', 'low', schema({
    severity: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['debug', 'info', 'warning', 'error'] } },
    kinds: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string', maxLength: 96 } },
    sessionId: { type: 'string' }, turnId: { type: 'string' }, toolCallId: { type: 'string' }, entityId: { type: 'string' }, pluginId: { type: 'string' },
    afterSequence: revision, beforeSequence: revision, limit: { type: 'integer', minimum: 1, maximum: 100 }, traverseCorrelation: { type: 'boolean' }, cursor: { type: 'string', maxLength: 2048 },
  }, ['limit', 'traverseCorrelation'], ['severity', 'kinds', 'sessionId', 'turnId', 'toolCallId', 'entityId', 'pluginId', 'afterSequence', 'beforeSequence', 'cursor']), ['studio.diagnostics.query'], 8_000, 64 * 1024),
  definition('asset.search', 'Search project assets', 'Search the bounded controlled project asset catalog by text and kind.', 'observe', 'low', schema({ text: { type: 'string', maxLength: 256 }, kind: assetKind, limit: { type: 'integer', minimum: 1, maximum: 200 } }, [], ['text', 'kind', 'limit']), ['studio.project-workspace']),
  definition('camera.set', 'Set camera', 'Replace the persisted main project camera through Document History. Call camera.get first and submit a complete camera. elevationDegrees is the angle above the ground plane; use 90 for a straight top-down view. For board games, orthographic projection avoids perspective distortion and orthographicSize controls the visible board height.', 'reversible-edit', 'low', schema({ baseRevision: revision, camera }, ['camera'], ['baseRevision']), ['studio.project-workspace']),
  definition('entity.create', 'Create entity', 'Create one low-risk authoring-scene entity after the implementation plan is approved, including its initial Transform and entity-specific material appearance in the same operation. Use transform here instead of a dependent transform.set call for a new entity. Geometry kinds: cube, sphere, cone, cylinder, plane, torus, icosahedron. Light kinds: directional-light, point-light and ambient-light. Empty is for logic/grouping. Geometry supports Engine material types basic, pbr, blinn-phong and normal plus an RGBA color with normalized 0..1 channels. Give visually distinct gameplay roles deliberate colors.', 'reversible-edit', 'low', schema({ baseRevision: revision, kind: entityKind, name: { type: 'string', minLength: 1, maxLength: 80 }, parentId: { anyOf: [entityId, { type: 'null' }] }, material: materialKind, color: materialColor, transform }, ['kind'], ['baseRevision', 'name', 'parentId', 'material', 'color', 'transform']), ['studio.scene-authoring']),
  definition('entity.rename', 'Rename entity', 'Prepare and rename one entity through Document History.', 'reversible-edit', 'medium', schema({ baseRevision: revision, entityId, name: { type: 'string', minLength: 1, maxLength: 80 } }, ['entityId', 'name'], ['baseRevision']), ['studio.scene-authoring'], 10_000, 32 * 1024, true),
  definition('transform.set', 'Set Transform', 'Replace the Transform of an existing entity. entityId is mandatory; when an entity was just created, wait for entity.create to return result.entity.id before calling this tool.', 'reversible-edit', 'medium', schema({ baseRevision: revision, entityId, transform }, ['entityId', 'transform'], ['baseRevision']), ['studio.scene-authoring'], 10_000, 32 * 1024, true),
  definition('material.set', 'Set material appearance', 'Create or replace the entity-specific material appearance of an existing geometry entity through Document History. Choose a built-in Engine material type and optionally an RGBA color with normalized 0..1 channels.', 'reversible-edit', 'medium', schema({ baseRevision: revision, entityId, material: materialKind, color: materialColor }, ['entityId', 'material'], ['baseRevision', 'color']), ['studio.scene-authoring'], 10_000, 32 * 1024, true),
  definition('component.add', 'Add component', 'Create a registry-validated component on an entity through the shared Document History path. Effect, risk, defaults and runtime ownership are derived from the registered component definition.', 'reversible-edit', 'high', schema({ baseRevision: revision, entityId, type: componentType, version: componentVersion, enabled: { type: 'boolean' }, value: componentValue }, ['entityId', 'type'], ['baseRevision', 'version', 'enabled', 'value']), ['studio.project-workspace', 'studio.component-registry'], 10_000, 64 * 1024, true),
  definition('component.set', 'Set component', 'Replace the complete value of an existing component through Document History after registry validation. Effect and risk are derived from the existing component definition.', 'reversible-edit', 'high', schema({ baseRevision: revision, componentId, enabled: { type: 'boolean' }, value: componentValue }, ['componentId', 'value'], ['baseRevision', 'enabled']), ['studio.project-workspace', 'studio.component-registry'], 10_000, 64 * 1024, true),
  definition('component.remove', 'Remove component', 'Remove one component through Document History. The exact target, effect and risk are derived from the current document and registry.', 'reversible-edit', 'high', schema({ baseRevision: revision, componentId }, ['componentId'], ['baseRevision']), ['studio.project-workspace', 'studio.component-registry'], 10_000, 32 * 1024, true),
  definition('asset.import', 'Register project asset', 'Validate and register one file already contained under the project assets directory with explicit kind, format, decode budget, license and provenance. Texture imports must include width and height matching the file header; external model or animation URI fields are rejected.', 'reversible-edit', 'high', schema({ baseRevision: revision, projectPath: { type: 'string', minLength: 8, maxLength: 512 }, kind: assetKind, mimeType: { type: 'string', minLength: 3, maxLength: 128 }, license: { enum: ['project-owned', 'cc0', 'cc-by-4.0', 'internal-test'] }, provenance: { type: 'string', minLength: 1, maxLength: 512 }, decodedBytes: { type: 'integer', minimum: 1, maximum: 134217728 }, width: { type: 'integer', minimum: 1, maximum: 8192 }, height: { type: 'integer', minimum: 1, maximum: 8192 } }, ['projectPath', 'kind', 'mimeType', 'license', 'provenance', 'decodedBytes'], ['baseRevision', 'width', 'height']), ['studio.project-workspace'], 20_000, 32 * 1024, true, ['projectPath']),
  definition('asset.assign', 'Assign project asset', 'Assign a catalog asset to a compatible runtime component on one entity through the shared Document History path.', 'reversible-edit', 'high', schema({ baseRevision: revision, entityId, assetId, usage: assetUsage }, ['entityId', 'assetId', 'usage'], ['baseRevision']), ['studio.project-workspace', 'studio.component-registry'], 10_000, 32 * 1024, true),
  definition('script.propose', 'Propose script', 'Validate an onUpdate function-body script and return a bounded diff proposal without committing. The text runs once per fixed Play tick with entity, component, world, time, delta and api already in scope; time and delta are milliseconds. Do not use import, export, CommonJS, or a lifecycle-function wrapper. api.scene.instances controls dynamic instance data. api.physics exposes bounded body, collision/trigger event, grounded, force/impulse, velocity, raycast and overlap operations backed by configured Engine physics components. Studio infers scene and physics capabilities from source; reuse the returned capabilities for preview.validate.', 'trusted-code', 'high', schema({ baseRevision: revision, entityId, text: { type: 'string', minLength: 1, maxLength: 65536 }, capabilities: { type: 'array', maxItems: 6, uniqueItems: true, items: { enum: ['read', 'input', 'debug', 'scene', 'physics', 'asset'] } } }, ['entityId', 'text'], ['baseRevision', 'capabilities']), ['studio.script-preview'], 20_000, 64 * 1024, false, ['text']),
  definition('script.apply', 'Apply script proposal', 'Commit a script proposal through Document History only after script.propose returned zero error diagnostics. If propose reports any error, rewrite the complete function-body script and propose again instead of calling this tool.', 'trusted-code', 'high', schema({ baseRevision: revision, proposalId: { type: 'string', pattern: '^script-proposal:' } }, ['proposalId'], ['baseRevision']), ['studio.script-preview'], 15_000, 32 * 1024, true),
  definition('preview.validate', 'Validate preview', 'Validate the complete enabled project script set and prepare one trusted Play plan without starting it. By default every enabled script runs in stable order. Supply scriptIds only for an explicit bounded subset; capabilities are inferred independently from each committed script.', 'runtime-start', 'high', schema({ scriptIds: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: scriptId } }, [], ['scriptIds']), ['studio.script-preview'], 20_000, 64 * 1024, false),
  definition('preview.start', 'Start preview', 'Start an exact validated trusted preview plan after one-shot authorization.', 'runtime-start', 'high', schema({ baseRevision: revision, planId: { type: 'string', pattern: '^preview-plan:' } }, ['planId'], ['baseRevision']), ['studio.script-preview', 'studio.preview-control'], 15_000, 32 * 1024, true),
  definition('preview.stop', 'Stop preview', 'Stop and release the currently owned preview runtime.', 'runtime-start', 'medium', empty, ['studio.preview-control'], 10_000, 16 * 1024, false),
]);

export const GAME_AUTHORING_TOOL_BY_ID: ReadonlyMap<StableId, GameToolDefinition> = new Map(GAME_AUTHORING_TOOL_DEFINITIONS.map((item) => [item.id, item]));

function definition(
  id: string, title: string, description: string, effect: GameToolEffect, risk: GameToolRisk, inputSchema: JsonObject,
  capabilities: readonly string[], timeoutMs = 10_000, maxResultBytes = 32 * 1024, requiresApproval = false, redactedFields: readonly string[] = [],
): GameToolDefinition {
  return Object.freeze({
    schemaVersion: 1, id: asStableId(id), version: '1.0.0', title, description, effect, risk,
    requiredCapabilities: Object.freeze(capabilities.map((item) => asStableId(item))), inputSchema, outputSchema: resultSchema,
    redactedFields: Object.freeze([...redactedFields]), presentation: Object.freeze({ intent: title, result: `${title} result` }),
    timeoutMs, maxResultBytes, requiresApproval,
  });
}

function schema(properties: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): JsonObject {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(properties).some((key) => !allowed.has(key))) throw new Error('Schema property is not classified as required or optional.');
  return Object.freeze({ type: 'object', additionalProperties: false, required: Object.freeze([...required]), properties: Object.freeze(properties) }) as JsonObject;
}
