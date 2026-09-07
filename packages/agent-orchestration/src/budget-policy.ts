import { asStableId, type TaskBudgetV2 } from '@haiyue/ai-studio-contracts';
import type { BudgetDecision, TaskAccount } from '@haiyue/ai-studio-agent-runtime';

export function budgetMetricLabel(metric: BudgetDecision['violations'][number]['metric']): string {
  return ({ inputTokens: '输入 token', outputTokens: '输出 token', estimatedCostMicros: '预计成本', wallTimeMs: '执行时间', turns: '回合数', toolCalls: '工具调用数', repairIterations: '修复次数', observationBytes: '工具结果字节数' } as const)[metric];
}
export function budgetContinuationRequest(goal: string, projectOpen: boolean): string {
  return [
    projectOpen ? 'Continue the visible task against the current project after a user-approved budget checkpoint.' : 'The project closed while waiting at a budget checkpoint; report that the task cannot safely continue.',
    `Visible goal: ${goal.slice(0, 2_048)}`,
    'Inspect authoritative project state before acting. Preserve and reuse completed work, do not recreate working scene content, and retry only the interrupted step. If project mutations are not covered by an already approved plan, propose a plan before editing.',
  ].join('\n\n');
}
export const DEFAULT_TASK_BUDGET: TaskBudgetV2 = Object.freeze({ schemaVersion: 2, id: asStableId('budget:conversation-default'), enforcement: 'hard', limits: Object.freeze({
  inputTokens: 200_000, outputTokens: 50_000, estimatedCostMicros: 2_000_000, wallTimeMs: 10 * 60_000, turns: 12, toolCalls: 100, repairIterations: 5, observationBytes: 5_000_000,
}) });
export function assertBudgetAllowed(decision: Readonly<{ allowed: boolean; warning: string | null }>): void { if (!decision.allowed) throw new BudgetStopError(decision.warning ?? 'Task budget is exhausted.'); }
export class BudgetStopError extends Error { readonly code = 'budget.hard-stop'; constructor(message: string) { super(message); this.name = 'BudgetStopError'; } }
export interface WallTimeBudget { pause(): void; resume(): void; resetAfterContinuation(): void; dispose(): void; }
export function armWallTimeBudget(controller: AbortController, account: TaskAccount): WallTimeBudget {
  if (account.options.budget.enforcement !== 'hard') return Object.freeze({ pause() {}, resume() {}, resetAfterContinuation() {}, dispose() {} });
  let remaining = (account.snapshot().budget.limits.wallTimeMs ?? Number.MAX_SAFE_INTEGER) - account.snapshot().consumption.wallTimeMs;
  let armedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pauseDepth = 0;
  let disposed = false;
  const expire = (): void => {
    timer = null; remaining = 0;
    account.expireWallTime();
  };
  const arm = (): void => {
    if (disposed || pauseDepth > 0 || controller.signal.aborted) return;
    if (remaining <= 0) { expire(); return; }
    armedAt = Date.now(); timer = setTimeout(expire, remaining);
  };
  arm();
  return Object.freeze({
    pause(): void {
      if (disposed) return;
      pauseDepth += 1;
      if (pauseDepth !== 1 || timer === null) return;
      clearTimeout(timer); timer = null;
      remaining = Math.max(0, remaining - (Date.now() - armedAt));
    },
    resume(): void {
      if (disposed || pauseDepth === 0) return;
      pauseDepth -= 1;
      if (pauseDepth === 0) arm();
    },
    resetAfterContinuation(): void {
      if (disposed) return;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      const snapshot = account.snapshot();
      remaining = Math.max(1, (snapshot.budget.limits.wallTimeMs ?? Number.MAX_SAFE_INTEGER) - snapshot.consumption.wallTimeMs);
      if (pauseDepth === 0) arm();
    },
    dispose(): void { if (disposed) return; disposed = true; if (timer !== null) clearTimeout(timer); timer = null; },
  });
}
