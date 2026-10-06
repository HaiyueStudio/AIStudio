import { asStableId, type JsonObject } from '@haiyue/ai-studio-contracts';
import type { SubtaskOptions } from './subtasks.js';

export const TEAM_STATUS_TOOL = Object.freeze({
  id: asStableId('studio.team.inspect'), effect: 'observe', risk: 'low',
  description: 'Experimental Team admission status. Checks whether Studio has a qualified candidate-only delegation port. Does not spawn agents, grant budget or mount the upstream persistent Team service. Call once only when team work is requested.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } as JsonObject,
});
/** Readiness is not qualification. The existing W7 path owns all dispatch and accounting. */
export function teamAdmission(options?: SubtaskOptions): JsonObject {
  return {
    status: options?.enabled && options.qualification ? 'qualification-required' : 'unavailable',
    experimental: true, upstreamTeamMounted: false,
    candidateTool: options?.enabled ? 'studio.task.delegate' : null,
    requirements: ['isolated candidate port', 'immutable real-provider A/B qualification', 'shared parent budget and cancellation', 'single durable Session and task authority'],
    reason: 'Official Team requires sessionPersistence and subagents. Studio has not admitted a second persistent task owner. W7 delegation, when configured, still validates each model, plan and evidence set before dispatch.',
  };
}
