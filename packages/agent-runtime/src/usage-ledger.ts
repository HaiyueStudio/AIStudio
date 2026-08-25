import { createHash } from 'node:crypto';
import { asStableId, type M12Digest, type StableId, type UsageRecordV2 } from '@haiyue/ai-studio-contracts';

export type NormalizedFinishReason = 'stop' | 'length' | 'tool-calls' | 'cancelled' | 'content-filter' | 'error' | 'unknown';
export interface UsageUpdate {
  readonly eventId: string;
  readonly sequence: number;
  readonly mode: 'delta' | 'cumulative';
  readonly inputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly toolInputBytes?: number;
  readonly toolOutputBytes?: number;
  readonly observedAtMs: number;
  readonly final?: boolean;
  readonly stepId?: StableId;
  readonly toolCallId?: StableId;
}
export interface UsageLedgerSnapshot {
  readonly taskId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly record: UsageRecordV2;
  readonly finishReason: NormalizedFinishReason | null;
  readonly executionState: 'running' | 'terminal';
  readonly acceptedEvents: number;
  readonly duplicateEvents: number;
  readonly outOfOrderEvents: number;
  readonly lateReconciliations: number;
}

export class UsageLedger {
  private readonly updates = new Map<string, UsageUpdate>();
  private readonly recordsValue: UsageRecordV2[] = [];
  private duplicateEvents = 0;
  private outOfOrderEvents = 0;
  private lateReconciliations = 0;
  private highestArrivalSequence = -1;
  private executionState: 'running' | 'terminal' = 'running';
  private finishReason: NormalizedFinishReason | null = null;
  private terminalAtMs: number | null = null;

  constructor(private readonly identity: {
    readonly taskId: StableId;
    readonly sessionId: StableId;
    readonly turnId: StableId;
    readonly providerRequestDigest: M12Digest | null;
    readonly startedAtMs: number;
    readonly contextCache?: UsageRecordV2['contextCache'];
  }) {
    assertTime(identity.startedAtMs, 'start time');
  }

  reconcile(update: UsageUpdate): UsageLedgerSnapshot {
    validateUpdate(update);
    if (this.updates.has(update.eventId)) { this.duplicateEvents += 1; return this.snapshot(); }
    if (update.sequence < this.highestArrivalSequence) this.outOfOrderEvents += 1;
    this.highestArrivalSequence = Math.max(this.highestArrivalSequence, update.sequence);
    if (this.executionState === 'terminal') this.lateReconciliations += 1;
    this.updates.set(update.eventId, freezeUpdate(update));
    this.appendRecord(update.observedAtMs, update);
    return this.snapshot();
  }

  markTerminal(finishReason: NormalizedFinishReason, observedAtMs: number): UsageLedgerSnapshot {
    assertTime(observedAtMs, 'terminal time');
    if (!finishReasons.has(finishReason)) throw new UsageLedgerError('usage.finish-reason-invalid', 'Finish reason is invalid.');
    if (this.executionState === 'running') {
      this.executionState = 'terminal'; this.finishReason = finishReason; this.terminalAtMs = observedAtMs; this.appendRecord(observedAtMs);
    }
    return this.snapshot();
  }

  records(): readonly UsageRecordV2[] { return Object.freeze([...this.recordsValue]); }

  snapshot(): UsageLedgerSnapshot {
    const record = this.recordsValue.at(-1) ?? this.aggregate(this.identity.startedAtMs);
    return Object.freeze({
      taskId: this.identity.taskId, sessionId: this.identity.sessionId, turnId: this.identity.turnId, record,
      finishReason: this.finishReason, executionState: this.executionState, acceptedEvents: this.updates.size,
      duplicateEvents: this.duplicateEvents, outOfOrderEvents: this.outOfOrderEvents, lateReconciliations: this.lateReconciliations,
    });
  }

  private appendRecord(observedAtMs: number, update?: UsageUpdate): void { this.recordsValue.push(this.aggregate(observedAtMs, update)); }

  private aggregate(observedAtMs: number, update?: UsageUpdate): UsageRecordV2 {
    const updates = [...this.updates.values()].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
    const cumulative = updates.filter((entry) => entry.mode === 'cumulative').at(-1);
    const deltas = cumulative ? updates.filter((entry) => entry.mode === 'delta' && entry.sequence > cumulative.sequence) : updates.filter((entry) => entry.mode === 'delta');
    const byteDeltas = updates.filter((entry) => entry.mode === 'delta');
    const counts = {
      inputTokens: cumulative?.inputTokens ?? null,
      cachedInputTokens: cumulative?.cachedInputTokens ?? null,
      cacheWriteTokens: cumulative?.cacheWriteTokens ?? null,
      outputTokens: cumulative?.outputTokens ?? null,
      reasoningTokens: cumulative?.reasoningTokens ?? null,
      toolInputBytes: cumulative?.toolInputBytes ?? 0,
      toolOutputBytes: cumulative?.toolOutputBytes ?? 0,
    };
    for (const update of deltas) {
      for (const key of tokenKeys) counts[key] = sumNullable(counts[key], update[key]);
    }
    for (const update of byteDeltas) { counts.toolInputBytes += update.toolInputBytes ?? 0; counts.toolOutputBytes += update.toolOutputBytes ?? 0; }
    const final = this.executionState === 'terminal' || updates.some((entry) => entry.final === true);
    const ordinal = this.recordsValue.length + 1;
    return Object.freeze({
      schemaVersion: 2,
      id: asStableId(`usage:${digestId(`${this.identity.taskId}\0${this.identity.turnId}\0${ordinal}\0${canonicalUpdates(updates)}`)}`),
      taskId: this.identity.taskId, sessionId: this.identity.sessionId, turnId: this.identity.turnId,
      ...(update?.stepId ? { stepId: update.stepId } : {}), ...(update?.toolCallId ? { toolCallId: update.toolCallId } : {}),
      ...counts,
      wallTimeMs: Math.max(0, Math.floor((this.terminalAtMs ?? observedAtMs) - this.identity.startedAtMs)),
      providerRequestDigest: this.identity.providerRequestDigest,
      ...(this.identity.contextCache ? { contextCache: Object.freeze({ ...this.identity.contextCache, providerReportedHitTokens: counts.cachedInputTokens }) } : {}),
      final,
    });
  }
}

export class UsageLedgerStore {
  private readonly ledgers = new Map<StableId, UsageLedger>();
  open(identity: ConstructorParameters<typeof UsageLedger>[0]): UsageLedger {
    if (this.ledgers.has(identity.turnId)) throw new UsageLedgerError('usage.turn-duplicate', `Usage ledger for ${identity.turnId} already exists.`);
    const ledger = new UsageLedger(identity); this.ledgers.set(identity.turnId, ledger); return ledger;
  }
  get(turnId: StableId): UsageLedger | undefined { return this.ledgers.get(turnId); }
  snapshots(): readonly UsageLedgerSnapshot[] { return Object.freeze([...this.ledgers.values()].map((ledger) => ledger.snapshot()).sort((a, b) => a.turnId.localeCompare(b.turnId))); }
}

export class UsageLedgerError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'UsageLedgerError'; } }

function validateUpdate(value: UsageUpdate): void {
  if (typeof value.eventId !== 'string' || value.eventId.length < 1 || value.eventId.length > 256 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !['delta', 'cumulative'].includes(value.mode)) throw new UsageLedgerError('usage.update-invalid', 'Usage update envelope is invalid.');
  assertTime(value.observedAtMs, 'observation time');
  for (const key of tokenKeys) if (value[key] !== undefined && value[key] !== null) assertCount(value[key], key);
  for (const key of ['toolInputBytes', 'toolOutputBytes'] as const) if (value[key] !== undefined) assertCount(value[key], key);
  for (const key of ['stepId', 'toolCallId'] as const) if (value[key] !== undefined && !isStableId(value[key])) throw new UsageLedgerError('usage.coordinate-invalid', `${key} is invalid.`);
}
function freezeUpdate(value: UsageUpdate): UsageUpdate { return Object.freeze({ ...value }); }
function sumNullable(left: number | null, right: number | null | undefined): number | null { if (right === undefined) return left; if (right === null) return left; return (left ?? 0) + right; }
function assertCount(value: unknown, label: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) throw new UsageLedgerError('usage.count-invalid', `${label} is invalid.`); }
function assertTime(value: number, label: string): void { if (!Number.isFinite(value) || value < 0) throw new UsageLedgerError('usage.time-invalid', `${label} is invalid.`); }
function digestId(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
function canonicalUpdates(value: readonly UsageUpdate[]): string { return JSON.stringify(value.map((entry) => Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))))); }
const tokenKeys = ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'] as const;
const finishReasons = new Set<NormalizedFinishReason>(['stop', 'length', 'tool-calls', 'cancelled', 'content-filter', 'error', 'unknown']);
function isStableId(value: unknown): value is StableId { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value); }
