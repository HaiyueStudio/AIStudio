import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { GameToolDefinition, GameToolEffect, GameToolRisk } from './types.js';

const empty = schema({}, []);
const entityId = Object.freeze({ type: 'string', pattern: '^entity:[A-Za-z0-9._:-]{3,120}$' });
const scriptId = Object.freeze({ type: 'string', pattern: '^script:[A-Za-z0-9._:-]{3,120}$' });
const revision = Object.freeze({ type: 'integer', minimum: 0 });
const entityKind = Object.freeze({ enum: ['empty', 'cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron', 'directional-light', 'point-light', 'ambient-light'] });
const materialKind = Object.freeze({ enum: ['basic', 'pbr', 'blinn-phong', 'normal'] });
const vec3 = Object.freeze({ type: 'object', additionalProperties: false, required: Object.freeze(['x', 'y', 'z']), properties: Object.freeze({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }) });
const transform = Object.freeze({ type: 'object', additionalProperties: false, required: Object.freeze(['position', 'rotationDegrees', 'scale']), properties: Object.freeze({ position: vec3, rotationDegrees: vec3, scale: vec3 }) });
const resultSchema = Object.freeze({ type: 'object' }) as JsonObject;

export const GAME_AUTHORING_TOOL_DEFINITIONS: readonly GameToolDefinition[] = Object.freeze([
  definition('project.snapshot', 'Project snapshot', 'Read the current project identity, revision and log health.', 'observe', 'low', empty, ['studio.project-workspace']),
  definition('scene.list-entities', 'List entities', 'Read a bounded immutable scene entity summary.', 'observe', 'low', empty, ['studio.scene-authoring']),
  definition('entity.get', 'Get entity', 'Read one immutable entity snapshot.', 'observe', 'low', schema({ entityId }, ['entityId']), ['studio.scene-authoring']),
  definition('script.get', 'Get script', 'Read one bounded project script snapshot.', 'observe', 'low', schema({ entityId, scriptId }, [], ['entityId', 'scriptId']), ['studio.script-preview']),
  definition('diagnostics.query', 'Query diagnostics', 'Query bounded redacted Operation Log summaries.', 'observe', 'low', schema({
    severity: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['debug', 'info', 'warning', 'error'] } },
    kinds: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string', maxLength: 96 } },
    sessionId: { type: 'string' }, turnId: { type: 'string' }, toolCallId: { type: 'string' }, entityId: { type: 'string' }, pluginId: { type: 'string' },
    afterSequence: revision, beforeSequence: revision, limit: { type: 'integer', minimum: 1, maximum: 100 }, traverseCorrelation: { type: 'boolean' }, cursor: { type: 'string', maxLength: 2048 },
  }, ['limit', 'traverseCorrelation'], ['severity', 'kinds', 'sessionId', 'turnId', 'toolCallId', 'entityId', 'pluginId', 'afterSequence', 'beforeSequence', 'cursor']), ['studio.diagnostics.query'], 8_000, 64 * 1024),
  definition('entity.create', 'Create entity', 'Create one low-risk authoring-scene entity after the implementation plan is approved, including its initial Transform in the same operation. Use transform here instead of a dependent transform.set call for a new entity. Geometry kinds: cube, sphere, cone, cylinder, plane, torus, icosahedron. Light kinds: directional-light, point-light, ambient-light. Empty is for logic/grouping. Geometry can use Engine materials basic, pbr, blinn-phong, or normal.', 'reversible-edit', 'low', schema({ baseRevision: revision, kind: entityKind, name: { type: 'string', minLength: 1, maxLength: 80 }, parentId: { anyOf: [entityId, { type: 'null' }] }, material: materialKind, transform }, ['kind'], ['baseRevision', 'name', 'parentId', 'material', 'transform']), ['studio.scene-authoring']),
  definition('entity.rename', 'Rename entity', 'Prepare and rename one entity through Document History.', 'reversible-edit', 'medium', schema({ baseRevision: revision, entityId, name: { type: 'string', minLength: 1, maxLength: 80 } }, ['entityId', 'name'], ['baseRevision']), ['studio.scene-authoring'], 10_000, 32 * 1024, true),
  definition('transform.set', 'Set Transform', 'Replace the Transform of an existing entity. entityId is mandatory; when an entity was just created, wait for entity.create to return result.entity.id before calling this tool.', 'reversible-edit', 'medium', schema({ baseRevision: revision, entityId, transform }, ['entityId', 'transform'], ['baseRevision']), ['studio.scene-authoring'], 10_000, 32 * 1024, true),
  definition('material.set', 'Set material', 'Apply one built-in Engine material to an existing geometry entity through Document History.', 'reversible-edit', 'medium', schema({ baseRevision: revision, entityId, material: materialKind }, ['entityId', 'material'], ['baseRevision']), ['studio.scene-authoring'], 10_000, 32 * 1024, true),
  definition('script.propose', 'Propose script', 'Validate an onUpdate function-body script and return a bounded diff proposal without committing. The text runs once per frame with entity, component, world, time, delta and api already in scope; do not use import, export, CommonJS, or a lifecycle-function wrapper. With the scene capability, api.scene.instances(entity, capacity) controls dynamic instance data on one geometry entity.', 'trusted-code', 'high', schema({ baseRevision: revision, entityId, text: { type: 'string', minLength: 1, maxLength: 65536 }, capabilities: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['read', 'input', 'debug', 'scene'] } } }, ['entityId', 'text'], ['baseRevision', 'capabilities']), ['studio.script-preview'], 20_000, 64 * 1024, false, ['text']),
  definition('script.apply', 'Apply script proposal', 'Commit a script proposal through Document History only after script.propose returned zero error diagnostics. If propose reports any error, rewrite the complete function-body script and propose again instead of calling this tool.', 'trusted-code', 'high', schema({ baseRevision: revision, proposalId: { type: 'string', pattern: '^script-proposal:' } }, ['proposalId'], ['baseRevision']), ['studio.script-preview'], 15_000, 32 * 1024, true),
  definition('preview.validate', 'Validate preview', 'Validate a committed script and prepare a trusted preview plan without starting it.', 'runtime-start', 'high', schema({ scriptId, capabilities: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['read', 'input', 'debug', 'scene'] } } }, ['scriptId'], ['capabilities']), ['studio.script-preview'], 20_000, 64 * 1024, false),
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
