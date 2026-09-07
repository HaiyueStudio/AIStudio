import { asStableId } from '@haiyue/ai-studio-contracts';
import type { SessionRecoveryAuthorityPort } from '@haiyue/ai-studio-agent-runtime';
import type { ProjectWorkspace } from '@haiyue/ai-studio-editor-plugins';
import { sha256 } from '@haiyue/ai-studio-operation-log';

/** Adapts editor History receipts to the provider-neutral recovery authority. */
export function createWorkspaceRecoveryAuthority(workspace: Pick<ProjectWorkspace, 'reconcileTransactionIdentity' | 'reconcileTransactionMember'>): SessionRecoveryAuthorityPort {
  return {
    async reconcileMutation(intent) {
      const result = await workspace.reconcileTransactionIdentity({ transactionId: asStableId(intent.transactionId), idempotencyKey: asStableId(intent.idempotencyKey), baseRevision: intent.baseRevision, operationDigest: digest(intent.operationDigest) });
      if (result.status === 'committed') return Object.freeze({ status: 'committed' as const, transactionId: intent.transactionId, beforeRevision: result.receipt.beforeRevision, afterRevision: result.receipt.afterRevision, receiptDigest: result.receipt.receiptDigest, receiptArtifactId: result.receipt.artifactId });
      if (result.status === 'not-committed') return Object.freeze({ status: 'not-committed' as const, transactionId: intent.transactionId, currentRevision: result.revision });
      return Object.freeze({ status: 'ambiguous' as const, transactionId: intent.transactionId, currentRevision: result.revision, reason: result.reason });
    },

    async discoverMutation(intent) {
      const { nodeId, baseRevision } = intent;
      const result = await workspace.reconcileTransactionMember(asStableId(nodeId), baseRevision);
      if (result.status === 'committed') return Object.freeze({ status: 'committed' as const, transactionId: result.receipt.transactionId, beforeRevision: result.receipt.beforeRevision, afterRevision: result.receipt.afterRevision, receiptDigest: result.receipt.receiptDigest, receiptArtifactId: result.receipt.artifactId });
      if (result.status === 'not-committed') return Object.freeze({ status: 'not-committed' as const, transactionId: asStableId(`transaction:undiscovered:${sha256(nodeId).slice(0, 24)}`), currentRevision: result.revision });
      return Object.freeze({ status: 'ambiguous' as const, transactionId: asStableId(`transaction:ambiguous:${sha256(nodeId).slice(0, 24)}`), currentRevision: result.revision, reason: result.reason });
    }
  };
}

function digest(value: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError('Recovery operation digest is invalid.');
  return value as `sha256:${string}`;
}
