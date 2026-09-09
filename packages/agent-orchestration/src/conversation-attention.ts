import { approvalFromNode, normalizeConversationNode, normalizeTaskRuns, type ConversationNodeReadModel, type ConversationReplaySnapshot } from '@haiyue/ai-studio-shell/conversation';

export interface ConversationAttentionTarget {
  readonly projectId: string;
  readonly documentId: string;
  readonly nodeId: string | null;
  readonly taskId: string | null;
}
export interface ConversationAttention extends ConversationAttentionTarget {
  readonly id: string;
  readonly kind: 'approval' | 'question' | 'plan' | 'completed' | 'failed' | 'blocked';
  readonly expiresAt: number | null;
}
export type ConversationAttentionChange = Readonly<{ type: 'show'; notice: ConversationAttention }> | Readonly<{ type: 'withdraw'; id: string }>;

/** Observes existing read models only. Hydration establishes a silent baseline;
 * model turn completion, tool failures and busy=false never imply task success. */
export class ConversationAttentionTracker {
  private initialized = false;
  private sequence = -1;
  private readonly nodes = new Map<string, ConversationNodeReadModel>();
  private tasks = new Map<string, string>();
  private active = new Map<string, ConversationAttention>();

  reset(): readonly ConversationAttentionChange[] {
    const changes = [...this.active.keys()].map(id => ({ type: 'withdraw' as const, id }));
    this.initialized = false; this.sequence = -1; this.nodes.clear(); this.tasks.clear(); this.active.clear();
    return changes;
  }

  update(projectId: string, documentId: string, snapshot: ConversationReplaySnapshot, now = Date.now()): readonly ConversationAttentionChange[] {
    const initial = !this.initialized;
    for (const event of snapshot.events) {
      if (event.sequence <= this.sequence) continue;
      const node = normalizeConversationNode(event.node);
      if (['approval', 'question', 'plan'].includes(node.kind)) this.nodes.set(node.id, node);
      this.sequence = event.sequence;
    }
    // A retained projection may evict old nodes; do not retain their reminders.
    const retained = new Set(snapshot.events.map(event => (event.node as { id?: unknown } | null)?.id));
    for (const id of this.nodes.keys()) if (!retained.has(id)) this.nodes.delete(id);
    const runs = normalizeTaskRuns(snapshot.taskRuns), next = new Map<string, ConversationAttention>();
    for (const [id, node] of this.nodes) {
      if (node.status !== 'pending') { this.nodes.delete(id); continue; }
      const approval = node.kind === 'approval' ? approvalFromNode(node) : null;
      const expiresAt = approval?.expiresAt ? Date.parse(approval.expiresAt) : null;
      if (node.kind === 'approval' && (!approval || approval.decision !== 'pending' || (expiresAt !== null && expiresAt <= now))) continue;
      const taskId = runs.find(run => run.sessionId === node.provenance.sessionId && run.turnId === node.provenance.turnId)?.taskId ?? null;
      const notice: ConversationAttention = { id: `${projectId}/${documentId}/node/${id}`, projectId, documentId, nodeId: id, taskId, kind: node.kind as 'approval' | 'question' | 'plan', expiresAt };
      next.set(notice.id, notice);
    }
    for (const run of runs) {
      if (!['completed', 'failed', 'blocked'].includes(run.status)) continue;
      const notice: ConversationAttention = { id: `${projectId}/${documentId}/task/${run.taskId}/${run.status}`, projectId, documentId, nodeId: null, taskId: run.taskId, kind: run.status as 'completed' | 'failed' | 'blocked', expiresAt: null };
      // Include historical terminal states in the baseline without notifying.
      if (initial || this.tasks.has(run.taskId)) next.set(notice.id, notice);
    }
    const changes: ConversationAttentionChange[] = [];
    for (const id of this.active.keys()) if (!next.has(id)) changes.push({ type: 'withdraw', id });
    if (!initial) for (const [id, notice] of next) if (!this.active.has(id)) changes.push({ type: 'show', notice });
    this.active = next; this.tasks = new Map(runs.map(run => [run.taskId, run.status])); this.initialized = true;
    return changes;
  }
}
