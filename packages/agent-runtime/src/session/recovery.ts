import type { JsonObject, M13StableId, SessionOpV1 } from '@haiyue/ai-studio-contracts';
import { AgentSessionError } from './error.js';
import type { DurableSessionHandle, SessionReplaySnapshotV1 } from './types.js';

const recoveryTails = new Map<M13StableId, Promise<void>>();

export interface MutationRecoveryIntent {
  readonly sessionId: M13StableId;
  readonly turnId: M13StableId | null;
  readonly batchId: M13StableId | null;
  readonly nodeId: M13StableId;
  readonly toolCallId: M13StableId | null;
  readonly toolId: M13StableId | null;
  readonly documentId: M13StableId | null;
  readonly transactionId: M13StableId;
  readonly idempotencyKey: M13StableId;
  readonly baseRevision: number;
  readonly operationDigest: string;
}

export type MutationRecoveryAuthorityResult =
  | Readonly<{ status: 'committed'; transactionId: M13StableId; beforeRevision: number; afterRevision: number; receiptDigest: string; receiptArtifactId: M13StableId }>
  | Readonly<{ status: 'not-committed'; transactionId: M13StableId; currentRevision: number }>
  | Readonly<{ status: 'ambiguous'; transactionId: M13StableId; currentRevision: number; reason: string }>;

export interface SessionRecoveryAuthorityPort {
  reconcileMutation(intent: MutationRecoveryIntent): Promise<MutationRecoveryAuthorityResult>;
  discoverMutation?(intent: Readonly<{ sessionId: M13StableId; turnId: M13StableId | null; batchId: M13StableId | null; nodeId: M13StableId; toolCallId: M13StableId | null; toolId: M13StableId | null; documentId: M13StableId | null; baseRevision: number }>): Promise<MutationRecoveryAuthorityResult>;
}

export type SessionRecoveryAction = Readonly<{
  nodeId: M13StableId;
  decision: 'retry-not-started' | 'retry-read' | 'retry-not-committed' | 'synthesized-completion' | 'manual-barrier';
  transactionId: M13StableId | null;
  diagnostic: string;
}>;

export interface SessionRecoveryRun {
  readonly claimId: M13StableId;
  readonly sourceThroughSequence: number;
  readonly actions: readonly SessionRecoveryAction[];
  readonly barrierIds: readonly M13StableId[];
  readonly snapshot: SessionReplaySnapshotV1;
}

/** Reconciles one interrupted Session without importing editor implementations into agent-runtime. */
export class DurableSessionRecoveryCoordinator {
  constructor(private readonly authority: SessionRecoveryAuthorityPort) {}

  async recover(handle: DurableSessionHandle, claimId: M13StableId): Promise<SessionRecoveryRun> {
    const previous = recoveryTails.get(handle.id) ?? Promise.resolve();
    const run = previous.then(() => this.recoverExclusive(handle, claimId));
    const tail = run.then(() => undefined, () => undefined);
    recoveryTails.set(handle.id, tail);
    try { return await run; }
    finally { if (recoveryTails.get(handle.id) === tail) recoveryTails.delete(handle.id); }
  }

  private async recoverExclusive(handle: DurableSessionHandle, claimId: M13StableId): Promise<SessionRecoveryRun> {
    let snapshot = await handle.snapshot();
    const sourceThroughSequence = snapshot.ops.at(-1)?.sequence ?? 0;
    if (snapshot.recovery.unresolvedBarrierIds.length > 0) return Object.freeze({ claimId, sourceThroughSequence, actions: Object.freeze([]), barrierIds: snapshot.recovery.unresolvedBarrierIds, snapshot });
    if (snapshot.recovery.openToolNodeIds.length === 0 && snapshot.recovery.openBatchIds.length === 0 && snapshot.recovery.openTurnIds.length === 0) return Object.freeze({ claimId, sourceThroughSequence, actions: Object.freeze([]), barrierIds: Object.freeze([]), snapshot });
    snapshot = await handle.append({ kind: 'session.status-changed', payload: { status: 'running', reason: 'recovery-claimed', claimId, claimEpoch: sourceThroughSequence } });
    const actions: SessionRecoveryAction[] = [];
    const barriers: M13StableId[] = [];
    for (const planned of findPlannedNotStarted(snapshot)) {
      actions.push(Object.freeze({ nodeId: planned.nodeId!, decision: 'retry-not-started', transactionId: null, diagnostic: 'session.tool-not-started' }));
    }
    const openTools = snapshot.recovery.openToolNodeIds.map((nodeId) => findStarted(snapshot, nodeId)).sort((left, right) => left.sequence - right.sequence);
    for (const started of openTools) {
      const nodeId = started.nodeId!;
      const effect = recoveryEffect(started);
      if (effect === 'observe') {
        snapshot = await appendOutcomeUnknown(handle, started, { diagnostic: 'session.read-interrupted', retryAllowed: true, recoveryDecision: 'retry-read', claimId });
        actions.push(Object.freeze({ nodeId, decision: 'retry-read', transactionId: null, diagnostic: 'session.read-interrupted' }));
        continue;
      }
      const intent = mutationIntent(snapshot, started);
      const baseRevision = integer(started.payload.baseRevision ?? started.payload.expectedRevision ?? started.projectRevision);
      let authority: MutationRecoveryAuthorityResult | null = null;
      if (intent) authority = await this.authority.reconcileMutation(intent);
      else if (baseRevision !== null && started.nodeId && this.authority.discoverMutation) authority = await this.authority.discoverMutation({ sessionId: snapshot.session.id, turnId: started.turnId, batchId: started.batchId, nodeId: started.nodeId, toolCallId: stable(started.payload.toolCallId), toolId: stable(started.payload.toolId), documentId: snapshot.session.documentId, baseRevision });
      if (!authority) {
        snapshot = await appendOutcomeUnknown(handle, started, { diagnostic: 'session.mutation-identity-missing', retryAllowed: false, recoveryDecision: 'manual-barrier', claimId });
        const barrierId = recoveryBarrierId(nodeId);
        snapshot = await appendManualBarrier(handle, started, barrierId, 'Mutation recovery identity is incomplete; inspect History and Scene diff before continuing.', claimId);
        barriers.push(barrierId); actions.push(Object.freeze({ nodeId, decision: 'manual-barrier', transactionId: null, diagnostic: 'session.mutation-identity-missing' }));
        continue;
      }
      snapshot = await appendOutcomeUnknown(handle, started, { diagnostic: authority.status === 'committed' ? 'session.committed-no-ack' : authority.status === 'not-committed' ? 'session.not-committed' : 'session.mutation-ambiguous', retryAllowed: authority.status === 'not-committed', recoveryDecision: authority.status, transactionId: authority.transactionId, ...(intent ? { idempotencyKey: intent.idempotencyKey } : { discoveredByMember: true }), claimId });
      if (authority.status === 'committed') {
        if (!hasCommittedProjection(snapshot, authority)) snapshot = await handle.append({ kind: 'document.committed', turnId: started.turnId, stepId: started.stepId, batchId: started.batchId, nodeId, projectRevision: authority.afterRevision, artifactRefs: [authority.receiptArtifactId], payload: { transactionId: authority.transactionId, beforeRevision: authority.beforeRevision, afterRevision: authority.afterRevision, receiptDigest: authority.receiptDigest, receiptArtifactId: authority.receiptArtifactId, reconciliation: true, claimId } });
        snapshot = await handle.append({ kind: 'tool.completed', turnId: started.turnId, stepId: started.stepId, batchId: started.batchId, nodeId, projectRevision: authority.afterRevision, artifactRefs: [authority.receiptArtifactId], payload: { status: 'completed', synthesized: true, reconciledFrom: 'tool.outcome-unknown', transactionId: authority.transactionId, receiptDigest: authority.receiptDigest, claimId } });
        actions.push(Object.freeze({ nodeId, decision: 'synthesized-completion', transactionId: authority.transactionId, diagnostic: 'session.committed-no-ack' }));
      } else if (authority.status === 'not-committed') {
        actions.push(Object.freeze({ nodeId, decision: 'retry-not-committed', transactionId: authority.transactionId, diagnostic: 'session.not-committed' }));
      } else {
        const barrierId = recoveryBarrierId(nodeId);
        snapshot = await appendManualBarrier(handle, started, barrierId, authority.reason, claimId);
        barriers.push(barrierId); actions.push(Object.freeze({ nodeId, decision: 'manual-barrier', transactionId: authority.transactionId, diagnostic: 'session.mutation-ambiguous' }));
      }
    }
    if (barriers.length === 0) {
      const resumableNodeIds = Object.freeze(actions.filter((action) => action.decision.startsWith('retry-')).map((action) => action.nodeId).sort());
      for (const batchId of [...snapshot.recovery.openBatchIds]) snapshot = await handle.append({ kind: 'tool-batch.completed', batchId, payload: { status: 'interrupted', recovered: true, claimId, resumable: resumableNodeIds.length > 0, resumableNodeIds } });
      for (const turnId of [...snapshot.recovery.openTurnIds]) snapshot = await handle.append({ kind: 'turn.completed', turnId, payload: { status: 'interrupted', recovered: true, claimId, resumable: actions.some((action) => action.decision.startsWith('retry-')) } });
      snapshot = await handle.append({ kind: 'session.status-changed', payload: { status: 'interrupted', reason: 'recovery-reconciled', claimId } });
    } else snapshot = await handle.append({ kind: 'session.status-changed', payload: { status: 'waiting-user', reason: 'recovery-ambiguous', claimId, barrierIds: barriers } });
    snapshot = await handle.checkpoint();
    return Object.freeze({ claimId, sourceThroughSequence, actions: Object.freeze(actions), barrierIds: Object.freeze(barriers), snapshot });
  }
}

function hasCommittedProjection(snapshot: SessionReplaySnapshotV1, authority: Extract<MutationRecoveryAuthorityResult, { status: 'committed' }>): boolean {
  return snapshot.ops.some((op) => op.kind === 'document.committed' && op.payload.transactionId === authority.transactionId && op.payload.beforeRevision === authority.beforeRevision && op.payload.afterRevision === authority.afterRevision && op.payload.receiptDigest === authority.receiptDigest && op.artifactRefs.includes(authority.receiptArtifactId));
}

function findPlannedNotStarted(snapshot: SessionReplaySnapshotV1): readonly SessionOpV1[] {
  const openBatches = new Set(snapshot.recovery.openBatchIds);
  const started = new Set(snapshot.ops.filter((op) => op.kind === 'tool.started' && op.nodeId).map((op) => op.nodeId!));
  const planned = new Map<M13StableId, SessionOpV1>();
  for (const op of snapshot.ops) {
    if (op.kind !== 'tool-batch.planned' || !op.nodeId || !op.batchId || !openBatches.has(op.batchId) || started.has(op.nodeId)) continue;
    planned.set(op.nodeId, op);
  }
  return Object.freeze([...planned.values()].sort((left, right) => left.sequence - right.sequence));
}

function findStarted(snapshot: SessionReplaySnapshotV1, nodeId: M13StableId): SessionOpV1 {
  const started = [...snapshot.ops].reverse().find((op) => op.kind === 'tool.started' && op.nodeId === nodeId);
  if (!started) throw new AgentSessionError('session.sequence-gap', `Open tool ${nodeId} has no start operation.`);
  return started;
}

function recoveryEffect(started: SessionOpV1): 'observe' | 'effectful' {
  const effects = started.payload.effects;
  if (Array.isArray(effects) && effects.length === 1 && effects[0] === 'observe') return 'observe';
  if (started.payload.effect === 'observe' || started.payload.executionClass === 'parallel-read') return 'observe';
  return 'effectful';
}

function mutationIntent(snapshot: SessionReplaySnapshotV1, started: SessionOpV1): MutationRecoveryIntent | null {
  const transactionId = stable(started.payload.transactionId); const idempotencyKey = stable(started.payload.idempotencyKey);
  const baseRevision = integer(started.payload.baseRevision ?? started.payload.expectedRevision ?? started.projectRevision);
  const operationDigest = typeof started.payload.operationDigest === 'string' ? started.payload.operationDigest : null;
  if (!started.nodeId || !transactionId || !idempotencyKey || baseRevision === null || !operationDigest) return null;
  return Object.freeze({ sessionId: snapshot.session.id, turnId: started.turnId, batchId: started.batchId, nodeId: started.nodeId, toolCallId: stable(started.payload.toolCallId), toolId: stable(started.payload.toolId), documentId: snapshot.session.documentId, transactionId, idempotencyKey, baseRevision, operationDigest });
}

async function appendOutcomeUnknown(handle: DurableSessionHandle, started: SessionOpV1, payload: JsonObject): Promise<SessionReplaySnapshotV1> {
  return handle.append({ kind: 'tool.outcome-unknown', turnId: started.turnId, stepId: started.stepId, batchId: started.batchId, nodeId: started.nodeId, parentOpId: started.id, dependsOn: [started.id], projectRevision: started.projectRevision, payload: { ...payload, startedOpId: started.id, recoveredAfterRestart: true } });
}

async function appendManualBarrier(handle: DurableSessionHandle, started: SessionOpV1, barrierId: M13StableId, reason: string, claimId: M13StableId): Promise<SessionReplaySnapshotV1> {
  return handle.append({ kind: 'question.requested', turnId: started.turnId, stepId: started.stepId, batchId: started.batchId, nodeId: started.nodeId, projectRevision: started.projectRevision, payload: { questionId: barrierId, barrierKind: 'recovery-takeover', reason: reason.slice(0, 2_048), claimId, expiresAt: null } });
}

function recoveryBarrierId(nodeId: M13StableId): M13StableId { return `barrier:recovery:${nodeId}`.slice(0, 128); }
function stable(value: unknown): M13StableId | null { return typeof value === 'string' && value.length >= 3 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(value) ? value : null; }
function integer(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }
