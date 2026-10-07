import type { JsonObject } from '@haiyue/ai-studio-contracts';
import type { ApprovedPlanExecution } from './plan-policy.js';
import { PlanProtocolError } from './plan-policy.js';

type Items = ApprovedPlanExecution['items'];
/** Closure uses the approved graph only. Missing graph metadata keeps the whole-task barrier. */
export function questionBlockedSteps(items: Items, roots: readonly string[]): ReadonlySet<string> | null {
  if (!roots.length || !items.length || items.some(i => !i.execution) || roots.some(id => !items.some(i => i.id === id))) return null;
  const blocked = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    const tasks = new Set(items.filter(i => blocked.has(i.id)).map(i => i.execution!.id));
    for (const item of items) if (!blocked.has(item.id) && item.execution!.dependsOn.some(id => tasks.has(id))) { blocked.add(item.id); changed = true; }
  }
  return blocked;
}
export function validateQuestionSteps(items: Items, value: readonly string[] | undefined): readonly string[] {
  if (!value) return [];
  if (!questionBlockedSteps(items, value) || value.some(id => items.find(i => i.id === id)?.executionStatus === 'completed'))
    throw new PlanProtocolError('question.steps-invalid', 'Bind the question to unfinished approved item IDs from a complete execution graph.');
  return [...value];
}
/** Only exact entity-local edits have a proven scope here; broader tools retain the barrier.
 * The normal tool validator, plan approval, exact revision and user constraints still apply. */
export function independentQuestionEdit(items: Items, roots: readonly string[], toolId: string, args: JsonObject): boolean {
  const blocked = questionBlockedSteps(items, roots);
  if (!blocked) return false;
  const targets: string[] = [];
  if (['transform.set', 'material.set'].includes(toolId) && typeof args.entityId === 'string') targets.push(args.entityId);
  // Do not infer targets from arbitrary tool arguments or caller-controlled effect metadata.
  if (!targets.length) return false;
  const waiting = items.filter(i => blocked.has(i.id));
  if (waiting.some(i => !i.execution!.readScopes.length && !i.execution!.writeScopes.length)) return false;
  if (waiting.some(i => [...i.execution!.readScopes, ...i.execution!.writeScopes].some(scope => scope === 'document:current' || scope === '*' || targets.includes(scope)))) return false;
  return items.some(i => !blocked.has(i.id) && i.executionStatus === 'in_progress'
    && i.execution!.dependsOn.every(id => items.some(p => p.execution?.id === id && p.executionStatus === 'completed'))
    && targets.every(target => i.execution!.writeScopes.includes(target)));
}
