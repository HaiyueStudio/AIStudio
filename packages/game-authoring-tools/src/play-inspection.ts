import type { JsonObject, JsonValue } from '@haiyue/ai-studio-contracts';
import { GameToolProtocolError, type GamePlayObservation } from './types.js';

/** Select immutable runtime facts, never execute model-supplied code against the World. */
export function scopePlayInspection(observation: GamePlayObservation, args: JsonObject): GamePlayObservation {
  if (!Array.isArray(args.entityIds) && args.includeGameplay !== false) return observation;
  const value: Record<string, JsonValue> = { ...observation.value };
  if (Array.isArray(args.entityIds)) {
    const state = value.state;
    if (!isRecord(state) || !Array.isArray(state.entities)) {
      throw new GameToolProtocolError('observation.entity-state-unavailable', 'This Play snapshot has no authoritative entity state; restart the preview before querying entities.');
    }
    const byId = new Map(state.entities.flatMap(item => isRecord(item) && typeof item.id === 'string' ? [[item.id, item] as const] : []));
    const ids = args.entityIds as readonly string[];
    value.state = { ...state, entities: ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) };
    value.selection = { entityIds: ids, missingEntityIds: ids.filter(id => !byId.has(id)), totalEntityCount: state.entities.length, transformSpace: 'parent-local', worldMatrixSpace: 'world', worldMatrixLayout: 'column-major', rotationUnit: 'radians' };
  }
  if (args.includeGameplay === false) delete value.gameplay;
  value.inspectionScope = { entities: Array.isArray(args.entityIds) ? 'selected' : 'all', gameplayIncluded: args.includeGameplay !== false };
  // Persist this exact selected snapshot so evaluator paths agree with the returned projection.
  // Keep camera, errors and traces even when selecting entities: unrelated errors must not disappear.
  return Object.freeze({ ...observation, value: Object.freeze(value) });
}

function isRecord(value: unknown): value is JsonObject { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
