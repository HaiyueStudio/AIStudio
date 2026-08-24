import { asStableId, type CostRecordV2, type PricingCatalogV1, type StableId, type TaskBudgetV2, type UsageRecordV2 } from '@haiyue/ai-studio-contracts';
import { TaskBudgetController, type BudgetDecision } from './budget.js';
import { PricingEngine, type CostEstimate } from './pricing.js';
import type { UsageLedgerSnapshot, UsageLedgerStore } from './usage-ledger.js';

export interface TaskAccountingOptions {
  readonly taskId: StableId;
  readonly budget: TaskBudgetV2;
  readonly pricingCatalog: PricingCatalogV1;
}

export interface TaskCostSummary {
  readonly status: CostRecordV2['status'];
  readonly amountMicros: number | null;
  readonly currency: string | null;
  readonly cacheSavingMicros: number | null;
  readonly explanation: string;
  readonly final: boolean;
  readonly recordIds: readonly string[];
  readonly pricingCatalogId: string | null;
  readonly pricingCatalogVersion: string | null;
  readonly effectiveAt: string | null;
}

export interface TaskAccountingSnapshot {
  readonly taskId: StableId;
  readonly budget: TaskBudgetV2;
  readonly budgetDecision: BudgetDecision;
  readonly consumption: ReturnType<TaskBudgetController['consumption']>;
  readonly usage: Readonly<{ inputTokens: number | null; cachedInputTokens: number | null; cacheWriteTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; toolInputBytes: number; toolOutputBytes: number; wallTimeMs: number }>;
  readonly cost: TaskCostSummary;
  readonly turnIds: readonly StableId[];
}

interface TurnBillingContext { readonly provider: string; readonly model: string; readonly billingMode: 'api' | 'subscription' | 'unknown'; }

export class TaskAccountingRegistry {
  private readonly tasks = new Map<StableId, TaskAccount>();
  constructor(private readonly usage: UsageLedgerStore) {}

  open(options: TaskAccountingOptions): TaskAccount {
    if (this.tasks.has(options.taskId)) throw new TaskAccountingError('accounting.task-duplicate', `Accounting task ${options.taskId} already exists.`);
    const account = new TaskAccount(options, this.usage); this.tasks.set(options.taskId, account); return account;
  }
  get(taskId: StableId): TaskAccount | undefined { return this.tasks.get(taskId); }
  snapshots(): readonly TaskAccountingSnapshot[] { return Object.freeze([...this.tasks.values()].map((account) => account.snapshot()).sort((a, b) => a.taskId.localeCompare(b.taskId))); }
}

export class TaskAccount {
  private readonly controller: TaskBudgetController;
  private readonly pricing: PricingEngine;
  private readonly turns = new Map<StableId, TurnBillingContext>();
  private readonly committedTools = new Set<StableId>();
  private readonly latestCosts = new Map<StableId, CostEstimate>();
  private readonly costHistory = new Map<string, CostRecordV2>();
  private lastCost: TaskCostSummary = unknownCost('No provider usage has been received yet.', false);

  constructor(readonly options: TaskAccountingOptions, private readonly usageStore: UsageLedgerStore) {
    this.controller = new TaskBudgetController(options.budget);
    this.pricing = new PricingEngine(options.pricingCatalog);
  }

  beginTurn(): BudgetDecision { return this.controller.commit({ turns: 1 }); }
  bindTurn(turnId: StableId, context: TurnBillingContext): void { this.turns.set(turnId, Object.freeze({ ...context })); this.reconcile(); }
  preflightTool(toolCallId: StableId, observationBytes = 0): BudgetDecision {
    if (this.committedTools.has(toolCallId)) return this.controller.state();
    return this.controller.preflight({ toolCalls: 1, observationBytes });
  }
  commitTool(toolCallId: StableId, observationBytes = 0): BudgetDecision {
    if (this.committedTools.has(toolCallId)) return this.controller.state();
    const decision = this.controller.commit({ toolCalls: 1, observationBytes });
    if (decision.allowed) this.committedTools.add(toolCallId);
    return decision;
  }
  repair(): BudgetDecision { return this.controller.commit({ repairIterations: 1 }); }
  expireWallTime(): BudgetDecision {
    const limit = this.options.budget.limits.wallTimeMs; const current = this.controller.consumption().wallTimeMs;
    return this.controller.preflight({ wallTimeMs: Math.max(1, limit - current + 1) });
  }
  reconcile(): TaskAccountingSnapshot {
    const snapshots = this.taskLedgers();
    const aggregate = aggregateUsage(snapshots);
    const estimates: CostEstimate[] = [];
    for (const snapshot of snapshots) {
      const context = this.turns.get(snapshot.turnId);
      if (!context) continue;
      const estimate = this.pricing.estimate({ ...context, usage: snapshot.record }); estimates.push(estimate); this.latestCosts.set(snapshot.turnId, estimate); this.costHistory.set(estimate.record.id, estimate.record);
    }
    this.lastCost = aggregateCost(estimates, snapshots.length > 0 && snapshots.every((entry) => entry.record.final));
    const synthetic = syntheticUsage(this.options.taskId, aggregate, this.lastCost.final);
    this.controller.reconcileUsage(synthetic, this.lastCost.amountMicros);
    return this.snapshot();
  }
  snapshot(): TaskAccountingSnapshot {
    const ledgers = this.taskLedgers(); const usage = aggregateUsage(ledgers);
    return Object.freeze({ taskId: this.options.taskId, budget: this.options.budget, budgetDecision: this.controller.state(), consumption: this.controller.consumption(), usage, cost: this.lastCost, turnIds: Object.freeze(ledgers.map((entry) => entry.turnId)) });
  }
  costRecords(): readonly CostRecordV2[] { return Object.freeze([...this.costHistory.values()].sort((a, b) => a.id.localeCompare(b.id))); }
  private taskLedgers(): readonly UsageLedgerSnapshot[] { return this.usageStore.snapshots().filter((entry) => entry.taskId === this.options.taskId); }
}

export class TaskAccountingError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'TaskAccountingError'; } }

function aggregateUsage(values: readonly UsageLedgerSnapshot[]): TaskAccountingSnapshot['usage'] {
  const records = values.map((entry) => entry.record);
  return Object.freeze({
    inputTokens: sumKnown(records.map((entry) => entry.inputTokens)), cachedInputTokens: sumKnown(records.map((entry) => entry.cachedInputTokens)),
    cacheWriteTokens: sumKnown(records.map((entry) => entry.cacheWriteTokens)), outputTokens: sumKnown(records.map((entry) => entry.outputTokens)), reasoningTokens: sumKnown(records.map((entry) => entry.reasoningTokens)),
    toolInputBytes: records.reduce((sum, entry) => sum + entry.toolInputBytes, 0), toolOutputBytes: records.reduce((sum, entry) => sum + entry.toolOutputBytes, 0),
    wallTimeMs: records.reduce((sum, entry) => sum + entry.wallTimeMs, 0),
  });
}
function aggregateCost(values: readonly CostEstimate[], final: boolean): TaskCostSummary {
  if (values.length === 0) return unknownCost('No priced usage record is available yet.', final);
  const recordIds = Object.freeze(values.map((entry) => entry.record.id as StableId).sort());
  const catalogIds = new Set(values.map((entry) => entry.record.pricingCatalogId).filter((entry) => entry !== null));
  const catalogVersions = new Set(values.map((entry) => entry.record.pricingCatalogVersion).filter((entry) => entry !== null));
  const effectiveDates = new Set(values.map((entry) => entry.record.effectiveAt).filter((entry) => entry !== null));
  const provenance = { recordIds, pricingCatalogId: catalogIds.size === 1 ? [...catalogIds][0]! : null, pricingCatalogVersion: catalogVersions.size === 1 ? [...catalogVersions][0]! : null, effectiveAt: effectiveDates.size === 1 ? [...effectiveDates][0]! : null };
  const unknown = values.find((entry) => entry.record.amountMicros === null || entry.record.status === 'unknown');
  if (unknown) return Object.freeze({ ...unknownCost(unknown.explanation, final), ...provenance });
  const currencies = new Set(values.map((entry) => entry.record.currency));
  if (currencies.size !== 1) return Object.freeze({ ...unknownCost('Usage records use different currencies and cannot be combined.', final), ...provenance });
  const status = values.every((entry) => entry.record.status === 'actual') ? 'actual' : 'estimated';
  return Object.freeze({ status, amountMicros: values.reduce((sum, entry) => sum + (entry.record.amountMicros ?? 0), 0), currency: values[0]?.record.currency ?? null,
    cacheSavingMicros: values.every((entry) => entry.cacheSavingMicros !== null) ? values.reduce((sum, entry) => sum + (entry.cacheSavingMicros ?? 0), 0) : null,
    explanation: status === 'actual' ? 'Provider supplied actual billed amounts for every turn.' : 'Estimated from the versioned pricing catalog; this is not an account balance.', final, ...provenance });
}
function unknownCost(explanation: string, final: boolean): TaskCostSummary { return Object.freeze({ status: 'unknown', amountMicros: null, currency: null, cacheSavingMicros: null, explanation, final, recordIds: Object.freeze([]), pricingCatalogId: null, pricingCatalogVersion: null, effectiveAt: null }); }
function sumKnown(values: readonly (number | null)[]): number | null { return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0); }
function syntheticUsage(taskId: StableId, usage: TaskAccountingSnapshot['usage'], final: boolean): UsageRecordV2 {
  return Object.freeze({ schemaVersion: 2, id: asStableId(`usage:task:${taskId}`), taskId, sessionId: asStableId(`session:task:${taskId}`), turnId: asStableId(`turn:task:${taskId}`), ...usage, providerRequestDigest: null, final });
}
