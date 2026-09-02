import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { asStableId, type StableId } from '@haiyue/ai-studio-contracts';
import { DurableSessionRecoveryCoordinator, type DurableSessionHandle, type MutationRecoveryIntent, type SessionRecoveryRun } from '@haiyue/ai-studio-agent-runtime';
import type { ProjectWorkspace } from '@haiyue/ai-studio-editor-plugins';
import { sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';

export class StudioSessionOrchestrator {
  private readonly recovery: DurableSessionRecoveryCoordinator;

  constructor(private readonly workspace: ProjectWorkspace, private readonly operationLog: OperationLog, private readonly claims?: RecoveryClaimStore) {
    this.recovery = new DurableSessionRecoveryCoordinator({ reconcileMutation: (intent) => this.reconcileMutation(intent), discoverMutation: (intent) => this.discoverMutation(intent.nodeId as StableId, intent.baseRevision) });
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

  private async reconcileMutation(intent: MutationRecoveryIntent) {
    const result = await this.workspace.reconcileTransactionIdentity({ transactionId: asStableId(intent.transactionId), idempotencyKey: asStableId(intent.idempotencyKey), baseRevision: intent.baseRevision, operationDigest: digest(intent.operationDigest) });
    if (result.status === 'committed') return Object.freeze({ status: 'committed' as const, transactionId: intent.transactionId, beforeRevision: result.receipt.beforeRevision, afterRevision: result.receipt.afterRevision, receiptDigest: result.receipt.receiptDigest, receiptArtifactId: result.receipt.artifactId });
    if (result.status === 'not-committed') return Object.freeze({ status: 'not-committed' as const, transactionId: intent.transactionId, currentRevision: result.revision });
    return Object.freeze({ status: 'ambiguous' as const, transactionId: intent.transactionId, currentRevision: result.revision, reason: result.reason });
  }

  private async discoverMutation(nodeId: StableId, baseRevision: number) {
    const result = await this.workspace.reconcileTransactionMember(asStableId(nodeId), baseRevision);
    if (result.status === 'committed') return Object.freeze({ status: 'committed' as const, transactionId: result.receipt.transactionId, beforeRevision: result.receipt.beforeRevision, afterRevision: result.receipt.afterRevision, receiptDigest: result.receipt.receiptDigest, receiptArtifactId: result.receipt.artifactId });
    if (result.status === 'not-committed') return Object.freeze({ status: 'not-committed' as const, transactionId: asStableId(`transaction:undiscovered:${sha256(nodeId).slice(0, 24)}`), currentRevision: result.revision });
    return Object.freeze({ status: 'ambiguous' as const, transactionId: asStableId(`transaction:ambiguous:${sha256(nodeId).slice(0, 24)}`), currentRevision: result.revision, reason: result.reason });
  }
}

export interface RecoveryClaimLease { readonly sessionId: StableId; readonly claimId: StableId; readonly ownerPid: number; release(): Promise<void>; }

/** Cross-process fence for one Session recovery owner. A dead PID is recoverable; a live owner always wins. */
export class RecoveryClaimStore {
  private readonly root: string;
  constructor(rootDirectory: string) {
    if (!path.isAbsolute(rootDirectory)) throw new TypeError('Recovery claim root must be absolute.');
    this.root = path.resolve(rootDirectory);
  }

  async acquire(sessionId: StableId, claimId: StableId): Promise<RecoveryClaimLease | null> {
    await mkdir(this.root, { recursive: true });
    const directory = this.claimDirectory(sessionId); const ownerFile = path.join(directory, 'owner.json');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(directory);
        const owner = Object.freeze({ schemaVersion: 1, sessionId, claimId, pid: process.pid, createdAt: new Date().toISOString() });
        await writeFile(ownerFile, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
        let released = false;
        return Object.freeze({ sessionId, claimId, ownerPid: process.pid, release: async () => {
          if (released) return; released = true;
          const current = await readOwner(ownerFile).catch(() => null);
          if (current?.claimId === claimId && current.pid === process.pid) await removeClaimDirectory(directory, this.root);
        } });
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause;
        const owner = await readOwner(ownerFile).catch(() => null);
        if (owner && processAlive(owner.pid)) return null;
        await removeClaimDirectory(directory, this.root);
      }
    }
    return null;
  }

  private claimDirectory(sessionId: StableId): string { return path.join(this.root, `session-${sha256(sessionId).slice(0, 40)}`); }
}

async function readOwner(ownerFile: string): Promise<Readonly<{ claimId: string; pid: number }>> {
  const value = JSON.parse(await readFile(ownerFile, 'utf8')) as Record<string, unknown>;
  if (typeof value.claimId !== 'string' || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) throw new TypeError('Recovery claim owner is invalid.');
  return Object.freeze({ claimId: value.claimId, pid: Number(value.pid) });
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (cause) { return !cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'ESRCH'; } }
function isAlreadyExists(cause: unknown): boolean { return Boolean(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST'); }
async function removeClaimDirectory(directory: string, root: string): Promise<void> {
  const resolved = path.resolve(directory); const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix) || resolved === path.resolve(root)) throw new Error('Refusing to remove a recovery claim outside its root.');
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

function digest(value: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError('Recovery operation digest is invalid.');
  return value as `sha256:${string}`;
}
