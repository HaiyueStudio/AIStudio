import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { AgentBackend, AgentBackendEvent, AgentLoginHandoff, AgentRuntimeService } from '@haiyue/ai-studio-agent-runtime';
import type { GameAuthoringToolService, GameToolApproval, GameToolPreparation } from '@haiyue/ai-studio-game-authoring-tools';
import { sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import {
  validateConversationIntent,
  type ConversationBackendReadModel,
  type ConversationIntent,
  type ConversationNodeReadModel,
  type ConversationProjectionEvent,
  type ConversationReplaySnapshot,
} from '@haiyue/ai-studio-shell';

interface ActiveTurn { readonly backendId: StableId; sessionId: StableId | null; turnId: StableId | null; readonly controller: AbortController; }
interface PendingApproval { readonly preparation: GameToolPreparation; readonly approval: GameToolApproval; readonly nodeId: StableId; readonly resolve: () => void; readonly reject: (cause: unknown) => void; }
interface PendingQuestion { readonly backend: AgentBackend; readonly nodeId: StableId; readonly backendNodeId: StableId; }

export interface ConversationHostOptions {
  readonly runtime: AgentRuntimeService;
  readonly tools: GameAuthoringToolService;
  readonly operationLog: OperationLog;
  readonly isProjectOpen?: () => boolean;
  readonly openLoginHandoff?: (backendId: StableId, handoff: AgentLoginHandoff) => Promise<void>;
}

/** Main-process owner for backend streams, tool execution, approvals and replayable UI read models. */
export class StudioConversationHost {
  private readonly events: ConversationProjectionEvent[] = [];
  private readonly nodes = new Map<StableId, ConversationNodeReadModel>();
  private readonly approvals = new Map<StableId, PendingApproval>();
  private readonly questions = new Map<StableId, PendingQuestion>();
  private readonly listeners = new Set<() => void>();
  private backends: readonly ConversationBackendReadModel[] = Object.freeze([]);
  private backendId: StableId | null = null;
  private active: ActiveTurn | null = null;
  private eventSequence = 0;
  private nodeSequence = 0;
  private stateRevision = 0;
  private disposed = false;

  constructor(private readonly options: ConversationHostOptions) {}

  async initialize(): Promise<void> { await this.refreshBackends(); }

  subscribe(listener: () => void): Readonly<{ dispose(): void }> {
    this.assertActive();
    this.listeners.add(listener);
    let active = true;
    return Object.freeze({ dispose: () => { if (active) { active = false; this.listeners.delete(listener); } } });
  }

  replay(): ConversationReplaySnapshot {
    this.assertActive();
    return Object.freeze({
      revision: this.stateRevision,
      connection: 'connected',
      busy: this.active !== null,
      backendId: this.backendId,
      backends: this.backends,
      events: Object.freeze(this.events.map((event) => Object.freeze({ ...event, source: 'replay' as const }))),
    });
  }

  async dispatch(value: unknown, signal?: AbortSignal): Promise<void> {
    this.assertActive();
    const intent = validateConversationIntent(value);
    await this.options.operationLog.append({
      kind: 'conversation/intent', severity: 'info', source: asStableId('studio.conversation-host'), correlation: {},
      payload: intentLogPayload(intent),
    }, { signal });
    switch (intent.type) {
      case 'conversation/send':
        if (this.active) throw new Error('An Agent turn is already active.');
        if (intent.backendId !== this.backendId) throw new Error('Selected backend changed before send.');
        void this.start(intent.backendId, intent.prompt);
        return;
      case 'conversation/cancel': {
        const active = this.active;
        if (!active || active.backendId !== intent.backendId || active.sessionId !== intent.sessionId || active.turnId !== intent.turnId) throw new Error('Active turn coordinates changed.');
        active.controller.abort(new Error('Turn cancelled by user.'));
        await this.options.runtime.turns.cancel(intent.backendId, intent.sessionId, intent.turnId);
        return;
      }
      case 'conversation/retry':
        if (this.active) throw new Error('An Agent turn is already active.');
        void this.resume(intent.backendId, intent.sessionId, intent.turnId);
        return;
      case 'conversation/reconnect': await this.refreshBackends(); return;
      case 'conversation/answer-question': {
        const pending = this.questions.get(intent.nodeId);
        if (!pending) throw new Error('Question is stale or already answered.');
        this.questions.delete(intent.nodeId);
        await pending.backend.answerQuestion(pending.backendNodeId, intent.answer, signal);
        this.finishNode(intent.nodeId, 'completed');
        return;
      }
      case 'conversation/accept-plan': this.finishNode(intent.nodeId, 'completed'); return;
      case 'conversation/resolve-approval': await this.resolveApproval(intent.approvalId, intent.decision); return;
      case 'backend/select':
        if (this.active) throw new Error('Cannot switch backend during an active turn.');
        if (!this.backends.some((backend) => backend.id === intent.backendId)) throw new Error('Backend is unavailable in this profile.');
        this.backendId = intent.backendId; this.changed(); return;
      case 'backend/authenticate': {
        const backend = this.options.runtime.registry.get(intent.backendId);
        const handoff = await backend.authenticate(signal);
        if (handoff) {
          if (!this.options.openLoginHandoff) throw new Error('Backend login handoff is unavailable in this host.');
          await this.options.openLoginHandoff(intent.backendId, handoff);
        }
        await this.refreshBackends(); return;
      }
      case 'backend/logout': {
        const backend = this.options.runtime.registry.get(intent.backendId);
        await backend.logout(signal); await this.refreshBackends(); return;
      }
      case 'logs/export-bug-bundle': throw new Error('Bug bundle export is handled by the log IPC owner.');
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.cancelPending('Conversation host disposed.');
    this.questions.clear();
    this.listeners.clear();
    this.disposed = true;
  }

  cancelPending(reason = 'Renderer owner changed.'): void {
    const active = this.active;
    active?.controller.abort(new Error(reason));
    if (active?.sessionId && active.turnId) void this.options.runtime.turns.cancel(active.backendId, active.sessionId, active.turnId).catch(() => undefined);
    this.active = null;
    for (const pending of this.approvals.values()) {
      void this.options.tools.decide(pending.approval.approvalId, 'cancel').catch(() => undefined);
      pending.reject(new Error(reason));
    }
    this.approvals.clear();
    this.changed();
  }

  private async start(backendId: StableId, prompt: string): Promise<void> {
    const controller = new AbortController();
    this.active = { backendId, sessionId: null, turnId: null, controller };
    this.changed();
    const tools = this.options.tools.definitions().map((definition) => Object.freeze({
      id: definition.id,
      description: `${definition.description} Effect: ${definition.effect}. Risk: ${definition.risk}.${definition.id === 'project.snapshot' ? ' Call this before deciding whether a Studio project is open and before planning mutations.' : ''}`,
      inputSchema: definition.inputSchema,
    }));
    const contextualPrompt = agentPrompt(prompt, this.options.isProjectOpen?.() === true);
    try {
      await this.consume(backendId, this.options.runtime.turns.start(backendId, { prompt: contextualPrompt, contextArtifactIds: Object.freeze([]), tools }, controller.signal), controller.signal);
    } catch (cause) { await this.captureFailure(backendId, cause); }
    finally { if (this.active?.controller === controller) { this.active = null; this.changed(); } }
  }

  private async resume(backendId: StableId, sessionId: StableId, turnId: StableId): Promise<void> {
    const controller = new AbortController();
    this.active = { backendId, sessionId, turnId, controller };
    this.changed();
    try { await this.consume(backendId, this.options.runtime.turns.resume(backendId, sessionId, turnId, controller.signal), controller.signal); }
    catch (cause) { await this.captureFailure(backendId, cause, sessionId, turnId); }
    finally { if (this.active?.controller === controller) { this.active = null; this.changed(); } }
  }

  private async consume(backendId: StableId, stream: AsyncIterable<AgentBackendEvent>, signal: AbortSignal): Promise<void> {
    const backend = this.options.runtime.registry.get(backendId);
    for await (const event of stream) {
      if (signal.aborted) throw signal.reason;
      if (this.active) { this.active.sessionId = event.sessionId; this.active.turnId = event.turnId; }
      await this.captureEvent(backend, event, signal);
    }
  }

  private async captureEvent(backend: AgentBackend, event: AgentBackendEvent, signal: AbortSignal): Promise<void> {
    const provenance = Object.freeze({ backendId: event.backendId, sessionId: event.sessionId, turnId: event.turnId });
    if (event.kind === 'conversation-node') {
      const id = this.internalNodeId('text', event.turnId);
      const previous = this.nodes.get(id);
      const text = `${typeof previous?.content.text === 'string' ? previous.content.text : ''}${typeof event.payload.delta === 'string' ? event.payload.delta : ''}`.slice(0, 16_384);
      this.project(id, 'text', event.payload.status === 'completed' ? 'completed' : 'streaming', provenance, Object.freeze({ text, role: 'assistant' }));
      return;
    }
    if (event.kind === 'tool-request') { await this.executeTool(backend, event, signal); return; }
    if (event.kind === 'question') {
      const backendNodeId = stablePayloadId(event.payload.nodeId, 'question node');
      const nodeId = this.nextNodeId('question');
      const options = questionOptions(event.payload.questions);
      this.questions.set(nodeId, Object.freeze({ backend, nodeId, backendNodeId }));
      this.project(nodeId, 'question', 'pending', provenance, Object.freeze({ prompt: 'The Agent needs clarification before continuing.', options, allowFreeform: true, multiple: false }));
      return;
    }
    if (event.kind === 'diagnostic') {
      this.project(this.nextNodeId('diagnostic'), 'diagnostic', 'failed', provenance, Object.freeze({
        code: stringField(event.payload.code, 'agent.diagnostic'), message: stringField(event.payload.message, 'Agent backend reported a diagnostic.'), severity: 'error', retryable: event.payload.retryable === true,
      }));
      return;
    }
    if (event.kind === 'completed') {
      const status = terminalStatus(event.payload.status);
      const textId = this.internalNodeId('text', event.turnId);
      if (this.nodes.has(textId)) this.finishNode(textId, status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed');
      this.project(this.nextNodeId('completion'), 'completion', status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed', provenance,
        Object.freeze({ terminalStatus: status, summary: `Agent turn ${status}.` }));
    }
  }

  private async executeTool(backend: AgentBackend, event: AgentBackendEvent, signal: AbortSignal): Promise<void> {
    const toolCallId = stablePayloadId(event.payload.toolCallId, 'tool call');
    const toolId = stablePayloadId(event.payload.toolId, 'tool');
    const args = isRecord(event.payload.arguments) ? event.payload.arguments as JsonObject : Object.freeze({});
    const provenance = Object.freeze({ backendId: event.backendId, sessionId: event.sessionId, turnId: event.turnId, stepId: toolCallId });
    this.project(this.nextNodeId('tool-call'), 'tool-call', 'completed', provenance, Object.freeze({ toolCallId, toolId, argumentsSummary: `Validated structured arguments (${Object.keys(args).sort().join(', ') || 'none'}).` }));
    try {
      const preparation = await this.options.tools.prepare({ schemaVersion: 1, id: toolCallId, sessionId: event.sessionId, turnId: event.turnId, toolId, toolVersion: '1.0.0', arguments: args }, signal);
      if (preparation.approvalId) await this.awaitApproval(preparation, provenance, signal);
      const result = await this.options.tools.execute(preparation.id, signal);
      this.project(this.nextNodeId('tool-result'), 'tool-result', result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed', provenance,
        Object.freeze({ toolCallId, resultStatus: result.status, summary: boundedJson(result.value) }));
      await backend.submitToolResult(toolCallId, Object.freeze({ status: result.status, value: result.value, documentId: result.documentId, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision }), signal);
    } catch (cause) {
      const diagnostic = Object.freeze({ code: errorCode(cause), message: errorMessage(cause) });
      this.project(this.nextNodeId('tool-result'), 'tool-result', signal.aborted ? 'cancelled' : 'failed', provenance,
        Object.freeze({ toolCallId, resultStatus: signal.aborted ? 'cancelled' : 'failed', summary: diagnostic.message }));
      await backend.submitToolResult(toolCallId, Object.freeze({ status: 'failed', error: diagnostic }), signal).catch(() => undefined);
    }
  }

  private awaitApproval(preparation: GameToolPreparation, provenance: ConversationNodeReadModel['provenance'], signal: AbortSignal): Promise<void> {
    const approval = this.options.tools.approval(preparation.approvalId!);
    if (!approval) return Promise.reject(new Error('Prepared approval is unavailable.'));
    const nodeId = this.nextNodeId('approval');
    this.project(nodeId, 'approval', 'pending', provenance, approvalContent(preparation, approval));
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => { this.approvals.delete(approval.approvalId); reject(signal.reason ?? new Error('Approval cancelled.')); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.approvals.set(approval.approvalId, Object.freeze({
        preparation, approval, nodeId,
        resolve: () => { signal.removeEventListener('abort', abort); resolve(); },
        reject: (cause: unknown) => { signal.removeEventListener('abort', abort); reject(cause); },
      }));
    });
  }

  private async resolveApproval(approvalId: StableId, decision: 'allow-once' | 'reject'): Promise<void> {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error('Approval is stale or already resolved.');
    this.approvals.delete(approvalId);
    const resolved = await this.options.tools.decide(approvalId, decision);
    const current = this.nodes.get(pending.nodeId)!;
    this.project(pending.nodeId, 'approval', 'completed', current.provenance, approvalContent(pending.preparation, resolved));
    pending.resolve();
  }

  private async refreshBackends(): Promise<void> {
    const values: ConversationBackendReadModel[] = [];
    for (const descriptor of this.options.runtime.registry.descriptors()) {
      const backend = this.options.runtime.registry.get(descriptor.id);
      try {
        const status = await backend.status();
        values.push(Object.freeze({ id: descriptor.id, label: descriptor.kind === 'harness-api-key' ? 'DeepSeek Harness' : 'Local Codex', kind: descriptor.kind, ...status }));
      } catch (cause) {
        values.push(Object.freeze({ id: descriptor.id, label: descriptor.kind, kind: descriptor.kind, state: 'error', authMode: descriptor.kind === 'harness-api-key' ? 'api-key' : 'chatgpt', rateLimits: Object.freeze([]), diagnostic: Object.freeze({ code: errorCode(cause), message: errorMessage(cause) }) }));
      }
    }
    this.backends = Object.freeze(values);
    if (!this.backendId || !values.some((value) => value.id === this.backendId)) this.backendId = values[0]?.id ?? null;
    this.changed();
  }

  private async captureFailure(backendId: StableId, cause: unknown, sessionId?: StableId, turnId?: StableId): Promise<void> {
    if (this.disposed) return;
    const session = sessionId ?? this.active?.sessionId ?? asStableId('session:unavailable');
    const turn = turnId ?? this.active?.turnId ?? asStableId('turn:unavailable');
    this.project(this.nextNodeId('diagnostic'), 'diagnostic', this.active?.controller.signal.aborted ? 'cancelled' : 'failed', Object.freeze({ backendId, sessionId: session, turnId: turn }),
      Object.freeze({ code: errorCode(cause), message: errorMessage(cause), severity: 'error', retryable: false }));
    await this.options.operationLog.append({ kind: 'conversation/host-failed', severity: 'error', source: asStableId('studio.conversation-host'), correlation: { sessionId: session, turnId: turn }, payload: { code: errorCode(cause), message: errorMessage(cause) } }).catch(() => undefined);
  }

  private project(id: StableId, kind: string, status: ConversationNodeReadModel['status'], provenance: ConversationNodeReadModel['provenance'], content: JsonObject): void {
    const previous = this.nodes.get(id);
    const node = Object.freeze({ schemaVersion: 1 as const, id, kind, knownKind: null, status, createdAt: previous?.createdAt ?? new Date().toISOString(), provenance, content, payloadTruncated: false });
    this.nodes.set(id, node);
    this.eventSequence += 1;
    this.events.push(Object.freeze({ schemaVersion: 1, sequence: this.eventSequence, source: 'live', node }));
    if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
    this.changed();
  }

  private changed(): void {
    this.stateRevision += 1;
    if (this.listeners.size === 0) return;
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* Projection observers cannot break the turn owner. */ }
    }
  }

  private finishNode(id: StableId, status: ConversationNodeReadModel['status']): void {
    const node = this.nodes.get(id);
    if (node) this.project(id, node.kind, status, node.provenance, node.content);
  }

  private internalNodeId(kind: string, turnId: StableId): StableId { return asStableId(`node:${kind}:${sha256(turnId).slice(7, 23)}`); }
  private nextNodeId(kind: string): StableId { this.nodeSequence += 1; return asStableId(`node:${kind}:${this.nodeSequence}`); }
  private assertActive(): void { if (this.disposed) throw new Error('Conversation host is disposed.'); }
}

function approvalContent(preparation: GameToolPreparation, approval: GameToolApproval): JsonObject {
  return Object.freeze({
    approvalId: approval.approvalId, toolCallId: approval.toolCallId, toolId: approval.toolId, toolVersion: approval.toolVersion,
    target: approval.target, effect: approval.effect, risk: approval.risk, argumentsSummary: preparation.preview.summary,
    previewDiff: preparation.preview.diff, baseRevision: approval.baseRevision, argsDigest: presentationDigest(approval.argumentsDigest),
    previewDigest: presentationDigest(approval.previewDigest), expiresAt: approval.expiresAt, decision: approval.decision,
  });
}
function presentationDigest(value: string): string { return value.startsWith('sha256:') ? value : `sha256:${value}`; }
function intentLogPayload(intent: ConversationIntent): JsonObject {
  if (intent.type === 'conversation/send') return Object.freeze({ type: intent.type, backendId: intent.backendId, promptDigest: sha256(intent.prompt), promptBytes: Buffer.byteLength(intent.prompt) });
  return Object.freeze({ type: intent.type, ...('backendId' in intent ? { backendId: intent.backendId } : {}), ...('approvalId' in intent ? { approvalId: intent.approvalId, decision: intent.decision } : {}) });
}
function questionOptions(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value)) return Object.freeze([Object.freeze({ id: asStableId('option:continue'), label: 'Continue' })]);
  return Object.freeze(value.slice(0, 8).map((_, index) => Object.freeze({ id: asStableId(`option:${index + 1}`), label: `Option ${index + 1}` })));
}
function stablePayloadId(value: unknown, label: string): StableId { if (typeof value !== 'string') throw new TypeError(`${label} is invalid.`); return asStableId(value, label); }
function terminalStatus(value: unknown): 'completed' | 'cancelled' | 'failed' | 'interrupted' { return value === 'completed' || value === 'cancelled' || value === 'failed' || value === 'interrupted' ? value : 'failed'; }
function stringField(value: unknown, fallback: string): string { return typeof value === 'string' ? value.slice(0, 2_000) : fallback; }
function boundedJson(value: JsonObject): string { const text = JSON.stringify(value); return text.length > 2_000 ? `${text.slice(0, 1_997)}...` : text; }
function agentPrompt(prompt: string, projectOpen: boolean): string {
  return [
    'Authoritative AIStudio runtime context:',
    JSON.stringify({ schemaVersion: 1, project: { open: projectOpen } }),
    'Treat this project-open state as newer than assumptions from the user request. Call project.snapshot before deciding availability or using a base revision.',
    projectOpen
      ? 'A project is open. Do not claim that no AIStudio project is open.'
      : 'No project is open. Ask the user to create or open one, then resend the complete request; do not tell them to reply only with "continue" because turns may be independent.',
    'User request:',
    prompt,
  ].join('\n');
}
function errorCode(value: unknown): string { return value && typeof value === 'object' && 'code' in value ? String((value as { code: unknown }).code).slice(0, 96) : 'conversation.operation-failed'; }
function errorMessage(value: unknown): string { return (value instanceof Error ? value.message : String(value)).slice(0, 2_000); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
