import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { GameToolDefinition, GameToolEffect, GameToolRisk } from './types.js';

const empty = schema({}, []);
const entityId = Object.freeze({ type: 'string', pattern: '^entity:[A-Za-z0-9._:-]{3,120}$' });
const scriptId = Object.freeze({ type: 'string', pattern: '^script:[A-Za-z0-9._:-]{3,120}$' });
const revision = Object.freeze({ type: 'integer', minimum: 0 });
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
  definition('entity.create', 'Create entity', 'Create one authoring-scene entity through Document History. Use kind "cube" for visible/renderable game objects; kind "empty" is a non-renderable logic/group node. A scene must contain at least one Cube before preview.validate or preview.start.', 'reversible-edit', 'medium', schema({ baseRevision: revision, kind: { enum: ['empty', 'cube'] }, name: { type: 'string', minLength: 1, maxLength: 80 }, parentId: { anyOf: [entityId, { type: 'null' }] } }, ['baseRevision', 'kind'], ['name', 'parentId']), ['studio.scene-authoring'], 10_000, 32 * 1024, true),
  definition('entity.rename', 'Rename entity', 'Prepare and rename one entity through Document History.', 'reversible-edit', 'medium', schema({ baseRevision: revision, entityId, name: { type: 'string', minLength: 1, maxLength: 80 } }, ['baseRevision', 'entityId', 'name']), ['studio.scene-authoring'], 10_000, 32 * 1024, true),
  definition('transform.set', 'Set Transform', 'Prepare and replace an entity Transform through Document History.', 'reversible-edit', 'medium', schema({ baseRevision: revision, entityId, transform }, ['baseRevision', 'entityId', 'transform']), ['studio.scene-authoring'], 10_000, 32 * 1024, true),
  definition('script.propose', 'Propose script', 'Validate an onUpdate function-body script and return a bounded diff proposal without committing. The text runs once per frame with entity, component, world, time, delta and api already in scope; do not use import, export, CommonJS, or a lifecycle-function wrapper.', 'trusted-code', 'high', schema({ baseRevision: revision, entityId, text: { type: 'string', minLength: 1, maxLength: 65536 }, capabilities: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['read', 'input', 'debug', 'scene-mutation'] } } }, ['baseRevision', 'entityId', 'text'], ['capabilities']), ['studio.script-preview'], 20_000, 64 * 1024, false, ['text']),
  definition('script.apply', 'Apply script proposal', 'Commit a previously validated script proposal through Document History.', 'trusted-code', 'high', schema({ baseRevision: revision, proposalId: { type: 'string', pattern: '^script-proposal:' } }, ['baseRevision', 'proposalId']), ['studio.script-preview'], 15_000, 32 * 1024, true),
  definition('preview.validate', 'Validate preview', 'Validate a committed script and prepare a trusted preview plan without starting it.', 'runtime-start', 'high', schema({ scriptId, capabilities: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['read', 'input', 'debug', 'scene-mutation'] } } }, ['scriptId'], ['capabilities']), ['studio.script-preview'], 20_000, 64 * 1024, false),
  definition('preview.start', 'Start preview', 'Start an exact validated trusted preview plan after one-shot authorization.', 'runtime-start', 'high', schema({ baseRevision: revision, planId: { type: 'string', pattern: '^preview-plan:' } }, ['baseRevision', 'planId']), ['studio.script-preview', 'studio.preview-control'], 15_000, 32 * 1024, true),
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
