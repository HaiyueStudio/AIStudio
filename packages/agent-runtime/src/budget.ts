import type { TaskBudgetV2, UsageRecordV2 } from '@haiyue/ai-studio-contracts';

export type BudgetMetric = keyof TaskBudgetV2['limits'];
export interface BudgetConsumption {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicros: number;
  readonly wallTimeMs: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly repairIterations: number;
  readonly observationBytes: number;
}
export interface BudgetDecision {
  readonly allowed: boolean;
  readonly status: 'within' | 'soft-exceeded' | 'hard-exceeded';
  readonly violations: readonly Readonly<{ metric: BudgetMetric; current: number; projected: number; limit: number }>[];
  readonly warning: string | null;
  readonly hardStopLatched: boolean;
}

export class TaskBudgetController {
  private consumptionValue: BudgetConsumption = emptyConsumption();
  private hardStopLatched = false;
  constructor(readonly budget: TaskBudgetV2) { validateTaskBudget(budget); }

  preflight(reservation: Partial<BudgetConsumption>): BudgetDecision {
    validateReservation(reservation);
    if (this.hardStopLatched) return this.decision(false, 'hard-exceeded', this.violations(this.consumptionValue), 'Hard budget stop is already latched.');
    const projected = addConsumption(this.consumptionValue, reservation);
    const violations = this.violations(projected);
    if (violations.length && this.budget.enforcement === 'hard') { this.hardStopLatched = true; return this.decision(false, 'hard-exceeded', violations, 'Hard budget would be exceeded; execution is blocked before the next effect.'); }
    if (violations.length && this.budget.enforcement === 'soft') return this.decision(true, 'soft-exceeded', violations, 'Soft budget exceeded; execution may continue with a visible warning.');
    return this.decision(true, 'within', [], null);
  }

  commit(reservation: Partial<BudgetConsumption>): BudgetDecision {
    const preflight = this.preflight(reservation); if (!preflight.allowed) return preflight;
    this.consumptionValue = Object.freeze(addConsumption(this.consumptionValue, reservation)); return this.state();
  }

  reconcileUsage(usage: UsageRecordV2, estimatedCostMicros: number | null): BudgetDecision {
    const next = {
      ...this.consumptionValue,
      inputTokens: usage.inputTokens ?? this.consumptionValue.inputTokens,
      outputTokens: usage.outputTokens ?? this.consumptionValue.outputTokens,
      wallTimeMs: usage.wallTimeMs,
      observationBytes: usage.toolOutputBytes,
      ...(estimatedCostMicros === null ? {} : { estimatedCostMicros }),
    };
    this.consumptionValue = Object.freeze(next);
    const violations = this.violations(next);
    if (violations.length && this.budget.enforcement === 'hard') this.hardStopLatched = true;
    return this.state();
  }

  state(): BudgetDecision {
    const violations = this.violations(this.consumptionValue);
    const status = this.hardStopLatched ? 'hard-exceeded' : violations.length && this.budget.enforcement === 'soft' ? 'soft-exceeded' : 'within';
    return this.decision(!this.hardStopLatched, status, violations, status === 'soft-exceeded' ? 'Soft budget is exceeded.' : this.hardStopLatched ? 'Hard budget stop is latched.' : null);
  }
  consumption(): BudgetConsumption { return this.consumptionValue; }

  private violations(projected: BudgetConsumption): Array<{ metric: BudgetMetric; current: number; projected: number; limit: number }> {
    const result: Array<{ metric: BudgetMetric; current: number; projected: number; limit: number }> = [];
    for (const metric of metrics) {
      const limit = this.budget.limits[metric]; if (limit !== null && projected[metric] > limit) result.push({ metric, current: this.consumptionValue[metric], projected: projected[metric], limit });
    }
    return result;
  }
  private decision(allowed: boolean, status: BudgetDecision['status'], violations: readonly BudgetDecision['violations'][number][], warning: string | null): BudgetDecision {
    return Object.freeze({ allowed, status, violations: Object.freeze(violations.map((entry) => Object.freeze(entry))), warning, hardStopLatched: this.hardStopLatched });
  }
}

export function validateTaskBudget(value: unknown): TaskBudgetV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.id !== 'string' || !isRecord(value.limits) || !['observe', 'soft', 'hard'].includes(String(value.enforcement))) throw new BudgetError('budget.invalid', 'Task budget envelope is invalid.');
  for (const metric of metrics) {
    const limit = value.limits[metric]; if (limit !== null && (!Number.isSafeInteger(limit) || (limit as number) < (metric === 'repairIterations' ? 0 : 1))) throw new BudgetError('budget.limit-invalid', `Budget limit ${metric} is invalid.`);
  }
  return deepFreeze(value) as unknown as TaskBudgetV2;
}
export class BudgetError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'BudgetError'; } }

function emptyConsumption(): BudgetConsumption { return Object.freeze({ inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0, wallTimeMs: 0, turns: 0, toolCalls: 0, repairIterations: 0, observationBytes: 0 }); }
function addConsumption(base: BudgetConsumption, delta: Partial<BudgetConsumption>): BudgetConsumption { return Object.fromEntries(metrics.map((metric) => [metric, base[metric] + (delta[metric] ?? 0)])) as unknown as BudgetConsumption; }
function validateReservation(value: Partial<BudgetConsumption>): void { for (const [key, amount] of Object.entries(value)) if (!metrics.includes(key as BudgetMetric) || !Number.isSafeInteger(amount) || amount! < 0) throw new BudgetError('budget.reservation-invalid', `Budget reservation ${key} is invalid.`); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
const metrics: readonly BudgetMetric[] = ['inputTokens', 'outputTokens', 'estimatedCostMicros', 'wallTimeMs', 'turns', 'toolCalls', 'repairIterations', 'observationBytes'];
