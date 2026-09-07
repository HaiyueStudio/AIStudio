import { asStableId, type StableId } from '@haiyue/ai-studio-contracts';
import { DurableSessionRecoveryCoordinator, type DurableSessionHandle, type SessionRecoveryAuthorityPort, type SessionRecoveryRun } from '@haiyue/ai-studio-agent-runtime';
import { sha256, type ConversationOperationLog } from '@haiyue/ai-studio-operation-log';

export interface RecoveryClaimLease { release(): Promise<void>; }
export interface RecoveryClaimPort { acquire(sessionId: StableId, claimId: StableId): Promise<RecoveryClaimLease | null>; }

export class StudioSessionOrchestrator {
  private readonly recovery: DurableSessionRecoveryCoordinator;

  constructor(authority: SessionRecoveryAuthorityPort, private readonly operationLog: ConversationOperationLog, private readonly claims?: RecoveryClaimPort) {
    this.recovery = new DurableSessionRecoveryCoordinator(authority);
  }

  async recover(handle: DurableSessionHandle, claimId?: StableId): Promise<SessionRecoveryRun> {
    const claim = claimId ?? asStableId(`claim:g07:${sha256(`${handle.id}:${Date.now()}`).slice(0, 24)}`);
    const lease = this.claims ? await this.claims.acquire(asStableId(handle.id), claim) : null;
    if (this.claims && !lease) {
      const snapshot = await handle.snapshot();
      await this.operationLog.append({ kind: 'agent/session-recovery-claim-contended', severity: 'warning', source: asStableId('studio.session-orchestrator'), correlation: { sessionId: asStableId(handle.id) }, payload: { claimId: claim, sourceThroughSequence: snapshot.ops.at(-1)?.sequence ?? 0, action: 'defer-to-live-owner' } });
      return Object.freeze({ claimId: claim, sourceThroughSequence: snapshot.ops.at(-1)?.sequence ?? 0, actions: Object.freeze([]), barrierIds: snapshot.recovery.unresolvedBarrierIds, snapshot });
    }
    let run: SessionRecoveryRun;
    try { run = await this.recovery.recover(handle, claim); }
    finally { await lease?.release(); }
    await this.operationLog.append({
      kind: 'agent/session-recovery', severity: run.barrierIds.length > 0 ? 'warning' : 'info', source: asStableId('studio.session-orchestrator'), correlation: { sessionId: asStableId(handle.id) },
      payload: { claimId: run.claimId, sourceThroughSequence: run.sourceThroughSequence, actionCount: run.actions.length, actions: run.actions.map((action) => ({ nodeId: action.nodeId, decision: action.decision, transactionId: action.transactionId, diagnostic: action.diagnostic })), barrierIds: run.barrierIds },
    });
    return run;
  }
}
