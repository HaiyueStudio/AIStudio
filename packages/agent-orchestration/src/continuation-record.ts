import { asStableId, isPlanTaskV1, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { normalizeConversationNode, type ConversationNodeReadModel } from '@haiyue/ai-studio-shell/conversation';
import { canonicalStringify, redactObject } from '@haiyue/ai-studio-operation-log';
import type { ApprovedPlanExecution } from './plan-policy.js';
import { isRecord } from './value-utils.js';

/** Workflow payload of a Session resolution, not a second task or scheduler. */
export interface ContinuationRecord {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly node: ConversationNodeReadModel;
  readonly taskId: StableId | null;
  readonly instruction: string;
  readonly budgetGranted: boolean;
  readonly plan: ApprovedPlanExecution | null;
}
export function parseContinuationRecord(value: unknown): ContinuationRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || Object.keys(value).sort().join(',') !== 'budgetGranted,id,instruction,node,plan,schemaVersion,taskId'
    || typeof value.id !== 'string' || !/^continuation:[a-f0-9]{64}$/.test(value.id) || typeof value.instruction !== 'string' || !value.instruction.length || value.instruction.length > 16000
    || typeof value.budgetGranted !== 'boolean' || value.taskId !== null && (typeof value.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value.taskId))) throw new Error('continuation.record-invalid');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 262144 || canonicalStringify(redactObject(value as JsonObject).value) !== canonicalStringify(value as JsonObject)) throw new Error('continuation.record-invalid');
  const node = normalizeConversationNode(value.node);
  if (!['question', 'plan', 'approval'].includes(node.kind) || node.status !== 'completed') throw new Error('continuation.node-invalid');
  if (value.plan !== null && (!isRecord(value.plan) || typeof value.plan.title !== 'string' || typeof value.plan.summary !== 'string' || !Array.isArray(value.plan.items)
    || value.plan.items.length > 50 || value.plan.items.some(item => !isRecord(item) || typeof item.id !== 'string' || typeof item.label !== 'string' || item.execution !== undefined && !isPlanTaskV1(item.execution))
    || !Number.isSafeInteger(value.plan.attempts) || Number(value.plan.attempts) < 0 || !Number.isSafeInteger(value.plan.mutationCount) || Number(value.plan.mutationCount) < 0)) throw new Error('continuation.plan-invalid');
  return { schemaVersion: 1, id: asStableId(value.id), node, taskId: value.taskId === null ? null : asStableId(value.taskId as string), instruction: value.instruction,
    budgetGranted: value.budgetGranted, plan: value.plan as unknown as ApprovedPlanExecution | null };
}
