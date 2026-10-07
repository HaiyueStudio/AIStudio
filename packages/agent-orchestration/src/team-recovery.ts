import { asStableId, type JsonObject, type StableId, type TeamInferenceRequestV1, type TeamInferencePermitV1, type TeamRecoveryAdmissionPortV1 } from '@haiyue/ai-studio-contracts';
import type { TaskAccount, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { canonicalStringify, redactObject, scanRetainedEvents, type OperationLog } from '@haiyue/ai-studio-operation-log';

export interface TeamSessionBinding {
  readonly sessionId: StableId;
  readonly leadSessionId: StableId;
  readonly parentTaskId: StableId;
  readonly budgetId: StableId;
  readonly planTaskId: string | null;
  readonly model: string;
}
export interface TeamRecoveryAuthority {
  /** Must resolve a reconciled parent account, a currently approved plan task and Team-specific
   * qualification. A saved binding is identity only, never an approval or a budget grant. */
  authorize(binding: TeamSessionBinding, signal: AbortSignal): Promise<Readonly<{
    account: TaskAccount; signal: AbortSignal; qualificationRef: string;
    caps: Readonly<{ inputTokens: number; outputTokens: number; estimatedCostMicros: number; wallTimeMs: number }>;
  }> | null>;
}
const boundKind = 'conversation/team-session-bound', startedKind = 'conversation/team-request-started', endedKind = 'conversation/team-request-settled';

/** Recovery coordinator only: Team still owns its native mailbox, Studio owns task/plan/approval. */
export class StudioTeamRecoveryAdmission implements TeamRecoveryAdmissionPortV1 {
  private readonly bindings = new Map<string, TeamSessionBinding>();
  private readonly attempts = new Map<string, Readonly<{ parentTaskId: string; settled: boolean; turnId: StableId }>>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly shutdown = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;
  constructor(private readonly log: OperationLog, private readonly usage: UsageLedgerStore, private readonly authority: TeamRecoveryAuthority) {}

  /** Explicit identity registration by the composition owner, never a model tool. */
  bind(input: TeamSessionBinding): Promise<void> {
    return this.serial(async () => {
      await this.restore(); this.shutdown.signal.throwIfAborted();
      const binding = parseBinding(input);
      const previous = this.bindings.get(binding.sessionId);
      if (previous) { if (canonicalStringify(previous as unknown as JsonObject) !== canonicalStringify(binding as unknown as JsonObject)) throw new Error('team.binding-conflict'); return; }
      if (binding.sessionId !== binding.leadSessionId) {
        const lead = this.bindings.get(binding.leadSessionId);
        if (!lead || lead.parentTaskId !== binding.parentTaskId || lead.budgetId !== binding.budgetId || lead.model !== binding.model || binding.planTaskId === null) throw new Error('team.binding-parent-mismatch');
      }
      await this.log.append({ kind: boundKind, source: asStableId('studio.team-recovery'), severity: 'info', correlation: { sessionId: binding.sessionId }, payload: binding as unknown as JsonObject });
      await this.log.flush(); this.bindings.set(binding.sessionId, binding);
    });
  }
  admit(request: TeamInferenceRequestV1, signal: AbortSignal): Promise<TeamInferencePermitV1> {
    return this.serial(async () => {
      await this.restore(); this.shutdown.signal.throwIfAborted(); signal.throwIfAborted();
      const binding = this.bindings.get(request.sessionId);
      if (!binding || binding.leadSessionId !== request.leadSessionId || binding.model !== request.model) throw new Error('team.request-unowned');
      asStableId(request.requestId);
      if (request.toolNames.length || !Number.isSafeInteger(request.inputTokenBound) || request.inputTokenBound < 1 || !Number.isSafeInteger(request.outputTokenLimit) || request.outputTokenLimit < 1) throw new Error('team.request-capability-denied');
      if (this.attempts.has(request.requestId)) throw new Error('team.request-already-dispatched');
      // Never silently reset old spend or retry a request whose outcome is unknown after a crash.
      for (const attempt of this.attempts.values()) if (attempt.parentTaskId === binding.parentTaskId) {
        if (!attempt.settled || this.usage.get(attempt.turnId)?.snapshot().taskId !== binding.parentTaskId) throw new Error('team.recovery-reconciliation-required');
      }
      const authorized = await this.authority.authorize(Object.freeze({ ...binding }), signal);
      signal.throwIfAborted(); this.shutdown.signal.throwIfAborted();
      if (!authorized || !authorized.qualificationRef || authorized.account.options.taskId !== binding.parentTaskId || authorized.account.options.budget.id !== binding.budgetId) throw new Error('team.recovery-admission-denied');
      const { account, caps } = authorized;
      const combined = AbortSignal.any([signal, authorized.signal, this.shutdown.signal]); combined.throwIfAborted();
      if (Object.values(caps).some(n => !Number.isSafeInteger(n) || n < 1) || caps.wallTimeMs > 60000 || request.inputTokenBound > caps.inputTokens || request.outputTokenLimit > caps.outputTokens) throw new Error('team.request-budget');
      const price = account.options.pricingCatalog.entries.find(p => p.provider === 'deepseek' && p.model === request.model);
      const worstCost = price && Math.ceil((caps.inputTokens * Math.max(price.inputMicrosPerMillion, price.cachedInputMicrosPerMillion ?? 0, price.cacheWriteMicrosPerMillion ?? 0)
        + caps.outputTokens * price.outputMicrosPerMillion * (price.reasoningBilling === 'separate-as-output' ? 2 : 1)) / 1_000_000) + 2;
      if (!worstCost || worstCost > caps.estimatedCostMicros || !account.reserveAuxiliary(request.requestId, { inputTokens: caps.inputTokens, outputTokens: caps.outputTokens, estimatedCostMicros: caps.estimatedCostMicros })) throw new Error('team.shared-budget');
      const wall = account.reserveWallTime(`wall:${request.requestId}`, caps.wallTimeMs);
      if (!wall) { account.releaseUnsentAuxiliary(request.requestId); throw new Error('team.shared-budget'); }
      let committed = false;
      try {
        if (!account.beginTurn().allowed) throw new Error('team.shared-budget');
        combined.throwIfAborted();
        const turnId = request.requestId;
        // Mark in memory before the durable write: a rejected/ambiguous append cannot permit a retry.
        this.attempts.set(request.requestId, { parentTaskId: binding.parentTaskId, turnId, settled: false }); committed = true;
        await this.log.append({ kind: startedKind, source: asStableId('studio.team-recovery'), severity: 'info', correlation: { sessionId: request.sessionId, turnId },
          payload: { requestId: request.requestId, parentTaskId: binding.parentTaskId, leadSessionId: binding.leadSessionId, model: binding.model, budgetId: binding.budgetId, planTaskId: binding.planTaskId,
            inputTokenBound: request.inputTokenBound, outputTokenLimit: request.outputTokenLimit, qualificationRef: authorized.qualificationRef, caps } });
        await this.log.flush(); combined.throwIfAborted();
        const ledger = this.usage.open({ taskId: binding.parentTaskId, sessionId: request.sessionId, turnId, providerRequestDigest: null, startedAtMs: Date.now() });
        if (!account.bindAuxiliary(request.requestId, turnId, { provider: 'deepseek', model: binding.model, billingMode: 'api' })) throw new Error('team.billing-ownership');
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(new Error('team.request-timeout')), caps.wallTimeMs);
        const permitSignal = AbortSignal.any([combined, timeout.signal]);
        let finish!: () => void; const drained = new Promise<void>(resolve => { finish = resolve; }); this.active.set(request.requestId, drained);
        let settlement: Promise<void> | undefined;
        return { signal: permitSignal, settle: (usage, status) => settlement ??= (async () => {
          try {
            if (usage) ledger.reconcile({ eventId: `${turnId}:usage`, sequence: 1, mode: 'cumulative', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
              cachedInputTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0, reasoningTokens: usage.reasoningTokens ?? 0, observedAtMs: Date.now(), final: true });
            ledger.markTerminal(status === 'completed' ? 'stop' : status === 'cancelled' ? 'cancelled' : 'error', Date.now());
            const priced = account.settleAuxiliary(request.requestId, turnId);
            await this.log.append({ kind: endedKind, source: asStableId('studio.team-recovery'), severity: priced ? 'info' : 'warning', correlation: { sessionId: request.sessionId, turnId },
              payload: { requestId: request.requestId, parentTaskId: binding.parentTaskId, status, fullyPriced: priced, usage: ledger.snapshot().record as unknown as JsonObject } });
            await this.log.flush();
            this.attempts.set(request.requestId, { parentTaskId: binding.parentTaskId, turnId, settled: priced });
          } finally { clearTimeout(timer); wall(); this.active.delete(request.requestId); finish(); }
        })() };
      } catch (error) { wall(); if (!committed) account.releaseUnsentAuxiliary(request.requestId); throw error; }
    });
  }
  async dispose(): Promise<void> { this.shutdown.abort(new Error('team.recovery-disposed')); await this.tail; await Promise.all(this.active.values()); }
  private async restore(): Promise<void> {
    if (this.initialized) return;
    if (this.log.status().retainedFromSequence > 0) throw new Error('team.recovery-history-retained-prefix-missing');
    for await (const event of scanRetainedEvents(this.log, [boundKind, startedKind, endedKind])) {
      if (event.source !== 'studio.team-recovery') throw new Error('team.recovery-record-invalid');
      if (event.kind === boundKind) {
        const binding = parseBinding(event.payload); const previous = this.bindings.get(binding.sessionId);
        if (previous && canonicalStringify(previous as unknown as JsonObject) !== canonicalStringify(binding as unknown as JsonObject)) throw new Error('team.binding-conflict');
        this.bindings.set(binding.sessionId, binding);
      } else {
        const { requestId, parentTaskId } = event.payload;
        if (typeof requestId !== 'string' || typeof parentTaskId !== 'string' || event.correlation.turnId !== requestId) throw new Error('team.recovery-record-invalid');
        const previous = this.attempts.get(requestId);
        if (event.kind === startedKind ? !!previous : !previous || previous.parentTaskId !== parentTaskId) throw new Error('team.recovery-record-order');
        this.attempts.set(requestId, { parentTaskId, turnId: asStableId(requestId), settled: event.kind === endedKind && event.payload.fullyPriced === true });
      }
    }
    this.initialized = true;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> { const result = this.tail.then(run); this.tail = result.then(() => undefined, () => undefined); return result; }
}
function parseBinding(value: unknown): TeamSessionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('team.binding-invalid');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'budgetId,leadSessionId,model,parentTaskId,planTaskId,sessionId' || typeof v.model !== 'string' || !v.model || v.model.length > 128
    || v.planTaskId !== null && (typeof v.planTaskId !== 'string' || !v.planTaskId || v.planTaskId.length > 128)
    || canonicalStringify(redactObject(v as JsonObject).value) !== canonicalStringify(v)) throw new Error('team.binding-invalid');
  for (const key of ['sessionId','leadSessionId','parentTaskId','budgetId']) if (typeof v[key] !== 'string') throw new Error('team.binding-invalid'); else asStableId(v[key]);
  return Object.freeze({ ...v }) as unknown as TeamSessionBinding;
}
