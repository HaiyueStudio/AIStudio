import { asStableId, type GameDocumentOperationV2, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import type { ProjectTransactionCommit, ProjectTransactionReconciliation, ProjectWorkspace } from '@haiyue/ai-studio-editor-plugins';
import { canonicalStringify, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import { EffectLockManager } from './scheduler/effect-locks.js';
import { GameToolProtocolError } from './types.js';

export interface SceneTransactionMember {
  readonly nodeId: StableId;
  readonly toolCallId: StableId;
  readonly toolId: StableId;
  readonly toolVersion: string;
  readonly effectKeys: readonly StableId[];
  readonly operations: readonly GameDocumentOperationV2[];
}

export interface PrepareSceneTransactionInput {
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly batchId: StableId;
  readonly documentId: StableId;
  readonly baseRevision: number;
  readonly label: string;
  readonly members: readonly SceneTransactionMember[];
}

export interface PreparedSceneTransaction {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly idempotencyKey: StableId;
  readonly commandId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly batchId: StableId;
  readonly documentId: StableId;
  readonly baseRevision: number;
  readonly label: string;
  readonly memberNodeIds: readonly StableId[];
  readonly effectKeys: readonly StableId[];
  readonly operationCount: number;
  readonly operationDigest: `sha256:${string}`;
  readonly status: 'prepared' | 'committing' | 'committed' | 'aborted' | 'outcome-unknown';
}

export interface SceneTransactionCommitResult {
  readonly plan: PreparedSceneTransaction;
  readonly commit: ProjectTransactionCommit;
  readonly lockWaitMs: number;
}

export interface SceneTransactionMetrics {
  readonly prepareAttempts: number;
  readonly prepared: number;
  readonly prepareFailures: number;
  readonly commitAttempts: number;
  readonly committed: number;
  readonly commitFailures: number;
  readonly reconciliations: number;
  readonly ambiguous: number;
  readonly staleRevisions: number;
  readonly duplicatesPrevented: number;
  readonly prepareLatencyMs: number;
  readonly commitLatencyMs: number;
  readonly reconcileLatencyMs: number;
  readonly lockWaitMs: number;
}

interface StoredSceneTransaction {
  readonly input: PrepareSceneTransactionInput;
  readonly operations: readonly GameDocumentOperationV2[];
  view: PreparedSceneTransaction;
}

export class SceneTransactionCoordinator {
  private readonly plans = new Map<StableId, StoredSceneTransaction>();
  private readonly metrics = { prepareAttempts: 0, prepared: 0, prepareFailures: 0, commitAttempts: 0, committed: 0, commitFailures: 0, reconciliations: 0, ambiguous: 0, staleRevisions: 0, duplicatesPrevented: 0, prepareLatencyMs: 0, commitLatencyMs: 0, reconcileLatencyMs: 0, lockWaitMs: 0 };

  constructor(
    private readonly workspace: ProjectWorkspace,
    private readonly operationLog: OperationLog,
    private readonly locks = new EffectLockManager(),
  ) {}

  async prepare(input: PrepareSceneTransactionInput, signal?: AbortSignal): Promise<PreparedSceneTransaction> {
    const startedAt = Date.now(); this.metrics.prepareAttempts += 1;
    throwIfAborted(signal);
    try { validateInput(input); }
    catch (cause) { this.metrics.prepareFailures += 1; this.metrics.prepareLatencyMs += elapsed(startedAt); throw cause; }
    const current = this.workspace.snapshot().document;
    if (!current || current.documentId !== input.documentId) throw new GameToolProtocolError('scene-transaction.document-missing', 'Scene transaction document is not open.');
    if (current.revision !== input.baseRevision) {
      this.metrics.prepareFailures += 1; this.metrics.staleRevisions += 1; this.metrics.prepareLatencyMs += elapsed(startedAt);
      throw new GameToolProtocolError('scene-transaction.stale-revision', `Transaction expected revision ${input.baseRevision}; current revision is ${current.revision}.`, true);
    }
    const operations = Object.freeze(input.members.flatMap((member) => [...member.operations]));
    try { this.workspace.validateTransactionOperations(operations); }
    catch (cause) { this.metrics.prepareFailures += 1; this.metrics.prepareLatencyMs += elapsed(startedAt); throw cause; }
    const operationDigest = prefixed(sha256(canonicalStringify(operations as unknown as JsonValue)));
    const identityDigest = sha256(canonicalStringify({ sessionId: input.sessionId, turnId: input.turnId, batchId: input.batchId, documentId: input.documentId, baseRevision: input.baseRevision, memberNodeIds: input.members.map((member) => member.nodeId), operationDigest } as unknown as JsonValue));
    const id = asStableId(`transaction:m13:${identityDigest.slice(0, 32)}`);
    const idempotencyKey = asStableId(`idempotency:m13:${identityDigest.slice(0, 32)}`);
    const commandId = asStableId(`command:m13:${identityDigest.slice(0, 32)}`);
    const existing = this.plans.get(id);
    if (existing) {
      if (existing.view.operationDigest !== operationDigest) throw new GameToolProtocolError('scene-transaction.idempotency-conflict', 'Transaction identity was reused with different operations.');
      this.metrics.duplicatesPrevented += 1; this.metrics.prepared += 1; this.metrics.prepareLatencyMs += elapsed(startedAt);
      return existing.view;
    }
    const memberNodeIds = Object.freeze(input.members.map((member) => member.nodeId));
    const effectKeys = Object.freeze([...new Set(['document:current', ...input.members.flatMap((member) => member.effectKeys)])].sort().map((key) => asStableId(key, 'transaction effect key')));
    const view: PreparedSceneTransaction = Object.freeze({ schemaVersion: 1, id, idempotencyKey, commandId, sessionId: input.sessionId, turnId: input.turnId, batchId: input.batchId, documentId: input.documentId, baseRevision: input.baseRevision, label: input.label, memberNodeIds, effectKeys, operationCount: operations.length, operationDigest, status: 'prepared' });
    this.plans.set(id, { input, operations, view });
    const prepareLatencyMs = elapsed(startedAt); this.metrics.prepared += 1; this.metrics.prepareLatencyMs += prepareLatencyMs;
    await this.operationLog.append({ kind: 'scene-transaction/prepared', severity: 'info', source: asStableId('studio.game-tools'), correlation: { sessionId: input.sessionId, turnId: input.turnId, transactionId: id, documentId: input.documentId }, payload: { ...transactionPayload(view), prepareLatencyMs } }, { signal });
    return view;
  }

  async commit(transactionId: StableId, signal?: AbortSignal): Promise<SceneTransactionCommitResult> {
    const startedAt = Date.now(); this.metrics.commitAttempts += 1;
    const stored = this.plans.get(transactionId);
    if (!stored) throw new GameToolProtocolError('scene-transaction.missing', `Prepared transaction ${transactionId} is unavailable.`);
    if (stored.view.status === 'aborted') throw new GameToolProtocolError('scene-transaction.aborted', `Transaction ${transactionId} was aborted.`);
    throwIfAborted(signal);
    stored.view = Object.freeze({ ...stored.view, status: 'committing' });
    const lease = await this.locks.acquire(asStableId(`owner:${transactionId}`), stored.view.effectKeys, signal);
    this.metrics.lockWaitMs += lease.waitMs;
    try {
      const commit = await this.workspace.executeTransaction({
        id: stored.view.commandId, transactionId: stored.view.id, idempotencyKey: stored.view.idempotencyKey,
        label: stored.view.label, baseRevision: stored.view.baseRevision, operations: stored.operations, memberNodeIds: stored.view.memberNodeIds,
      }, signal);
      stored.view = Object.freeze({ ...stored.view, status: 'committed' });
      const commitLatencyMs = elapsed(startedAt); this.metrics.commitLatencyMs += commitLatencyMs;
      if (commit.replayed) this.metrics.duplicatesPrevented += 1; else this.metrics.committed += 1;
      await this.operationLog.append({
        kind: 'scene-transaction/acknowledged', severity: 'info', source: asStableId('studio.game-tools'),
        correlation: { sessionId: stored.view.sessionId, turnId: stored.view.turnId, transactionId: stored.view.id, documentId: stored.view.documentId }, artifactRefs: [commit.receipt.artifactId],
        payload: { ...transactionPayload(stored.view), beforeRevision: commit.receipt.beforeRevision, afterRevision: commit.receipt.afterRevision, receiptDigest: commit.receipt.receiptDigest, receiptArtifactId: commit.receipt.artifactId, replayed: commit.replayed, lockWaitMs: lease.waitMs, commitLatencyMs },
      });
      return Object.freeze({ plan: stored.view, commit, lockWaitMs: lease.waitMs });
    } catch (cause) {
      this.metrics.commitFailures += 1;
      if (errorCode(cause) === 'stale-project-revision') this.metrics.staleRevisions += 1;
      const reconcileStartedAt = Date.now();
      const reconciliation = await this.workspace.reconcileTransaction({ transactionId: stored.view.id, idempotencyKey: stored.view.idempotencyKey, baseRevision: stored.view.baseRevision, operations: stored.operations, memberNodeIds: stored.view.memberNodeIds }).catch(() => null);
      const reconcileLatencyMs = elapsed(reconcileStartedAt); this.metrics.reconcileLatencyMs += reconcileLatencyMs; this.metrics.reconciliations += 1;
      const commitLatencyMs = elapsed(startedAt); this.metrics.commitLatencyMs += commitLatencyMs;
      if (reconciliation?.status === 'committed') {
        stored.view = Object.freeze({ ...stored.view, status: 'committed' });
        this.metrics.committed += 1; this.metrics.duplicatesPrevented += 1;
        const replayed = Object.freeze({ snapshot: this.workspace.snapshot(), receipt: reconciliation.receipt, replayed: true });
        await this.operationLog.append({ kind: 'scene-transaction/reconciled', severity: 'warning', source: asStableId('studio.game-tools'), correlation: { sessionId: stored.view.sessionId, turnId: stored.view.turnId, transactionId: stored.view.id, documentId: stored.view.documentId }, artifactRefs: [reconciliation.receipt.artifactId], payload: { ...transactionPayload(stored.view), originalCode: errorCode(cause), beforeRevision: reconciliation.receipt.beforeRevision, afterRevision: reconciliation.receipt.afterRevision, receiptDigest: reconciliation.receipt.receiptDigest, synthesizedAck: true, retryAllowed: false, lockWaitMs: lease.waitMs, commitLatencyMs, reconcileLatencyMs } });
        return Object.freeze({ plan: stored.view, commit: replayed, lockWaitMs: lease.waitMs });
      }
      if (reconciliation?.status === 'ambiguous' || reconciliation === null) this.metrics.ambiguous += 1;
      stored.view = Object.freeze({ ...stored.view, status: reconciliation?.status === 'not-committed' ? 'aborted' : 'outcome-unknown' });
      await this.operationLog.append({ kind: reconciliation?.status === 'not-committed' ? 'scene-transaction/commit-failed' : 'scene-transaction/outcome-unknown', severity: 'error', source: asStableId('studio.game-tools'), correlation: { sessionId: stored.view.sessionId, turnId: stored.view.turnId, transactionId: stored.view.id, documentId: stored.view.documentId }, payload: { ...transactionPayload(stored.view), code: errorCode(cause), message: errorMessage(cause), reconciliation: reconciliation?.status ?? 'unavailable', retryAllowed: reconciliation?.status === 'not-committed', lockWaitMs: lease.waitMs, commitLatencyMs, reconcileLatencyMs } }).catch(() => undefined);
      throw cause;
    } finally { lease.release(); }
  }

  async reconcile(transactionId: StableId): Promise<ProjectTransactionReconciliation> {
    const startedAt = Date.now(); this.metrics.reconciliations += 1;
    const stored = this.plans.get(transactionId);
    if (!stored) throw new GameToolProtocolError('scene-transaction.missing', `Prepared transaction ${transactionId} is unavailable.`);
    const result = await this.workspace.reconcileTransaction({ transactionId: stored.view.id, idempotencyKey: stored.view.idempotencyKey, baseRevision: stored.view.baseRevision, operations: stored.operations, memberNodeIds: stored.view.memberNodeIds });
    this.metrics.reconcileLatencyMs += elapsed(startedAt);
    if (result.status === 'committed') stored.view = Object.freeze({ ...stored.view, status: 'committed' });
    else if (result.status === 'ambiguous') { stored.view = Object.freeze({ ...stored.view, status: 'outcome-unknown' }); this.metrics.ambiguous += 1; }
    return result;
  }

  async abort(transactionId: StableId, reason = 'cancelled'): Promise<PreparedSceneTransaction> {
    const stored = this.plans.get(transactionId);
    if (!stored) throw new GameToolProtocolError('scene-transaction.missing', `Prepared transaction ${transactionId} is unavailable.`);
    if (stored.view.status === 'committed' || stored.view.status === 'committing' || stored.view.status === 'outcome-unknown') throw new GameToolProtocolError('scene-transaction.reconcile-required', 'A transaction that may have committed cannot be aborted or automatically undone.');
    stored.view = Object.freeze({ ...stored.view, status: 'aborted' });
    await this.operationLog.append({ kind: 'scene-transaction/aborted', severity: 'warning', source: asStableId('studio.game-tools'), correlation: { sessionId: stored.view.sessionId, turnId: stored.view.turnId, transactionId: stored.view.id, documentId: stored.view.documentId }, payload: { ...transactionPayload(stored.view), reason: reason.slice(0, 512) } });
    return stored.view;
  }

  snapshot(): Readonly<{ plans: number; locks: ReturnType<EffectLockManager['snapshot']>; metrics: SceneTransactionMetrics }> { return Object.freeze({ plans: this.plans.size, locks: this.locks.snapshot(), metrics: Object.freeze({ ...this.metrics }) }); }
}

function validateInput(input: PrepareSceneTransactionInput): void {
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new TypeError('Scene transaction base revision is invalid.');
  if (!input.label.trim() || input.label.length > 120) throw new TypeError('Scene transaction label must contain 1-120 characters.');
  if (input.members.length < 1 || input.members.length > 100) throw new TypeError('Scene transaction must contain 1-100 members.');
  if (new Set(input.members.map((member) => member.nodeId)).size !== input.members.length || new Set(input.members.map((member) => member.toolCallId)).size !== input.members.length) throw new TypeError('Scene transaction member identities must be unique.');
  let operationCount = 0;
  for (const member of input.members) {
    if (!member.toolVersion || member.toolVersion.length > 64 || member.operations.length < 1) throw new TypeError('Scene transaction member is invalid.');
    if (member.effectKeys.length < 1 || member.effectKeys.length > 256 || new Set(member.effectKeys).size !== member.effectKeys.length) throw new TypeError('Scene transaction member effect keys are invalid.');
    operationCount += member.operations.length;
  }
  if (operationCount < 1 || operationCount > 1_000) throw new TypeError('Scene transaction operations must contain 1-1000 entries.');
  canonicalStringify(input.members.flatMap((member) => member.operations) as unknown as JsonValue);
}

function transactionPayload(view: PreparedSceneTransaction): JsonObject { return Object.freeze({ transactionId: view.id, idempotencyKey: view.idempotencyKey, batchId: view.batchId, documentId: view.documentId, baseRevision: view.baseRevision, memberNodeIds: view.memberNodeIds, effectKeys: view.effectKeys, operationCount: view.operationCount, operationDigest: view.operationDigest, status: view.status }); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new GameToolProtocolError('scene-transaction.cancelled', 'Scene transaction was cancelled.', true); }
function prefixed(value: string): `sha256:${string}` { return (value.startsWith('sha256:') ? value : `sha256:${value}`) as `sha256:${string}`; }
function errorCode(value: unknown): string { return value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : 'scene-transaction.commit-failed'; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function elapsed(startedAt: number): number { return Math.max(0, Math.floor(Date.now() - startedAt)); }
