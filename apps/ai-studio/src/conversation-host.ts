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

interface ActiveTurn {
  readonly backendId: StableId;
  sessionId: StableId | null;
  turnId: StableId | null;
  readonly controller: AbortController;
  readonly initialProgressNodeId: StableId;
  readonly localSessionId: StableId;
  readonly localTurnId: StableId;
  approvedPlan: ApprovedPlanExecution | null;
  continuationRequested: boolean;
}
interface PendingApproval { readonly preparation: GameToolPreparation; readonly approval: GameToolApproval; readonly nodeId: StableId; readonly resolve: () => void; readonly reject: (cause: unknown) => void; }
interface PendingQuestion { readonly backend: AgentBackend; readonly nodeId: StableId; readonly backendNodeId: StableId; }
interface PendingPlan {
  readonly nodeId: StableId;
  readonly toolCallId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly title: string;
  readonly summary: string;
  readonly items: readonly Readonly<{ id: StableId; label: string; details?: string }>[];
  readonly resolve: (result: JsonObject) => void;
  readonly reject: (cause: unknown) => void;
}
interface ApprovedPlanExecution {
  readonly title: string;
  readonly summary: string;
  readonly items: readonly Readonly<{ id: StableId; label: string; details?: string }>[];
  readonly note?: string;
  attempts: number;
  mutationCount: number;
}

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
  private readonly plans = new Map<StableId, PendingPlan>();
  private readonly approvedPlanTurns = new Set<string>();
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
        const matchesBackendTurn = active?.sessionId === intent.sessionId && active.turnId === intent.turnId;
        const matchesInitialProgress = active?.localSessionId === intent.sessionId && active.localTurnId === intent.turnId;
        if (!active || active.backendId !== intent.backendId || (!matchesBackendTurn && !matchesInitialProgress)) throw new Error('Active turn coordinates changed.');
        active.controller.abort(new Error('Turn cancelled by user.'));
        if (active.sessionId && active.turnId) await this.options.runtime.turns.cancel(intent.backendId, active.sessionId, active.turnId);
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
      case 'conversation/accept-plan': this.resolvePlan(intent.nodeId, intent.acceptedItemIds, intent.note, intent.mode ?? 'approve'); return;
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
    this.plans.clear();
    this.approvedPlanTurns.clear();
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
    for (const pending of this.plans.values()) pending.reject(new Error(reason));
    this.plans.clear();
    this.approvedPlanTurns.clear();
    this.changed();
  }

  private async start(backendId: StableId, prompt: string): Promise<void> {
    const controller = new AbortController();
    const localSessionId = asStableId(`session:pending:${this.nodeSequence + 1}`);
    const localTurnId = asStableId(`turn:pending:${this.nodeSequence + 1}`);
    const userNodeId = this.nextNodeId('00-user');
    const initialProgressNodeId = this.nextNodeId('01-progress');
    const provenance = Object.freeze({ backendId, sessionId: localSessionId, turnId: localTurnId });
    this.active = { backendId, sessionId: null, turnId: null, controller, initialProgressNodeId, localSessionId, localTurnId, approvedPlan: null, continuationRequested: false };
    this.project(userNodeId, 'text', 'completed', provenance, Object.freeze({ text: prompt, role: 'user' }));
    this.project(initialProgressNodeId, 'progress', 'pending', provenance, Object.freeze({
      label: '正在分析需求', message: 'Agent 正在读取项目上下文并规划下一步。', phase: 'awaiting-first-step',
    }));
    const tools = [PLAN_TOOL_DEFINITION, ...this.options.tools.definitions()].map((definition) => Object.freeze({
      id: definition.id,
      description: `${definition.description} Effect: ${definition.effect}. Risk: ${definition.risk}.${definition.id === 'project.snapshot' ? ' Call this before deciding whether a Studio project is open and before planning mutations.' : ''}`,
      inputSchema: definition.inputSchema,
    }));
    const contextualPrompt = agentPrompt(prompt, this.options.isProjectOpen?.() === true);
    try {
      await this.consume(backendId, this.options.runtime.turns.start(backendId, { prompt: contextualPrompt, contextArtifactIds: Object.freeze([]), tools }, controller.signal), controller.signal);
    } catch (cause) { await this.captureFailure(backendId, cause); }
    finally {
      const progress = this.nodes.get(initialProgressNodeId);
      if (progress && (progress.status === 'pending' || progress.status === 'streaming')) this.finishNode(initialProgressNodeId, controller.signal.aborted ? 'cancelled' : 'completed');
      const owned = this.active?.controller === controller ? this.active : null;
      if (owned?.sessionId && owned.turnId) this.approvedPlanTurns.delete(turnKey(owned.sessionId, owned.turnId));
      const continuation = owned?.continuationRequested ? owned.approvedPlan : null;
      if (owned && continuation) await this.continueApprovedPlan(backendId, continuation);
      else if (owned) { this.active = null; this.changed(); }
    }
  }

  private async continueApprovedPlan(backendId: StableId, plan: ApprovedPlanExecution): Promise<void> {
    const controller = new AbortController();
    const localSessionId = asStableId(`session:approved-plan:${this.nodeSequence + 1}`);
    const localTurnId = asStableId(`turn:approved-plan:${this.nodeSequence + 1}`);
    const initialProgressNodeId = this.nextNodeId('approved-plan-progress');
    this.active = { backendId, sessionId: null, turnId: null, controller, initialProgressNodeId, localSessionId, localTurnId, approvedPlan: plan, continuationRequested: false };
    this.project(initialProgressNodeId, 'progress', 'pending', Object.freeze({ backendId, sessionId: localSessionId, turnId: localTurnId }), Object.freeze({
      label: '正在执行已批准方案', message: '规划阶段已结束，Agent 正在按已批准步骤调用编辑器工具。', phase: 'approved-plan-execution',
    }));
    const tools = [PLAN_TOOL_DEFINITION, ...this.options.tools.definitions()].map((definition) => Object.freeze({
      id: definition.id,
      description: `${definition.description} Effect: ${definition.effect}. Risk: ${definition.risk}.${definition.id === 'project.snapshot' ? ' Call this before using a base revision.' : ''}`,
      inputSchema: definition.inputSchema,
    }));
    await this.options.operationLog.append({
      kind: 'conversation/approved-plan-continuing', severity: 'info', source: asStableId('studio.conversation-host'), correlation: {},
      payload: { titleDigest: sha256(plan.title), itemCount: plan.items.length, attempt: plan.attempts },
    }).catch(() => undefined);
    try {
      await this.consume(backendId, this.options.runtime.turns.start(backendId, {
        prompt: approvedPlanPrompt(plan, this.options.isProjectOpen?.() === true), contextArtifactIds: Object.freeze([]), tools,
      }, controller.signal), controller.signal);
    } catch (cause) { await this.captureFailure(backendId, cause); }
    finally {
      const progress = this.nodes.get(initialProgressNodeId);
      if (progress && (progress.status === 'pending' || progress.status === 'streaming')) this.finishNode(initialProgressNodeId, controller.signal.aborted ? 'cancelled' : 'completed');
      const owned = this.active?.controller === controller ? this.active : null;
      if (owned?.sessionId && owned.turnId) this.approvedPlanTurns.delete(turnKey(owned.sessionId, owned.turnId));
      if (owned) { this.active = null; this.changed(); }
    }
  }

  private async resume(backendId: StableId, sessionId: StableId, turnId: StableId): Promise<void> {
    const controller = new AbortController();
    const initialProgressNodeId = this.nextNodeId('progress');
    this.active = { backendId, sessionId, turnId, controller, initialProgressNodeId, localSessionId: sessionId, localTurnId: turnId, approvedPlan: null, continuationRequested: false };
    this.project(initialProgressNodeId, 'progress', 'pending', Object.freeze({ backendId, sessionId, turnId }), Object.freeze({
      label: '正在恢复任务', message: 'Agent 正在恢复上次任务的上下文。', phase: 'awaiting-first-step',
    }));
    try { await this.consume(backendId, this.options.runtime.turns.resume(backendId, sessionId, turnId, controller.signal), controller.signal); }
    catch (cause) { await this.captureFailure(backendId, cause, sessionId, turnId); }
    finally {
      const progress = this.nodes.get(initialProgressNodeId);
      if (progress && (progress.status === 'pending' || progress.status === 'streaming')) this.finishNode(initialProgressNodeId, controller.signal.aborted ? 'cancelled' : 'completed');
      if (this.active?.controller === controller) { this.active = null; this.changed(); }
    }
  }

  private async consume(backendId: StableId, stream: AsyncIterable<AgentBackendEvent>, signal: AbortSignal): Promise<void> {
    const backend = this.options.runtime.registry.get(backendId);
    for await (const event of stream) {
      if (signal.aborted) throw signal.reason;
      if (this.active) {
        this.active.sessionId = event.sessionId; this.active.turnId = event.turnId;
        if (this.active.approvedPlan) this.approvedPlanTurns.add(turnKey(event.sessionId, event.turnId));
      }
      await this.captureEvent(backend, event, signal);
    }
  }

  private async captureEvent(backend: AgentBackend, event: AgentBackendEvent, signal: AbortSignal): Promise<void> {
    const provenance = Object.freeze({ backendId: event.backendId, sessionId: event.sessionId, turnId: event.turnId });
    if (event.kind === 'conversation-node' || event.kind === 'tool-request' || event.kind === 'question' || event.kind === 'diagnostic' || event.kind === 'completed') {
      const progressNodeId = this.active?.initialProgressNodeId;
      if (progressNodeId) this.finishNode(progressNodeId, 'completed');
    }
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
      const approvedPlan = this.active?.sessionId === event.sessionId && this.active.turnId === event.turnId ? this.active.approvedPlan : null;
      if (status === 'completed' && approvedPlan && approvedPlan.mutationCount === 0 && approvedPlan.attempts < 1) {
        approvedPlan.attempts += 1;
        if (this.active) this.active.continuationRequested = true;
        return;
      }
      if (status === 'completed' && approvedPlan && approvedPlan.mutationCount === 0) {
        this.project(this.nextNodeId('diagnostic'), 'diagnostic', 'failed', provenance, Object.freeze({
          code: 'plan.execution-not-started', message: 'Agent 在已批准方案下仍未执行任何编辑操作。请重新发送需求；Studio 不会把该方案误报为已执行。', severity: 'error', retryable: false,
        }));
      }
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
    const toolNodeId = this.nextNodeId('tool-call');
    let stage: 'prepare' | 'approval' | 'execute' | 'submit-result' = 'prepare';
    this.project(toolNodeId, 'tool-call', 'pending', provenance, Object.freeze({ toolCallId, toolId, argumentsSummary: toolArgumentSummary(toolId, args) }));
    try {
      if (toolId === PLAN_TOOL_ID) {
        const result = await this.awaitPlan(toolCallId, event.sessionId, event.turnId, args, provenance, signal);
        this.project(toolNodeId, 'tool-call', 'completed', provenance, Object.freeze({ toolCallId, toolId, target: 'Current project', effect: 'observe', argumentsSummary: '总体实现方案已由用户审阅。' }));
        this.project(this.nextNodeId('tool-result'), 'tool-result', 'completed', provenance,
          Object.freeze({ toolCallId, toolId, resultStatus: 'completed', summary: result.approvedForExecution === true ? '方案已确认，开始执行。' : '用户补充了信息，需要更新方案。' }));
        await backend.submitToolResult(toolCallId, Object.freeze({ status: 'completed', value: result }), signal);
        return;
      }
      const definition = this.options.tools.definitions().find((item) => item.id === toolId);
      if (definition && definition.effect !== 'observe' && !this.approvedPlanTurns.has(turnKey(event.sessionId, event.turnId))) {
        throw new PlanProtocolError('plan.approval-required', 'Submit studio.plan.propose and wait for user confirmation before mutating the project.');
      }
      const preparation = await this.options.tools.prepare({ schemaVersion: 1, id: toolCallId, sessionId: event.sessionId, turnId: event.turnId, toolId, toolVersion: '1.0.0', arguments: args }, signal);
      this.project(toolNodeId, 'tool-call', 'completed', provenance, Object.freeze({
        toolCallId, toolId, target: preparation.preview.target, effect: preparation.effect, argumentsSummary: preparation.preview.summary,
      }));
      stage = 'approval';
      if (preparation.approvalId) await this.awaitApproval(preparation, provenance, signal);
      stage = 'execute';
      const result = await this.options.tools.execute(preparation.id, signal);
      if (definition && definition.effect !== 'observe' && this.active?.sessionId === event.sessionId && this.active.turnId === event.turnId && this.active.approvedPlan) {
        this.active.approvedPlan.mutationCount += 1;
      }
      this.project(this.nextNodeId('tool-result'), 'tool-result', result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed', provenance,
        Object.freeze({ toolCallId, toolId, resultStatus: result.status, summary: toolResultSummary(toolId, result.status, result.value, preparation.preview.summary), details: boundedJson(result.value) }));
      stage = 'submit-result';
      await backend.submitToolResult(toolCallId, Object.freeze({ status: result.status, value: result.value, documentId: result.documentId, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision }), signal);
    } catch (cause) {
      const diagnostic = Object.freeze({ code: errorCode(cause), message: errorMessage(cause) });
      await this.options.operationLog.append({
        kind: 'conversation/tool-failed', severity: signal.aborted ? 'warning' : 'error', source: asStableId('studio.conversation-host'),
        correlation: { sessionId: event.sessionId, turnId: event.turnId, toolCallId },
        payload: { toolId, stage, argumentKeys: Object.freeze(Object.keys(args).sort()), code: diagnostic.code, message: diagnostic.message },
      }).catch(() => undefined);
      this.project(this.nextNodeId('tool-result'), 'tool-result', signal.aborted ? 'cancelled' : 'failed', provenance,
        Object.freeze({ toolCallId, toolId, resultStatus: signal.aborted ? 'cancelled' : 'failed', summary: diagnostic.message }));
      await backend.submitToolResult(toolCallId, Object.freeze({ status: 'failed', error: diagnostic }), signal).catch(() => undefined);
    }
  }

  private awaitPlan(toolCallId: StableId, sessionId: StableId, turnId: StableId, args: JsonObject, provenance: ConversationNodeReadModel['provenance'], signal: AbortSignal): Promise<JsonObject> {
    const proposal = validatePlanProposal(args);
    const nodeId = this.nextNodeId('plan');
    const items = Object.freeze(proposal.items.map((item, index) => Object.freeze({
      id: asStableId(`plan-item:${this.nodeSequence}:${index + 1}`), label: item.label, ...(item.details ? { details: item.details } : {}),
    })));
    this.project(nodeId, 'plan', 'pending', provenance, Object.freeze({
      title: proposal.title,
      summary: proposal.summary,
      items: Object.freeze(items.map((item) => Object.freeze({ ...item, status: 'pending' }))),
    }));
    return new Promise<JsonObject>((resolve, reject) => {
      const abort = (): void => { this.plans.delete(nodeId); reject(signal.reason ?? new Error('Plan review cancelled.')); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.plans.set(nodeId, Object.freeze({
        nodeId, toolCallId, sessionId, turnId, title: proposal.title, summary: proposal.summary, items,
        resolve: (result: JsonObject) => { signal.removeEventListener('abort', abort); resolve(result); },
        reject: (cause: unknown) => { signal.removeEventListener('abort', abort); reject(cause); },
      }));
    });
  }

  private resolvePlan(nodeId: StableId, acceptedItemIds: readonly StableId[], note: string | undefined, mode: 'approve' | 'revise'): void {
    const pending = this.plans.get(nodeId);
    if (!pending) throw new Error('Plan is stale or already resolved.');
    const accepted = new Set(acceptedItemIds);
    if (acceptedItemIds.some((id) => !pending.items.some((item) => item.id === id))) throw new Error('Plan selection contains an unknown item.');
    if (mode === 'approve' && accepted.size === 0) throw new Error('Approve at least one plan item or request a revision.');
    if (mode === 'revise' && !note?.trim()) throw new Error('Add guidance before requesting a revised plan.');
    this.plans.delete(nodeId);
    if (mode === 'approve') this.approvedPlanTurns.add(turnKey(pending.sessionId, pending.turnId));
    else this.approvedPlanTurns.delete(turnKey(pending.sessionId, pending.turnId));
    if (mode === 'approve' && this.active?.sessionId === pending.sessionId && this.active.turnId === pending.turnId) {
      this.active.approvedPlan = {
        title: pending.title,
        summary: pending.summary,
        items: Object.freeze(pending.items.filter((item) => accepted.has(item.id))),
        ...(note?.trim() ? { note: note.trim().slice(0, 2_048) } : {}),
        attempts: 0,
        mutationCount: 0,
      };
    }
    const current = this.nodes.get(nodeId);
    if (current) this.project(nodeId, 'plan', 'completed', current.provenance, Object.freeze({
      title: pending.title,
      items: Object.freeze(pending.items.map((item) => Object.freeze({ ...item, status: mode === 'approve' && accepted.has(item.id) ? 'accepted' : 'rejected' }))),
      decision: mode === 'approve' ? 'approved' : 'revision-requested',
      ...(note?.trim() ? { note: note.trim().slice(0, 2_048) } : {}),
    }));
    pending.resolve(Object.freeze({
      approvedForExecution: mode === 'approve',
      decision: mode === 'approve' ? 'approved' : 'revision-requested',
      acceptedItemIds: Object.freeze([...accepted]),
      ...(note?.trim() ? { userNote: note.trim().slice(0, 2_048) } : {}),
      instruction: mode === 'approve'
        ? 'Execute only the accepted plan items, incorporate the user note, and use independent tool calls without asking approval for low-risk reversible edits.'
        : 'Revise the implementation plan from the user note and call studio.plan.propose again before any mutation.',
    }));
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

  private async resolveApproval(approvalId: StableId, decision: 'allow-once' | 'allow-always' | 'reject'): Promise<void> {
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
    if (node && node.status !== status) this.project(id, node.kind, status, node.provenance, node.content);
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
    previewDigest: presentationDigest(approval.previewDigest), decision: approval.decision,
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
function toolArgumentSummary(toolId: StableId, args: JsonObject): string {
  const raw = args as Record<string, unknown>;
  if (toolId === PLAN_TOOL_ID) return `准备提交“${typeof raw.title === 'string' ? raw.title : '总体实现方案'}”供用户确认。`;
  if (toolId === 'entity.create') {
    const kind = String(raw.kind ?? 'entity');
    const category = ['cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron'].includes(kind) ? `几何体 ${kind}` : kind.endsWith('-light') ? `光源 ${kind}` : '逻辑节点';
    return `准备创建${category}${typeof raw.name === 'string' ? `“${raw.name}”` : ''}。`;
  }
  if (toolId === 'transform.set') return '准备更新物体的位置、旋转和缩放。';
  if (toolId === 'material.set') return '准备为选中的几何体应用引擎材质。';
  if (toolId === 'script.propose') return '准备校验一份新的控制脚本提案。';
  if (toolId === 'script.apply') return '准备提交已经通过校验的脚本。';
  if (toolId === 'preview.validate') return '准备校验项目运行计划。';
  if (toolId === 'preview.start') return '准备启动隔离预览。';
  if (toolId === 'preview.stop') return '准备停止隔离预览。';
  return `准备调用 ${toolId}。`;
}
function toolResultSummary(toolId: StableId, status: 'completed' | 'rejected' | 'cancelled' | 'failed', value: JsonObject, fallback: string): string {
  const raw = value as Record<string, unknown>;
  if (status !== 'completed') {
    if (raw.decision === 'expired') return '授权已过期，操作未执行。请重新批准重新校验后的操作。';
    if (status === 'cancelled' || raw.decision === 'cancel') return '操作已取消，没有修改项目。';
    if (raw.decision === 'reject') return '操作已被拒绝，没有修改项目。';
    return `操作未执行：${fallback}`;
  }
  const entity = isRecord(raw.entity) ? raw.entity : null;
  const entityName = entity && typeof entity.name === 'string' ? `“${entity.name}”` : '物体';
  const revision = typeof raw.revision === 'number' ? ` · 项目 r${raw.revision}` : '';
  if (toolId === 'project.snapshot') return `已读取项目“${typeof raw.name === 'string' ? raw.name : '未命名'}” · r${typeof raw.revision === 'number' ? raw.revision : '?'}${raw.dirty === true ? ' · 有未保存修改' : ''}`;
  if (toolId === 'scene.list-entities') return `已读取场景 · ${Array.isArray(raw.entities) ? raw.entities.length : 0} 个物体${raw.truncated === true ? '（结果已截断）' : ''}`;
  if (toolId === 'entity.get') return `已读取${entityName}${revision}`;
  if (toolId === 'entity.create') return `已创建${entityName}${revision}`;
  if (toolId === 'entity.rename') return `已重命名为${entityName}${revision}`;
  if (toolId === 'transform.set') return `已更新${entityName}的 Transform${revision}`;
  if (toolId === 'material.set') return `已更新${entityName}的材质${revision}`;
  if (toolId === 'script.get') {
    const script = isRecord(raw.script) ? raw.script : null;
    return `已读取脚本${script && typeof script.name === 'string' ? `“${script.name}”` : ''}${script && typeof script.textRevision === 'number' ? ` · 文本 r${script.textRevision}` : ''}`;
  }
  if (toolId === 'diagnostics.query') return `已读取 ${typeof raw.count === 'number' ? raw.count : 0} 条诊断记录。`;
  if (toolId === 'script.propose') {
    const diagnostics = Array.isArray(raw.diagnostics) ? raw.diagnostics : [];
    const errors = diagnostics.filter((item) => isRecord(item) && item.severity === 'error').length;
    return errors > 0 ? `脚本提案有 ${errors} 个错误，需要修改后重新校验。` : `脚本提案校验通过 · +${numberField(raw.addedLines)}/-${numberField(raw.removedLines)} 行`;
  }
  if (toolId === 'script.apply') return `脚本已提交${typeof raw.textRevision === 'number' ? ` · 文本 r${raw.textRevision}` : ''}${revision}`;
  if (toolId === 'preview.validate') {
    const diagnostics = Array.isArray(raw.diagnostics) ? raw.diagnostics : [];
    const errors = diagnostics.filter((item) => isRecord(item) && item.severity === 'error').length;
    return errors > 0 ? `运行计划校验失败 · ${errors} 个错误` : '运行计划校验通过。';
  }
  if (toolId === 'preview.start') return '隔离预览已启动。';
  if (toolId === 'preview.stop') return '隔离预览已停止并完成资源清理。';
  return fallback;
}
function numberField(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function agentPrompt(prompt: string, projectOpen: boolean): string {
  return [
    'Authoritative AIStudio runtime context:',
    JSON.stringify({ schemaVersion: 1, project: { open: projectOpen } }),
    'Treat this project-open state as newer than assumptions from the user request. Call project.snapshot before deciding availability or using a base revision.',
    projectOpen
      ? 'A project is open. Do not claim that no AIStudio project is open.'
      : 'No project document is open. Ask the user to click New once; New creates an untitled in-memory project and does not require a folder. Do not ask the user to choose a directory before authoring.',
    'Authoring workflow invariants:',
    '- Before every project mutation, inspect project.snapshot and scene.list-entities, then call studio.plan.propose with a detailed, user-readable plan. The plan must identify each authored entity, its responsibility and script owner, plus the rendering/data strategy for dynamic or repeated content. Do not call a mutation tool until studio.plan.propose returns approvedForExecution=true.',
    '- Stable, independently editable scene objects should be authoring entities. Repeated or fast-changing gameplay state such as a snake body, trail, bullet pool, tile grid, foliage or particles must normally use one semantic authoring entity with controller-owned reusable/instance data. For Snake, do not create one entity per body segment: use one SnakeBody entity and vary its active instance data as length changes.',
    '- Explicitly compare persistent entities, controller-managed state, pooling and instanced rendering in the plan. There is no arbitrary entity-count limit, but duplicated entities are not an acceptable substitute for dynamic instance data when the objects share geometry, material, lifetime and behavior. If the current runtime lacks a required instance operation, disclose that limitation in the plan instead of silently generating many entities.',
    '- Dynamic instances are supported in trusted preview scripts with the scene capability: const body = api.scene.instances("SnakeBody", 256); body.setCount(length); body.set(index, { position: { x, y, z }, scale: { x: 1, y: 1, z: 1 }, color: [0.12, 0.82, 0.28, 1] }). Create exactly one geometry entity with that name and let one controller update its instance data.',
    '- After the plan is approved, execute the accepted low-risk reversible edits directly and efficiently. Independent operations may be issued together; dependent operations must still consume the preceding tool result. Ask again only when the scope materially expands beyond the approved plan.',
    '- entity.create supports geometry cube, sphere, cone, cylinder, plane, torus and icosahedron; lights directional-light, point-light and ambient-light; and entity-specific material appearances using basic, pbr, blinn-phong or normal plus RGBA color channels from 0 to 1. The plan must define a deliberate visual palette, and semantically different roles such as snake, food and board must not all keep the default color. Set material and color during entity.create, or use material.set for an existing geometry.',
    '- Instanced content controls color per instance: pass color in every api.scene.instances(...).set(index, { position, color: [r, g, b, a] }) call when the instances need a deliberate palette. The authoring entity material color does not replace per-instance colors during instanced preview rendering.',
    '- Put project-wide gameplay in one clearly named Empty controller such as GameController or <GameName>Game. The Run command chooses controller-like nodes ahead of incidental Scene selection. Use api.read.find/api.read.findAll or world lookups to update the visible entities from that controller.',
    '- For a new visual game or any request that includes Play/preview, create at least one geometry entity before proposing scripts or calling preview.validate. Do not rely on a script to create the initial authoring scene.',
    '- Project scripts are onUpdate function bodies, not modules: entity, component, world, time, delta, and api are already in scope. Never emit import, export, require, module.exports, or an exported/lifecycle-function wrapper.',
    '- If script source uses api.scene (including api.scene.instances), include scene in script.propose capabilities and reuse the capabilities returned by script.propose for preview.validate. A script.ts.2339 saying scene is missing is a capability mismatch: add scene to the tool capabilities instead of repeatedly rewriting the same source.',
    '- After every script.propose call, inspect the diagnostics and canApply fields. If any error exists or canApply is false, do not call script.apply. Rewrite the complete script, propose again, and repeat until diagnostics contain zero errors; only then apply it.',
    '- Studio binds the current authoritative baseRevision when it is omitted. Never guess a revision. If you explicitly provide baseRevision, use the last returned afterRevision.',
    '- Put the initial position, rotation and scale in entity.create.transform. Do not issue transform.set for an entity being created in the same tool batch: wait for entity.create to return result.entity.id before any later edit.',
    '- After each mutation, inspect its result before issuing a dependent mutation. Do not retry preview.start unchanged after a no-renderables failure; create an appropriate geometry primitive, verify the scene, validate again, then start the new plan.',
    'User request:',
    prompt,
  ].join('\n');
}
function approvedPlanPrompt(plan: ApprovedPlanExecution, projectOpen: boolean): string {
  return [
    'Authoritative AIStudio runtime context:',
    JSON.stringify({ schemaVersion: 1, project: { open: projectOpen }, approvedPlan: {
      title: plan.title,
      summary: plan.summary,
      items: plan.items.map((item) => ({ label: item.label, ...(item.details ? { details: item.details } : {}) })),
      ...(plan.note ? { userNote: plan.note } : {}),
    } }),
    projectOpen
      ? 'A project is open. The user already approved the plan above in AIStudio.'
      : 'The project was closed after approval. Explain that execution cannot continue; do not claim the plan was executed.',
    'Execution continuation invariants:',
    '- Do not call studio.plan.propose again. This continuation exists because the previous planning turn ended without performing any approved edit.',
    '- Immediately inspect project.snapshot and scene.list-entities, then execute the approved items with the supplied Studio mutation tools.',
    '- Low-risk reversible edits covered by the approved plan do not need another plan confirmation. Dangerous capabilities may still require their scoped approval card.',
    '- Use one semantic authoring entity plus controller-owned instance data for repeated dynamic content; never create one persistent entity per snake body segment.',
    '- Preserve the approved visual palette: entity.create and material.set accept normalized RGBA color. Use visibly different colors for distinct gameplay roles. For api.scene.instances, set color on each instance transform rather than relying on the authoring entity default.',
    '- Project scripts are onUpdate function bodies. Never emit import, export, require, module.exports, or a lifecycle wrapper.',
    '- If source uses api.scene, include scene in script.propose capabilities and reuse the returned capabilities for preview.validate. Treat script.ts.2339 for api.scene as a missing capability, not as source that should be retried unchanged.',
    '- Do not finish with a statement that you are waiting for approval: approval has already been granted. Finish only after executing tools or reporting a concrete tool limitation.',
  ].join('\n');
}
const PLAN_TOOL_ID = asStableId('studio.plan.propose');
const PLAN_TOOL_DEFINITION = Object.freeze({
  id: PLAN_TOOL_ID,
  description: 'Submit the complete implementation plan for user review before any project mutation. Include authored entities, responsibilities, scripts, dynamic state ownership, and rendering strategy such as instancing or pooling. The result blocks until the user approves or requests a revision.',
  effect: 'observe' as const,
  risk: 'low' as const,
  inputSchema: Object.freeze({
    type: 'object', additionalProperties: false, required: Object.freeze(['title', 'summary', 'items']), properties: Object.freeze({
      title: Object.freeze({ type: 'string', minLength: 1, maxLength: 160 }),
      summary: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_200 }),
      items: Object.freeze({ type: 'array', minItems: 1, maxItems: 20, items: Object.freeze({
        type: 'object', additionalProperties: false, required: Object.freeze(['label', 'details']), properties: Object.freeze({
          label: Object.freeze({ type: 'string', minLength: 1, maxLength: 240 }),
          details: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_024 }),
        }),
      }) }),
    }),
  }) as JsonObject,
});

function validatePlanProposal(value: JsonObject): Readonly<{ title: string; summary: string; items: readonly Readonly<{ label: string; details?: string }>[] }> {
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['title', 'summary', 'items'].includes(key)) || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 160
    || typeof raw.summary !== 'string' || !raw.summary.trim() || raw.summary.length > 1_200 || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 20) {
    throw new PlanProtocolError('plan.payload-invalid', 'Plan requires a title, summary and 1-20 detailed items.');
  }
  const items = raw.items.map((value, index) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !['label', 'details'].includes(key)) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 240
      || typeof value.details !== 'string' || !value.details.trim() || value.details.length > 1_024) {
      throw new PlanProtocolError('plan.payload-invalid', `Plan item ${index + 1} requires bounded label and details fields.`);
    }
    return Object.freeze({ label: value.label.trim(), details: value.details.trim() });
  });
  return Object.freeze({ title: raw.title.trim(), summary: raw.summary.trim(), items: Object.freeze(items) });
}
function turnKey(sessionId: StableId, turnId: StableId): string { return `${sessionId}\u0000${turnId}`; }
class PlanProtocolError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'PlanProtocolError'; } }
function errorCode(value: unknown): string { return value && typeof value === 'object' && 'code' in value ? String((value as { code: unknown }).code).slice(0, 96) : 'conversation.operation-failed'; }
function errorMessage(value: unknown): string { return (value instanceof Error ? value.message : String(value)).slice(0, 2_000); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
