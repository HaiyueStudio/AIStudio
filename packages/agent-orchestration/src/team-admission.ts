import { asStableId, type JsonObject } from '@haiyue/ai-studio-contracts';
import type { SubtaskOptions } from './subtasks.js';
import type { ApprovedPlanExecution } from './plan-policy.js';

export const TEAM_STATUS_TOOL = Object.freeze({
  id: asStableId('studio.team.inspect'), effect: 'observe', risk: 'low',
  description: 'Experimental Team admission status. Checks whether Studio has a qualified candidate-only delegation port. Does not spawn agents, grant budget or mount the upstream persistent Team service. Call once only when team work is requested.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } as JsonObject,
});
/** Readiness is not qualification. The existing W7 path owns all dispatch and accounting. */
export function teamAdmission(options?: SubtaskOptions, configuredFactory = false, plan?: ApprovedPlanExecution | null): JsonObject {
  return {
    status: (configuredFactory || options?.enabled && options.qualification) ? 'qualification-required' : 'unavailable',
    experimental: true, upstreamTeamMounted: false,
    taskAuthority: 'studio-approved-plan', nativeAdmission: 'blocked',
    nativeAdapters: { sessionPersistence: 'available', requestAdmission: 'available' },
    nativeBlockers: ['team-product-authority-binding-required', 'team-real-provider-qualification-required'],
    // Detached read projection only. No Team-local ids, revisions, owners or writable task board.
    tasks: (plan?.items ?? []).map(item => ({ stepId: item.id, taskId: item.execution?.id ?? null,
      label: item.label, status: item.executionStatus ?? 'pending', dependsOn: [...(item.execution?.dependsOn ?? [])],
      writeScopes: [...(item.execution?.writeScopes ?? [])] })),
    candidateTool: (configuredFactory || options?.enabled) ? 'studio.task.delegate' : null,
    requirements: ['isolated candidate port', 'immutable real-provider A/B qualification', 'shared parent budget and cancellation', 'single durable Session and task authority'],
    reason: 'Official Team writes its Lead Session journal and resumes teammates through subagents. Studio has an opt-in journal and request-admission adapter; product identity binding, reconciled parent accounting and Team-specific qualification are still required before mounting it. This read-only view comes from the approved Studio plan; candidate delegation remains subject to W7 qualification.',
  };
}
