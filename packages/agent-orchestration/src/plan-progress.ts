import { asStableId, type JsonObject } from '@haiyue/ai-studio-contracts';
import { isRecord } from './value-utils.js';
import { PlanProtocolError } from './plan-policy.js';

export const PLAN_PROGRESS_TOOL = Object.freeze({
  id: asStableId('studio.plan.update'), effect: 'observe', risk: 'low',
  description: 'Report execution progress of the user-approved plan, without changing its scope or acceptance criteria. Use exact item IDs returned by studio.plan.propose. Before working on a step mark it in_progress with a concrete short summary; when finishing report completed and start the next step together. Multiple independent steps may be in_progress. Use blocked with the actual blocker, and pending when deferring. Completion is a progress report, never acceptance evidence. Only report changes at step boundaries, not every tool call.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['updates'], properties: {
    updates: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['stepId', 'status', 'summary'], properties: {
      stepId: { type: 'string', minLength: 1, maxLength: 128 }, status: { enum: ['pending', 'in_progress', 'completed', 'blocked'] }, summary: { type: 'string', minLength: 1, maxLength: 512 },
    } } },
  } } as JsonObject,
});

/** Validate all updates before changing any step; model reports cannot change approval or acceptance. */
export function applyPlanProgress(args: JsonObject, items: readonly JsonObject[]): readonly JsonObject[] {
  if (Object.keys(args).some(key => key !== 'updates') || !Array.isArray(args.updates) || !args.updates.length || args.updates.length > 20) throw new PlanProtocolError('plan.progress-invalid', 'Supply 1-20 updates with exact approved stepId, status and a concrete summary.');
  const updates = new Map<string, JsonObject>();
  for (const raw of args.updates) {
    if (!isRecord(raw) || Object.keys(raw).some(key => !['stepId', 'status', 'summary'].includes(key)) || typeof raw.stepId !== 'string'
      || !items.some(item => item.id === raw.stepId && item.status === 'accepted') || updates.has(raw.stepId)
      || !['pending', 'in_progress', 'completed', 'blocked'].includes(String(raw.status)) || typeof raw.summary !== 'string' || !raw.summary.trim() || raw.summary.length > 512) {
      throw new PlanProtocolError('plan.progress-invalid', `Use each approved stepId at most once, status pending/in_progress/completed/blocked and a nonempty summary up to 512 characters. Approved steps: ${JSON.stringify(items.filter(item => item.status === 'accepted').map(item => ({ id: item.id, label: item.label })))}`);
    }
    updates.set(raw.stepId, raw as JsonObject);
  }
  return Object.freeze(items.map(item => {
    const update = updates.get(String(item.id));
    return update ? Object.freeze({ ...item, executionNeedsSync: false, executionStatus: update.status!, executionSummary: String(update.summary).trim() }) : item;
  }));
}

/** Store real operation outcomes alongside model-authored steps. Never infer semantic completion. */
export function recordPlanOperation(content: JsonObject, operation: JsonObject): JsonObject {
  const previous = Array.isArray(content.recentOperations) ? content.recentOperations.filter(isRecord) as JsonObject[] : [];
  const recentOperations = [...previous.filter(item => item.callId !== operation.callId), operation].slice(-8);
  const count = Number(content.progressToolsSinceUpdate ?? 0) + 1;
  const needsSync = content.progressNeedsSync === true || count >= 6;
  const items = Array.isArray(content.items) ? (content.items as JsonObject[]).map(item => isRecord(item) && item.executionStatus === 'in_progress'
    ? { ...item, executionNeedsSync: needsSync, executionOperationIds: [...(Array.isArray(item.executionOperationIds) ? item.executionOperationIds : []), operation.callId].slice(-8) }
    : item) : [];
  return { ...content, items, recentOperations, progressToolsSinceUpdate: count, progressNeedsSync: needsSync };
}
