import { asStableId, type CostRecordV2, type PricingCatalogV1, type StableId, type TaskBudgetV2, type UsageRecordV2 } from '@haiyue/ai-studio-contracts';
import { TaskBudgetController, budgetedInputTokens, type BudgetDecision, type BudgetConsumption } from './budget.js';
import { ActivityClock, activeDuration } from './activity-clock.js';
import { PricingEngine, type CostEstimate } from './pricing.js';
import type { UsageLedgerSnapshot, UsageLedgerStore } from './usage-ledger.js';

export interface TaskAccountingOptions {
  readonly taskId: StableId;
  readonly budget: TaskBudgetV2;
  readonly pricingCatalog: PricingCatalogV1;
  /** Trusted clock injection for deterministic timing tests. */
  readonly now?: () => number;
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
  readonly usage: Readonly<{ inputTokens: number | null; cachedInputTokens: number | null; cacheWriteTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; toolInputBytes: number; toolOutputBytes: number; wallTimeMs: number; contextCache?: NonNullable<UsageRecordV2['contextCache']> }>;
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
  private readonly reservationTurns = new Map<string, Set<string>>();
  private readonly settledTurns = new Set<string>();
  private readonly workTurns = new Map<string, StableId>();
  private readonly turnWork = new Map<StableId, string>();
  private readonly reservations = new Map<string, Partial<BudgetConsumption>>();
  private readonly wallReservations = new Map<string, ActivityClock>();
  private readonly activityScopes: ActivityClock[] = [];
  private readonly accounted = new Map<StableId, { inputTokens: number; outputTokens: number; estimatedCostMicros: number }>();
  private readonly committedTools = new Set<StableId>();
  private readonly latestCosts = new Map<StableId, CostEstimate>();
  private readonly costHistory = new Map<string, CostRecordV2>();
  private lastCost: TaskCostSummary = unknownCost('No provider usage has been received yet.', false);

  constructor(readonly options: TaskAccountingOptions, private readonly usageStore: UsageLedgerStore) {
    this.controller = new TaskBudgetController(options.budget);
    this.pricing = new PricingEngine(options.pricingCatalog);
  }

  beginTurn(): BudgetDecision { const decision = this.preflightReserved({ turns: 1 }); return decision.allowed ? this.controller.commit({ turns: 1 }) : decision; }
  /** Atomic conservative reservation; it is not fabricated provider usage. Unknown outcomes retain it. */
  reserveWork(id: string, caps: Partial<BudgetConsumption>): boolean {
    if (this.reservations.has(id) || !Object.keys(caps).length) return false;
    const metrics = this.controller.consumption();
    if (Object.entries(caps).some(([key, value]) => !Object.hasOwn(metrics, key) || !Number.isSafeInteger(value) || value! < 0)) return false;
    if (!this.preflightReserved(caps, true).allowed) return false;
    this.reservations.set(id, Object.freeze({ ...caps })); this.reservationTurns.set(id, new Set(this.taskLedgers().map(item => item.turnId))); return true;
  }
  /** Exact ownership is established by the trusted adapter as soon as a turn exists. */
  bindWork(id: string, turnId: StableId): boolean {
    if (!this.reservations.has(id) || this.reservationTurns.get(id)?.has(turnId) || this.settledTurns.has(turnId)) return false;
    if (this.workTurns.has(id)) return this.workTurns.get(id) === turnId;
    if (this.turnWork.has(turnId) || !this.taskLedgers().some(item => item.turnId === turnId)) return false;
    this.workTurns.set(id, turnId); this.turnWork.set(turnId, id); return true;
  }
  /** Release only after a final, fully priced child ledger belonging to this parent task exists. */
  settleWork(id: string, turnId: StableId): boolean {
    if (!this.reservations.has(id) || this.workTurns.get(id) !== turnId || this.settledTurns.has(turnId)) return false;
    const ledger = this.taskLedgers().find(item => item.turnId === turnId);
    this.reconcile();
    if (ledger?.executionState !== 'terminal' || !ledger.record.final || ledger.record.inputTokens === null || ledger.record.outputTokens === null || this.latestCosts.get(turnId)?.record.amountMicros == null) return false;
    this.settledTurns.add(turnId); this.reservationTurns.delete(id); this.workTurns.delete(id); return this.reservations.delete(id);
  }
  releaseUnstartedWork(id: string): void { if (this.workTurns.has(id)) return; this.reservations.delete(id); this.reservationTurns.delete(id); }
  /** One wall-time commitment for the scheduler's entire bounded batch, not one per lane. */
  reserveWallTime(id: string, cap: number): (() => void) | null {
    if (!this.reserveWork(id, { wallTimeMs: cap })) return null;
    const activity = new ActivityClock(this.now()); this.wallReservations.set(id, activity); this.activityScopes.push(activity);
    let closed = false;
    return () => {
      if (closed) return; closed = true;
      activity.finish(this.now()); this.wallReservations.delete(id); this.reservations.delete(id); this.reservationTurns.delete(id); this.reconcile();
    };
  }
  /** Host owns the scope: preparation/tool waits count, nested human waits do not. */
  trackWallTime(): Readonly<{ pause(): void; resume(): void; dispose(): void }> {
    const activity = new ActivityClock(this.now()); this.activityScopes.push(activity);
    return Object.freeze({ pause: () => activity.pause(this.now()), resume: () => activity.resume(this.now()), dispose: () => { activity.finish(this.now()); this.reconcile(); } });
  }
  reservedWork(): Readonly<Partial<BudgetConsumption>> {
    this.reconcile();
    const total: Partial<Record<keyof BudgetConsumption, number>> = {};
    for (const [id, caps] of this.reservations) {
      const turnId = this.workTurns.get(id), consumed = turnId ? this.accounted.get(turnId) : undefined;
      const ledger = turnId ? this.usageStore.get(turnId)?.snapshot() : undefined;
      for (const [metric, value] of Object.entries(caps)) {
        const key = metric as keyof BudgetConsumption;
        const credit = key === 'wallTimeMs' ? (this.wallReservations.has(id) ? activeDuration(this.wallReservations.get(id)!.intervals(this.now())) : ledger?.record.wallTimeMs ?? 0)
          : key === 'inputTokens' || key === 'outputTokens' || key === 'estimatedCostMicros' ? consumed?.[key] ?? 0 : 0;
        total[key] = (total[key] ?? 0) + Math.max(0, value - credit);
      }
    }
    return Object.freeze(total);
  }
  private preflightReserved(extra: Partial<BudgetConsumption>, strict = false): BudgetDecision {
    this.reconcile();
    if (!strict && this.reservations.size === 0) return this.controller.preflight(extra);
    const current = this.controller.state(); if (!current.allowed) return current;
    const held = this.reservedWork(), used = this.controller.consumption();
    const violations = Object.entries(this.controller.budget.limits).flatMap(([metric, limit]) => {
      const key = metric as keyof BudgetConsumption, projected = used[key] + (held[key] ?? 0) + (extra[key] ?? 0);
      return limit !== null && projected > limit ? [{ metric: key, current: used[key], projected, limit }] : [];
    });
    if (!strict && violations.length) {
      const reservation = { ...extra };
      for (const [metric, value] of Object.entries(held)) { const key = metric as keyof BudgetConsumption; reservation[key] = (reservation[key] ?? 0) + value; }
      return this.controller.preflight(reservation);
    }
    // Optional child work never spends past soft/observe limits either.
    return violations.length ? Object.freeze({ allowed: false, status: 'hard-exceeded', violations, warning: 'Outstanding child work reserves the remaining task budget.', hardStopLatched: false }) : current;
  }
  bindTurn(turnId: StableId, context: TurnBillingContext): void { this.turns.set(turnId, Object.freeze({ ...context })); this.reconcile(); }
  preflightTool(toolCallId: StableId, observationBytes = 0): BudgetDecision {
    if (this.committedTools.has(toolCallId)) return this.controller.state();
    const decision = this.preflightReserved({ toolCalls: 1, observationBytes });
    return decision.allowed ? this.controller.preflight({ toolCalls: 1, observationBytes }) : decision;
  }
  commitTool(toolCallId: StableId, observationBytes = 0): BudgetDecision {
    if (this.committedTools.has(toolCallId)) return this.controller.state();
    const preflight = this.preflightTool(toolCallId, observationBytes); if (!preflight.allowed) return preflight;
    const decision = this.controller.commit({ toolCalls: 1, observationBytes });
    if (decision.allowed) this.committedTools.add(toolCallId);
    return decision;
  }
  repair(): BudgetDecision { return this.controller.commit({ repairIterations: 1 }); }
  authorizeContinuation(): BudgetDecision { return this.controller.authorizeContinuation(); }
  expireWallTime(): BudgetDecision {
    const limit = this.controller.budget.limits.wallTimeMs; const current = this.controller.consumption().wallTimeMs;
    return this.controller.preflight({ wallTimeMs: Math.max(1, limit - current + 1) });
  }
  reconcile(): TaskAccountingSnapshot {
    const snapshots = this.taskLedgers();
    const aggregate = aggregateUsage(snapshots);
    const estimates: CostEstimate[] = [];
    for (const snapshot of snapshots) {
      const context = this.turns.get(snapshot.turnId) ?? { provider: 'unknown', model: 'unknown', billingMode: 'unknown' as const };
      const estimate = this.pricing.estimate({ ...context, usage: snapshot.record });
      estimates.push(estimate); this.latestCosts.set(snapshot.turnId, estimate); this.costHistory.set(estimate.record.id, estimate.record);
      const previous = this.accounted.get(snapshot.turnId);
      this.accounted.set(snapshot.turnId, {
        inputTokens: budgetedInputTokens(snapshot.record) ?? previous?.inputTokens ?? 0,
        outputTokens: snapshot.record.outputTokens ?? previous?.outputTokens ?? 0,
        estimatedCostMicros: estimate.record.amountMicros ?? previous?.estimatedCostMicros ?? 0,
      });
    }
    this.lastCost = aggregateCost(estimates, snapshots.length > 0 && snapshots.every((entry) => entry.record.final));
    // Audit totals remain nullable. Budgeting still counts known siblings when one turn is unknown.
    const charged = [...this.accounted.values()];
    const synthetic = syntheticUsage(this.options.taskId, { ...aggregate,
      inputTokens: charged.reduce((sum, item) => sum + item.inputTokens, 0), cachedInputTokens: 0, cacheWriteTokens: 0,
      outputTokens: charged.reduce((sum, item) => sum + item.outputTokens, 0), wallTimeMs: this.taskWallTime(snapshots),
    }, this.lastCost.final);
    this.controller.reconcileUsage(synthetic, charged.reduce((sum, item) => sum + item.estimatedCostMicros, 0));
    return this.snapshot();
  }
  snapshot(): TaskAccountingSnapshot {
    const ledgers = this.taskLedgers(); const usage = Object.freeze({ ...aggregateUsage(ledgers), wallTimeMs: this.taskWallTime(ledgers) });
    this.controller.reconcileWallTime(usage.wallTimeMs);
    return Object.freeze({ taskId: this.options.taskId, budget: this.controller.budget, budgetDecision: this.controller.state(), consumption: this.controller.consumption(), usage, cost: this.lastCost, turnIds: Object.freeze(ledgers.map((entry) => entry.turnId)) });
  }
  costRecords(): readonly CostRecordV2[] { return Object.freeze([...this.costHistory.values()].sort((a, b) => a.id.localeCompare(b.id))); }
  latestCostRecord(turnId: StableId): CostRecordV2 | undefined { return this.latestCosts.get(turnId)?.record; }
  private taskLedgers(): readonly UsageLedgerSnapshot[] { return this.usageStore.snapshots().filter((entry) => entry.taskId === this.options.taskId); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private taskWallTime(ledgers: readonly UsageLedgerSnapshot[]): number {
    return activeDuration([...ledgers.flatMap(entry => entry.activeIntervals), ...this.activityScopes.flatMap(scope => scope.intervals(this.now()))]);
  }
}

export class TaskAccountingError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'TaskAccountingError'; } }

function aggregateUsage(values: readonly UsageLedgerSnapshot[]): TaskAccountingSnapshot['usage'] {
  const records = values.map((entry) => entry.record);
  return Object.freeze({
    inputTokens: sumKnown(records.map((entry) => entry.inputTokens)), cachedInputTokens: sumKnown(records.map((entry) => entry.cachedInputTokens)),
    cacheWriteTokens: sumKnown(records.map((entry) => entry.cacheWriteTokens)), outputTokens: sumKnown(records.map((entry) => entry.outputTokens)), reasoningTokens: sumKnown(records.map((entry) => entry.reasoningTokens)),
    toolInputBytes: records.reduce((sum, entry) => sum + entry.toolInputBytes, 0), toolOutputBytes: records.reduce((sum, entry) => sum + entry.toolOutputBytes, 0),
    wallTimeMs: activeDuration(values.flatMap(entry => entry.activeIntervals)),
    ...(records.some((entry) => entry.contextCache) ? { contextCache: Object.freeze({
      localArtifactHits: records.reduce((sum, entry) => sum + (entry.contextCache?.localArtifactHits ?? 0), 0),
      localArtifactMisses: records.reduce((sum, entry) => sum + (entry.contextCache?.localArtifactMisses ?? 0), 0),
      deltaReuseBytes: records.reduce((sum, entry) => sum + (entry.contextCache?.deltaReuseBytes ?? 0), 0),
      providerCacheEligibleBytes: records.reduce((sum, entry) => sum + (entry.contextCache?.providerCacheEligibleBytes ?? 0), 0),
      providerReportedHitTokens: sumKnown(records.map((entry) => entry.contextCache?.providerReportedHitTokens ?? null)),
    }) } : {}),
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
