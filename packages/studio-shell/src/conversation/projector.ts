import type { JsonObject, StableId, StudioDisposable } from '@haiyue/ai-studio-contracts';
import { normalizeBackend, normalizeConversationNode, normalizeTaskAccounting, approvalFromNode, validateConversationIntent } from './validation.js';
import type {
  ConversationBackendReadModel,
  ConversationIntent,
  ConversationNodeReadModel,
  ConversationProjectionEvent,
  ConversationReadModel,
  ConversationReplaySnapshot,
  ConversationUiEvent,
  ConversationUiPort,
  PendingConversationInteraction,
} from './types.js';

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

export class ConversationProjector {
  private readonly nodes = new Map<StableId, ConversationNodeReadModel>();
  private revision = 0;
  private stateRevision = -1;
  private lastSequence = -1;
  private connection: ConversationReadModel['connection'] = 'disconnected';
  private busy = false;
  private backendId: StableId | null = null;
  private backends: readonly ConversationBackendReadModel[] = Object.freeze([]);
  private taskAccounting: ConversationReadModel['taskAccounting'] = null;

  reset(snapshot: ConversationReplaySnapshot): ConversationReadModel {
    this.nodes.clear();
    this.revision = 0;
    this.stateRevision = Math.max(0, snapshot.revision);
    this.lastSequence = -1;
    this.connection = snapshot.connection;
    this.busy = snapshot.busy;
    this.backendId = snapshot.backendId;
    this.backends = normalizeBackends(snapshot.backends);
    this.taskAccounting = normalizeTaskAccounting(snapshot.taskAccounting);
    for (const event of [...snapshot.events].sort((left, right) => left.sequence - right.sequence)) this.apply(event);
    return this.snapshot();
  }

  apply(event: ConversationProjectionEvent): ConversationReadModel {
    if (event.schemaVersion !== 1 || !Number.isInteger(event.sequence) || event.sequence < 0) return this.snapshot();
    if (event.sequence <= this.lastSequence) return this.snapshot();
    const node = normalizeConversationNode(event.node);
    const existing = this.nodes.get(node.id);
    if (existing && !sameCoordinates(existing, node)) return this.snapshot();
    if (existing && terminalStatuses.has(existing.status) && !terminalStatuses.has(node.status)) return this.snapshot();
    this.nodes.set(node.id, node);
    this.lastSequence = event.sequence;
    this.revision += 1;
    return this.snapshot();
  }

  applyState(value: Extract<ConversationUiEvent, { type: 'conversation/state' }>): ConversationReadModel {
    if (!Number.isInteger(value.revision) || value.revision <= this.stateRevision) return this.snapshot();
    this.stateRevision = value.revision;
    this.revision += 1;
    this.connection = value.connection;
    this.busy = value.busy;
    this.backendId = value.backendId;
    this.backends = normalizeBackends(value.backends);
    this.taskAccounting = normalizeTaskAccounting(value.taskAccounting);
    return this.snapshot();
  }

  snapshot(now = Date.now()): ConversationReadModel {
    void now;
    const nodes = Object.freeze([...this.nodes.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
    const pendingInteraction = findPendingInteraction(nodes);
    const composerBlockedReason = pendingInteraction
      ? pendingInteraction.kind === 'approval' ? 'Resolve the pending approval before sending another message.'
        : pendingInteraction.kind === 'plan' ? 'Review the implementation plan before continuing.' : 'Answer the pending question before sending another message.'
      : this.connection !== 'connected' ? 'Reconnect before sending a message.'
        : this.busy ? 'Wait for the active turn or cancel it.' : null;
    return Object.freeze({
      revision: this.revision, lastSequence: this.lastSequence, connection: this.connection, busy: this.busy,
      backendId: this.backendId, backends: this.backends, taskAccounting: this.taskAccounting, nodes, pendingInteraction, composerBlockedReason,
    });
  }
}

export class ConversationController implements StudioDisposable {
  private readonly projector = new ConversationProjector();
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(snapshot: ConversationReadModel) => void>();
  private readonly resolving = new Set<StableId>();
  private subscription: StudioDisposable | null = null;
  private mounted = false;
  private disposed = false;

  constructor(private readonly port: ConversationUiPort, private readonly clock: () => number = Date.now) {}

  async mount(): Promise<ConversationReadModel> {
    this.assertActive();
    if (this.mounted) return this.snapshot();
    this.mounted = true;
    const replay = await this.port.replay(this.abort.signal);
    this.assertActive();
    this.projector.reset(replay);
    this.subscription = this.port.subscribe((event) => this.receive(event));
    this.emit();
    return this.snapshot();
  }

  snapshot(): ConversationReadModel { this.assertActive(); return this.projector.snapshot(this.clock()); }

  subscribe(listener: (snapshot: ConversationReadModel) => void): StudioDisposable {
    this.assertActive();
    this.listeners.add(listener);
    listener(this.snapshot());
    let active = true;
    return Object.freeze({ dispose: () => { if (active) { active = false; this.listeners.delete(listener); } } });
  }

  async send(prompt: string): Promise<void> {
    const snapshot = this.snapshot();
    if (snapshot.composerBlockedReason) throw new Error(snapshot.composerBlockedReason);
    if (!snapshot.backendId) throw new Error('Select an Agent backend before sending.');
    const normalized = prompt.trim();
    if (!normalized) throw new Error('Message cannot be empty.');
    if (new TextEncoder().encode(normalized).byteLength > 16 * 1024) throw new Error('Message exceeds the 16 KiB composer budget.');
    await this.dispatch(Object.freeze({ type: 'conversation/send', backendId: snapshot.backendId, prompt: normalized }));
  }

  async cancel(): Promise<void> {
    const snapshot = this.snapshot();
    const active = [...snapshot.nodes].reverse().find((node) => node.status === 'streaming' || node.status === 'pending');
    if (!snapshot.backendId || !active) throw new Error('There is no active turn to cancel.');
    await this.dispatch(Object.freeze({ type: 'conversation/cancel', backendId: snapshot.backendId, sessionId: active.provenance.sessionId, turnId: active.provenance.turnId }));
  }

  async retry(nodeId: StableId): Promise<void> {
    const snapshot = this.snapshot();
    const node = snapshot.nodes.find((item) => item.id === nodeId);
    if (!snapshot.backendId || !node || !['failed', 'cancelled'].includes(node.status)) throw new Error('Only a failed or cancelled turn can be retried.');
    await this.dispatch(Object.freeze({ type: 'conversation/retry', backendId: snapshot.backendId, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId }));
  }

  async answerQuestion(nodeId: StableId, answer: JsonObject): Promise<void> {
    const pending = this.snapshot().pendingInteraction;
    if (!pending || pending.kind !== 'question' || pending.nodeId !== nodeId) throw new Error('Question is no longer pending.');
    await this.dispatchOnce(nodeId, Object.freeze({ type: 'conversation/answer-question', nodeId, answer }));
  }

  async acceptPlan(nodeId: StableId, acceptedItemIds: readonly StableId[], note?: string, mode: 'approve' | 'revise' = 'approve'): Promise<void> {
    const node = this.snapshot().nodes.find((item) => item.id === nodeId && item.knownKind === 'plan');
    if (!node || node.status !== 'pending') throw new Error('Plan is no longer pending.');
    await this.dispatchOnce(nodeId, Object.freeze({ type: 'conversation/accept-plan', nodeId, acceptedItemIds: Object.freeze([...acceptedItemIds]), mode, ...(note?.trim() ? { note: note.trim().slice(0, 2_048) } : {}) }));
  }

  async resolveApproval(nodeId: StableId, decision: 'allow-once' | 'allow-always' | 'reject'): Promise<void> {
    const node = this.snapshot().nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error('Approval is unavailable.');
    const approval = approvalFromNode(node);
    if (!approval || approval.decision !== 'pending' || node.status !== 'pending') throw new Error('Approval is no longer pending.');
    await this.dispatchOnce(nodeId, Object.freeze({ type: 'conversation/resolve-approval', approvalId: approval.approvalId, decision }));
  }

  async selectBackend(backendId: StableId): Promise<void> {
    if (!this.snapshot().backends.some((item) => item.id === backendId)) throw new Error('Backend is unavailable.');
    await this.dispatch(Object.freeze({ type: 'backend/select', backendId }));
  }

  async authenticate(backendId: StableId): Promise<void> {
    const backend = this.snapshot().backends.find((item) => item.id === backendId);
    if (!backend || backend.state !== 'auth-required') throw new Error('Backend authentication is not required.');
    await this.dispatch(Object.freeze({ type: 'backend/authenticate', backendId }));
  }

  async logout(backendId: StableId): Promise<void> { await this.dispatch(Object.freeze({ type: 'backend/logout', backendId })); }
  async reconnect(): Promise<void> { await this.dispatch(Object.freeze({ type: 'conversation/reconnect' })); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort(new Error('Conversation UI disposed.'));
    void this.subscription?.dispose();
    this.subscription = null;
    this.resolving.clear();
    this.listeners.clear();
  }

  private receive(event: ConversationUiEvent): void {
    if (this.disposed) return;
    try {
      if (event.type === 'conversation/event') this.projector.apply(event.event);
      else this.projector.applyState(event);
      this.emit();
    } catch { /* invalid external read models fail closed and remain invisible */ }
  }

  private async dispatchOnce(lockId: StableId, intent: ConversationIntent): Promise<void> {
    if (this.resolving.has(lockId)) throw new Error('This action is already being resolved.');
    this.resolving.add(lockId);
    try { await this.dispatch(intent); }
    catch (cause) { this.resolving.delete(lockId); throw cause; }
  }

  private async dispatch(intent: ConversationIntent): Promise<void> {
    this.assertActive();
    await this.port.dispatch(validateConversationIntent(intent), this.abort.signal);
    this.assertActive();
  }

  private emit(): void { const snapshot = this.projector.snapshot(this.clock()); for (const listener of [...this.listeners]) listener(snapshot); }
  private assertActive(): void { if (this.disposed) throw new Error('Conversation UI is disposed.'); }
}

function normalizeBackends(values: readonly unknown[]): readonly ConversationBackendReadModel[] {
  const result: ConversationBackendReadModel[] = [];
  for (const value of values) try { result.push(normalizeBackend(value)); } catch { /* invalid provider payload is excluded */ }
  return Object.freeze(result.sort((left, right) => left.label.localeCompare(right.label)));
}

function findPendingInteraction(nodes: readonly ConversationNodeReadModel[]): PendingConversationInteraction | null {
  for (const node of [...nodes].reverse()) {
    if (node.status !== 'pending') continue;
    if (node.knownKind === 'question') return Object.freeze({ nodeId: node.id, kind: 'question' });
    if (node.knownKind === 'plan') return Object.freeze({ nodeId: node.id, kind: 'plan' });
    if (node.knownKind === 'approval') {
      const approval = approvalFromNode(node);
      if (approval?.decision === 'pending') return Object.freeze({ nodeId: node.id, kind: 'approval' });
    }
  }
  return null;
}

function sameCoordinates(left: ConversationNodeReadModel, right: ConversationNodeReadModel): boolean {
  return left.provenance.backendId === right.provenance.backendId && left.provenance.sessionId === right.provenance.sessionId
    && left.provenance.turnId === right.provenance.turnId && left.kind === right.kind;
}
