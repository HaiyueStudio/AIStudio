import { asStableId, type AgentTurnConfigV2, type JsonObject, type M12ReasoningEffort, type StableId, type TaskBudgetV2 } from '@haiyue/ai-studio-contracts';
import { M12_DEFAULT_PRICING_CATALOG, type AgentBackend, type AgentBackendEvent, type AgentLoginHandoff, type AgentRuntimeService, type BudgetDecision, type ContextProjectSnapshot, type PromptProfileSnapshot, type TaskAccount } from '@haiyue/ai-studio-agent-runtime';
import type { GameAuthoringToolService, GameToolApproval, GameToolPreparation } from '@haiyue/ai-studio-game-authoring-tools';
import { sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import {
  normalizeConversationNode,
  validateConversationIntent,
  type ConversationBackendReadModel,
  type ConversationIntent,
  type ConversationNodeReadModel,
  type ConversationProjectionEvent,
  type ConversationReplaySnapshot,
} from '@haiyue/ai-studio-shell';

interface ActiveTurn {
  readonly backendId: StableId;
  readonly taskId: StableId;
  readonly config: AgentTurnConfigV2;
  readonly account: TaskAccount;
  sessionId: StableId | null;
  turnId: StableId | null;
  readonly controller: AbortController;
  readonly wallTimeBudget: WallTimeBudget;
  readonly initialProgressNodeId: StableId;
  readonly localSessionId: StableId;
  readonly localTurnId: StableId;
  approvedPlan: ApprovedPlanExecution | null;
  continuationRequested: boolean;
  continuationInstruction: string | null;
  budgetCheckpoint: Readonly<{ toolId: StableId; summary: string }> | null;
  readonly conversationKey: StableId;
  readonly projectId: StableId | null;
  readonly goal: string;
  readonly decisions: string[];
  readonly toolFacts: string[];
  readonly blockers: string[];
  contextCommitted: boolean;
}
interface BackendSelection { readonly model: string; readonly reasoningEffort: M12ReasoningEffort; readonly outputTokenLimit: number; }
interface PendingApproval { readonly preparation: GameToolPreparation; readonly approval: GameToolApproval; readonly nodeId: StableId; readonly resolve: () => void; readonly reject: (cause: unknown) => void; }
interface PendingBackendQuestion { readonly kind: 'backend'; readonly backend: AgentBackend; readonly nodeId: StableId; readonly backendNodeId: StableId; readonly releaseHumanWait: () => void; readonly detachAbort: () => void; }
interface PendingBudgetQuestion { readonly kind: 'budget'; readonly nodeId: StableId; readonly continueOptionId: StableId; readonly stopOptionId: StableId; readonly releaseHumanWait: () => void; readonly detachAbort: () => void; readonly resolve: (continued: boolean) => void; readonly reject: (cause: unknown) => void; }
type PendingQuestion = PendingBackendQuestion | PendingBudgetQuestion;
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
  readonly projectContext?: () => ContextProjectSnapshot | null;
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
  private readonly backendSelections = new Map<StableId, BackendSelection>();
  private backends: readonly ConversationBackendReadModel[] = Object.freeze([]);
  private backendId: StableId | null = null;
  private active: ActiveTurn | null = null;
  private eventSequence = 0;
  private nodeSequence = 0;
  private stateRevision = 0;
  private disposed = false;
  private latestTaskId: StableId | null = null;
  private budgetTemplate: TaskBudgetV2 = DEFAULT_TASK_BUDGET;
  private projectionWriteTail: Promise<void> = Promise.resolve();
  private projectionPersistenceFailure: unknown = null;

  constructor(private readonly options: ConversationHostOptions) {}

  async initialize(): Promise<void> { await this.restoreProjection(); await this.refreshBackends(); }

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
      taskAccounting: this.taskAccountingReadModel(),
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
        void this.start(intent.backendId, intent.prompt).catch((cause) => this.captureFailure(intent.backendId, cause));
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
        void this.resume(intent.backendId, intent.sessionId, intent.turnId).catch((cause) => this.captureFailure(intent.backendId, cause, intent.sessionId, intent.turnId));
        return;
      case 'conversation/reconnect': await this.refreshBackends(); return;
      case 'conversation/answer-question': {
        const pending = this.questions.get(intent.nodeId);
        if (!pending) throw new Error('Question is stale or already answered.');
        this.questions.delete(intent.nodeId);
        pending.detachAbort(); pending.releaseHumanWait();
        try {
          if (pending.kind === 'backend') await pending.backend.answerQuestion(pending.backendNodeId, intent.answer, signal);
          else {
            const optionIds = Array.isArray(intent.answer.optionIds) ? intent.answer.optionIds : [];
            if (optionIds.length !== 1 || (optionIds[0] !== pending.continueOptionId && optionIds[0] !== pending.stopOptionId)) throw new Error('Budget continuation answer is invalid.');
            pending.resolve(optionIds[0] === pending.continueOptionId);
          }
          this.finishNode(intent.nodeId, 'completed');
        }
        catch (cause) { if (pending.kind === 'budget') pending.reject(cause); this.finishNode(intent.nodeId, 'failed'); throw cause; }
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
      case 'agent/configure': {
        if (this.active) throw new Error('Cannot change Agent settings during an active task.');
        const backend = this.backends.find((item) => item.id === intent.backendId);
        const model = backend?.models.find((item) => item.id === intent.model);
        if (!backend || !model || !model.reasoningEfforts.includes(intent.reasoningEffort) || intent.outputTokenLimit > model.maxOutputTokens) throw new Error('Agent model settings are unsupported by the selected backend.');
        this.backendSelections.set(intent.backendId, Object.freeze({ model: intent.model, reasoningEffort: intent.reasoningEffort, outputTokenLimit: intent.outputTokenLimit }));
        this.budgetTemplate = intent.budget;
        await this.refreshBackends(); return;
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
    await this.projectionWriteTail;
    if (this.projectionPersistenceFailure) throw new AggregateError([this.projectionPersistenceFailure], 'Conversation projection persistence failed.');
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
    for (const node of [...this.nodes.values()]) {
      if (node.status !== 'pending' && node.status !== 'streaming') continue;
      const content = node.kind === 'approval' ? Object.freeze({ ...node.content, decision: 'stale' }) : node.content;
      this.project(node.id, node.kind, 'cancelled', node.provenance, content);
    }
    this.changed();
  }

  private async start(backendId: StableId, prompt: string): Promise<void> {
    const controller = new AbortController();
    const localSessionId = asStableId(`session:pending:${this.nodeSequence + 1}`);
    const localTurnId = asStableId(`turn:pending:${this.nodeSequence + 1}`);
    const userNodeId = this.nextNodeId('00-user');
    const initialProgressNodeId = this.nextNodeId('01-progress');
    const provenance = Object.freeze({ backendId, sessionId: localSessionId, turnId: localTurnId });
    const taskId = asStableId(`task:conversation:${this.nodeSequence + 1}`);
    const tools = this.modelTools();
    const project = this.options.projectContext?.() ?? null;
    const conversationKey = conversationKeyFor(project);
    const context = await this.options.runtime.context.prepare({ conversationKey, backendId, taskId, request: prompt, tools, project });
    const config = this.turnConfig(backendId, taskId, context.promptProfile);
    const budget = Object.freeze({ ...this.budgetTemplate, id: config.taskBudgetId, limits: Object.freeze({ ...this.budgetTemplate.limits }) });
    const account = this.options.runtime.accounting.open({ taskId, budget, pricingCatalog: M12_DEFAULT_PRICING_CATALOG });
    assertBudgetAllowed(account.beginTurn());
    const wallTimeBudget = armWallTimeBudget(controller, account);
    this.latestTaskId = taskId;
    this.active = { backendId, taskId, config, account, sessionId: null, turnId: null, controller, wallTimeBudget, initialProgressNodeId, localSessionId, localTurnId, approvedPlan: null, continuationRequested: false, continuationInstruction: null, budgetCheckpoint: null, conversationKey, projectId: project?.projectId ?? null, goal: prompt, decisions: [], toolFacts: [], blockers: [], contextCommitted: false };
    this.project(userNodeId, 'text', 'completed', provenance, Object.freeze({ text: prompt, role: 'user' }));
    this.project(initialProgressNodeId, 'progress', 'pending', provenance, Object.freeze({
      label: '正在分析需求', message: 'Agent 正在读取项目上下文并规划下一步。', phase: 'awaiting-first-step',
    }));
    try {
      await this.consume(backendId, this.options.runtime.turns.start(backendId, { taskId, config, ...(context.reusedSessionId ? { sessionId: context.reusedSessionId } : {}), prompt: context.prompt, contextArtifactIds: context.contextArtifactIds, contextCache: context.cache, tools }, controller.signal), controller.signal);
    } catch (cause) { await this.captureFailure(backendId, cause); }
    finally {
      wallTimeBudget.dispose();
      const progress = this.nodes.get(initialProgressNodeId);
      if (progress && (progress.status === 'pending' || progress.status === 'streaming')) this.finishNode(initialProgressNodeId, controller.signal.aborted ? 'cancelled' : 'completed');
      const owned = this.active?.controller === controller ? this.active : null;
      if (owned?.sessionId && owned.turnId) this.approvedPlanTurns.delete(turnKey(owned.sessionId, owned.turnId));
      if (owned?.continuationRequested) {
        await this.continueTask(backendId, owned.approvedPlan, owned.taskId, owned.config, owned.account, owned.conversationKey, owned.goal, owned.continuationInstruction).catch((cause) => this.captureFailure(backendId, cause));
        if (this.active?.controller === controller) { this.active = null; this.changed(); }
      } else if (owned) { this.active = null; this.changed(); }
    }
  }

  private async continueTask(backendId: StableId, plan: ApprovedPlanExecution | null, taskId: StableId, config: AgentTurnConfigV2, account: TaskAccount, conversationKey: StableId, goal: string, continuationInstruction: string | null): Promise<void> {
    const controller = new AbortController();
    const localSessionId = asStableId(`session:approved-plan:${this.nodeSequence + 1}`);
    const localTurnId = asStableId(`turn:approved-plan:${this.nodeSequence + 1}`);
    const initialProgressNodeId = this.nextNodeId('approved-plan-progress');
    let beginDecision = account.beginTurn();
    if (!beginDecision.allowed && beginDecision.status === 'hard-exceeded') {
      const provenance = Object.freeze({ backendId, sessionId: localSessionId, turnId: localTurnId });
      const continued = await this.awaitBudgetContinuation(beginDecision, provenance, controller.signal);
      if (!continued) {
        if (this.active) this.active.decisions.push('User stopped before the approved-plan execution tranche; prior project work was preserved.');
        this.project(this.nextNodeId('completion'), 'completion', 'completed', provenance, Object.freeze({ terminalStatus: 'completed', summary: '用户选择不增加预算；已批准方案未继续执行，此前已经生成并提交的项目产物均已保留。' }));
        return;
      }
      assertBudgetAllowed(account.authorizeContinuation());
      beginDecision = account.beginTurn();
    }
    assertBudgetAllowed(beginDecision);
    const wallTimeBudget = armWallTimeBudget(controller, account);
    const tools = this.modelTools();
    const project = this.options.projectContext?.() ?? null;
    const request = [
      plan ? approvedPlanRequest(plan, project !== null) : budgetContinuationRequest(goal, project !== null),
      continuationInstruction,
    ].filter((value): value is string => Boolean(value)).join('\n\n');
    const context = await this.options.runtime.context.prepare({ conversationKey, backendId, taskId, request, tools, project });
    this.active = { backendId, taskId, config, account, sessionId: null, turnId: null, controller, wallTimeBudget, initialProgressNodeId, localSessionId, localTurnId, approvedPlan: plan, continuationRequested: false, continuationInstruction: null, budgetCheckpoint: null, conversationKey, projectId: project?.projectId ?? null, goal, decisions: plan ? [`Approved plan: ${plan.title}. ${plan.summary}`] : ['User approved continuation after a completed budget checkpoint.'], toolFacts: [], blockers: [], contextCommitted: false };
    this.project(initialProgressNodeId, 'progress', 'pending', Object.freeze({ backendId, sessionId: localSessionId, turnId: localTurnId }), Object.freeze({
      label: plan ? '正在执行已批准方案' : '正在恢复任务', message: plan ? '规划阶段已结束，Agent 正在按已批准步骤调用编辑器工具。' : '预算续期已确认，Agent 正在从安全检查点恢复任务。', phase: plan ? 'approved-plan-execution' : 'budget-continuation',
    }));
    await this.options.operationLog.append({
      kind: 'conversation/approved-plan-continuing', severity: 'info', source: asStableId('studio.conversation-host'), correlation: {},
      payload: { titleDigest: sha256(plan?.title ?? goal), itemCount: plan?.items.length ?? 0, attempt: plan?.attempts ?? 0, reason: continuationInstruction ? 'budget-checkpoint' : 'approved-plan' },
    }).catch(() => undefined);
    try {
      await this.consume(backendId, this.options.runtime.turns.start(backendId, {
        taskId, config, ...(context.reusedSessionId ? { sessionId: context.reusedSessionId } : {}), prompt: context.prompt, contextArtifactIds: context.contextArtifactIds, contextCache: context.cache, tools,
      }, controller.signal), controller.signal);
    } catch (cause) { await this.captureFailure(backendId, cause); }
    finally {
      wallTimeBudget.dispose();
      const progress = this.nodes.get(initialProgressNodeId);
      if (progress && (progress.status === 'pending' || progress.status === 'streaming')) this.finishNode(initialProgressNodeId, controller.signal.aborted ? 'cancelled' : 'completed');
      const owned = this.active?.controller === controller ? this.active : null;
      if (owned?.sessionId && owned.turnId) this.approvedPlanTurns.delete(turnKey(owned.sessionId, owned.turnId));
      if (owned?.continuationRequested) {
        await this.continueTask(backendId, owned.approvedPlan, owned.taskId, owned.config, owned.account, owned.conversationKey, owned.goal, owned.continuationInstruction).catch((cause) => this.captureFailure(backendId, cause));
        if (this.active?.controller === controller) { this.active = null; this.changed(); }
      } else if (owned) { this.active = null; this.changed(); }
    }
  }

  private async resume(backendId: StableId, sessionId: StableId, turnId: StableId): Promise<void> {
    const controller = new AbortController();
    const initialProgressNodeId = this.nextNodeId('progress');
    const priorTaskId = this.options.runtime.usage.get(turnId)?.snapshot().taskId;
    const taskId = priorTaskId ?? asStableId(`task:resume:${this.nodeSequence + 1}`); const config = this.turnConfig(backendId, taskId);
    const existingAccount = this.options.runtime.accounting.get(taskId);
    const budget = Object.freeze({ ...this.budgetTemplate, id: config.taskBudgetId, limits: Object.freeze({ ...this.budgetTemplate.limits }) });
    const account = existingAccount ?? this.options.runtime.accounting.open({ taskId, budget, pricingCatalog: M12_DEFAULT_PRICING_CATALOG });
    const resumeDecision = existingAccount ? account.snapshot().budgetDecision : account.beginTurn();
    const wallTimeBudget = armWallTimeBudget(controller, account);
    this.latestTaskId = taskId;
    const project = this.options.projectContext?.() ?? null;
    this.active = { backendId, taskId, config, account, sessionId, turnId, controller, wallTimeBudget, initialProgressNodeId, localSessionId: sessionId, localTurnId: turnId, approvedPlan: null, continuationRequested: false, continuationInstruction: null, budgetCheckpoint: null, conversationKey: conversationKeyFor(project), projectId: project?.projectId ?? null, goal: 'Retry the interrupted visible task.', decisions: [], toolFacts: [], blockers: [], contextCommitted: false };
    this.project(initialProgressNodeId, 'progress', 'pending', Object.freeze({ backendId, sessionId, turnId }), Object.freeze({
      label: '正在恢复任务', message: 'Agent 正在恢复上次任务的上下文。', phase: 'awaiting-first-step',
    }));
    try {
      if (!resumeDecision.allowed && resumeDecision.status === 'hard-exceeded') {
        const continued = await this.awaitBudgetContinuation(resumeDecision, Object.freeze({ backendId, sessionId, turnId }), controller.signal);
        if (!continued) {
          this.active?.decisions.push('User declined budget continuation while retrying; prior project work was preserved.');
          this.project(this.nextNodeId('completion'), 'completion', 'completed', Object.freeze({ backendId, sessionId, turnId }), Object.freeze({ terminalStatus: 'completed', summary: '用户选择停止恢复任务；此前已经生成并提交的项目产物均已保留。' }));
          return;
        }
        assertBudgetAllowed(account.authorizeContinuation()); wallTimeBudget.resetAfterContinuation();
      } else assertBudgetAllowed(resumeDecision);
      await this.consume(backendId, this.options.runtime.turns.resume(backendId, sessionId, turnId, controller.signal), controller.signal);
    }
    catch (cause) { await this.captureFailure(backendId, cause, sessionId, turnId); }
    finally {
      wallTimeBudget.dispose();
      const progress = this.nodes.get(initialProgressNodeId);
      if (progress && (progress.status === 'pending' || progress.status === 'streaming')) this.finishNode(initialProgressNodeId, controller.signal.aborted ? 'cancelled' : 'completed');
      if (this.active?.controller === controller) { this.active = null; this.changed(); }
    }
  }

  private async consume(backendId: StableId, stream: AsyncIterable<AgentBackendEvent>, signal: AbortSignal): Promise<void> {
    const backend = this.options.runtime.registry.get(backendId);
    for await (const event of stream) {
      if (signal.aborted && event.kind !== 'usage' && event.kind !== 'completed') continue;
      if (this.active) {
        this.active.sessionId = event.sessionId; this.active.turnId = event.turnId;
        const model = typeof event.payload.model === 'string' ? event.payload.model : this.active.config.model;
        this.active.account.bindTurn(event.turnId, { provider: backend.descriptor.kind === 'harness-api-key' ? 'deepseek' : 'openai', model, billingMode: backend.descriptor.kind === 'harness-api-key' ? 'api' : 'subscription' });
        if (this.active.approvedPlan) this.approvedPlanTurns.add(turnKey(event.sessionId, event.turnId));
      }
      if (!signal.aborted) await this.captureEvent(backend, event, signal);
      else if (event.kind === 'completed') await this.commitContext(event, terminalStatus(event.payload.status));
      if ((event.kind === 'usage' || event.kind === 'completed') && this.active) { await this.recordTaskAccounting(this.active.account, event.sessionId, event.turnId); this.changed(); }
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
      this.project(nodeId, 'question', 'pending', provenance, Object.freeze({ prompt: 'The Agent needs clarification before continuing.', options, allowFreeform: true, multiple: false }));
      const releaseHumanWait = this.pauseForHumanInteraction(event.sessionId, event.turnId);
      const abort = (): void => {
        const pending = this.questions.get(nodeId); if (!pending) return;
        this.questions.delete(nodeId); pending.releaseHumanWait(); this.finishNode(nodeId, 'cancelled');
      };
      signal.addEventListener('abort', abort, { once: true });
      this.questions.set(nodeId, Object.freeze({ kind: 'backend', backend, nodeId, backendNodeId, releaseHumanWait, detachAbort: () => signal.removeEventListener('abort', abort) }));
      if (signal.aborted) abort();
      return;
    }
    if (event.kind === 'diagnostic') {
      if (this.active) this.active.blockers.push(`${stringField(event.payload.code, 'agent.diagnostic')}: ${stringField(event.payload.message, 'Agent backend reported a diagnostic.')}`);
      this.project(this.nextNodeId('diagnostic'), 'diagnostic', 'failed', provenance, Object.freeze({
        code: stringField(event.payload.code, 'agent.diagnostic'), message: stringField(event.payload.message, 'Agent backend reported a diagnostic.'), severity: 'error', retryable: event.payload.retryable === true,
      }));
      return;
    }
    if (event.kind === 'completed') {
      const status = terminalStatus(event.payload.status);
      await this.commitContext(event, status);
      const checkpoint = this.active?.budgetCheckpoint;
      if (checkpoint && this.active) {
        const active = this.active;
        const continued = await this.awaitBudgetContinuation(active.account.snapshot().budgetDecision, provenance, signal);
        active.budgetCheckpoint = null;
        if (continued) {
          assertBudgetAllowed(active.account.authorizeContinuation());
          active.wallTimeBudget.resetAfterContinuation();
          active.continuationRequested = true;
          active.continuationInstruction = `The previous turn stopped safely before ${checkpoint.toolId} because it reached a budget checkpoint. The user approved another bounded tranche. Re-inspect the authoritative project revision, do not repeat completed edits, retry the interrupted step, and continue the visible goal.`;
          active.decisions.push(`User approved budget continuation after ${checkpoint.toolId}.`);
          await this.options.operationLog.append({
            kind: 'agent/budget-continuation-authorized', severity: 'warning', source: asStableId('studio.conversation-host'), correlation: { sessionId: event.sessionId, turnId: event.turnId },
            payload: { taskId: active.account.options.taskId, budgetId: active.account.options.budget.id, limits: active.account.snapshot().budget.limits, safeBoundary: true },
          }).catch(() => undefined);
        } else {
          active.decisions.push('User stopped at the safe budget checkpoint; all completed project work was preserved.');
          active.toolFacts.push('Budget checkpoint: stopped by user after the active backend turn was safely released.');
        }
      }
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
        Object.freeze({ terminalStatus: status, summary: completionSummary(status, this.active?.toolFacts ?? [], this.active?.blockers ?? []) }));
    }
  }

  private async executeTool(backend: AgentBackend, event: AgentBackendEvent, signal: AbortSignal): Promise<void> {
    const toolCallId = stablePayloadId(event.payload.toolCallId, 'tool call');
    const toolId = stablePayloadId(event.payload.toolId, 'tool');
    const args = isRecord(event.payload.arguments) ? event.payload.arguments as JsonObject : Object.freeze({});
    const account = this.active?.account;
    if (!account) throw new Error('Task accounting is unavailable for this tool call.');
    const provenance = Object.freeze({ backendId: event.backendId, sessionId: event.sessionId, turnId: event.turnId, stepId: toolCallId });
    const toolNodeId = this.nextNodeId('tool-call');
    let stage: 'budget' | 'prepare' | 'approval' | 'execute' | 'submit-result' = 'budget';
    this.project(toolNodeId, 'tool-call', 'pending', provenance, Object.freeze({ toolCallId, toolId, argumentsSummary: toolArgumentSummary(toolId, args) }));
    try {
      if (this.active?.budgetCheckpoint) {
        const value = Object.freeze({ code: 'budget.turn-stopping', preserved: true, retryable: true, message: 'This turn is already stopping at a safe budget checkpoint. Retry in the user-approved continuation turn.' });
        this.project(toolNodeId, 'tool-call', 'cancelled', provenance, Object.freeze({ toolCallId, toolId, target: 'Current project', effect: 'observe', argumentsSummary: toolArgumentSummary(toolId, args) }));
        this.project(this.nextNodeId('tool-result'), 'tool-result', 'cancelled', provenance, Object.freeze({ toolCallId, toolId, resultStatus: 'cancelled', summary: '当前回合正在预算检查点安全结束；该并行工具将在续期回合重试。', details: boundedJson(value) }));
        await backend.submitToolResult(toolCallId, Object.freeze({ status: 'cancelled', value }), signal).catch(() => undefined);
        await this.options.runtime.turns.recordToolResult(event.turnId, toolCallId, Object.freeze({ status: 'cancelled', value }));
        return;
      }
      let preflight = account.preflightTool(toolCallId);
      if (!preflight.allowed && preflight.status === 'hard-exceeded') {
        const summary = toolArgumentSummary(toolId, args);
        const value = Object.freeze({
          code: 'budget.continuation-required', preserved: true, retryable: true,
          message: 'Studio reached a budget checkpoint before this tool. The live backend call was released to avoid expiring while the user is away; completed project changes remain committed. Stop this turn and wait for Studio to resume in a fresh turn after user confirmation.',
        });
        this.project(toolNodeId, 'tool-call', 'cancelled', provenance, Object.freeze({ toolCallId, toolId, target: 'Current project', effect: 'observe', argumentsSummary: summary }));
        this.project(this.nextNodeId('tool-result'), 'tool-result', 'cancelled', provenance,
          Object.freeze({ toolCallId, toolId, resultStatus: 'cancelled', summary: '已到达预算检查点；当前模型工具调用已安全释放，已完成修改均已保留。', details: boundedJson(value) }));
        if (this.active) {
          this.active.budgetCheckpoint = Object.freeze({ toolId, summary });
          this.active.decisions.push(`Budget checkpoint reached before ${toolId}; release the live backend tool call before waiting for the user.`);
          this.active.toolFacts.push(`${toolId}: deferred at a safe budget checkpoint; prior project changes preserved.`);
        }
        await backend.submitToolResult(toolCallId, Object.freeze({ status: 'cancelled', value }), signal);
        await this.options.runtime.turns.recordToolResult(event.turnId, toolCallId, Object.freeze({ status: 'cancelled', value }));
        await this.recordTaskAccounting(account, event.sessionId, event.turnId); this.changed();
        await this.options.runtime.turns.cancel(event.backendId, event.sessionId, event.turnId).catch(() => undefined);
        return;
      }
      if (preflight.status === 'soft-exceeded') this.project(this.nextNodeId('diagnostic'), 'diagnostic', 'completed', provenance, Object.freeze({ code: 'budget.soft-warning', message: preflight.warning ?? 'Soft task budget is exceeded; execution is continuing.', severity: 'warning', retryable: false }));
      assertBudgetAllowed(preflight);
      assertBudgetAllowed(account.commitTool(toolCallId));
      stage = 'prepare';
      if (toolId === PLAN_TOOL_ID) {
        const result = await this.awaitPlan(toolCallId, event.sessionId, event.turnId, args, provenance, signal);
        this.project(toolNodeId, 'tool-call', 'completed', provenance, Object.freeze({ toolCallId, toolId, target: 'Current project', effect: 'observe', argumentsSummary: '总体实现方案已由用户审阅。' }));
        this.project(this.nextNodeId('tool-result'), 'tool-result', 'completed', provenance,
          Object.freeze({ toolCallId, toolId, resultStatus: 'completed', summary: result.approvedForExecution === true ? '方案已确认，开始执行。' : '用户补充了信息，需要更新方案。' }));
        await backend.submitToolResult(toolCallId, Object.freeze({ status: 'completed', value: result }), signal);
        await this.options.runtime.turns.recordToolResult(event.turnId, toolCallId, Object.freeze({ status: 'completed', value: result })); await this.recordTaskAccounting(account, event.sessionId, event.turnId); this.changed();
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
      const resultSummary = toolResultSummary(toolId, result.status, result.value, preparation.preview.summary);
      if (this.active) this.active.toolFacts.push(`${toolId}: ${resultSummary} [${result.status}; r${result.beforeRevision}→r${result.afterRevision}${result.historyLabel ? `; History: ${result.historyLabel}` : ''}]`);
      this.project(this.nextNodeId('tool-result'), 'tool-result', result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed', provenance,
        Object.freeze({ toolCallId, toolId, resultStatus: result.status, summary: resultSummary, details: boundedJson(result.value) }));
      stage = 'submit-result';
      await backend.submitToolResult(toolCallId, Object.freeze({ status: result.status, value: result.value, documentId: result.documentId, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision }), signal);
      await this.options.runtime.turns.recordToolResult(event.turnId, toolCallId, Object.freeze({ status: result.status, value: result.value, documentId: result.documentId, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision })); await this.recordTaskAccounting(account, event.sessionId, event.turnId); this.changed();
    } catch (cause) {
      const diagnostic = Object.freeze({ code: errorCode(cause), message: errorMessage(cause) });
      if (this.active) this.active.blockers.push(`${toolId}: ${diagnostic.code}`);
      await this.options.operationLog.append({
        kind: 'conversation/tool-failed', severity: signal.aborted ? 'warning' : 'error', source: asStableId('studio.conversation-host'),
        correlation: { sessionId: event.sessionId, turnId: event.turnId, toolCallId },
        payload: { toolId, stage, argumentKeys: Object.freeze(Object.keys(args).sort()), code: diagnostic.code, message: diagnostic.message },
      }).catch(() => undefined);
      this.project(this.nextNodeId('tool-result'), 'tool-result', signal.aborted ? 'cancelled' : 'failed', provenance,
        Object.freeze({ toolCallId, toolId, resultStatus: signal.aborted ? 'cancelled' : 'failed', summary: diagnostic.message }));
      await backend.submitToolResult(toolCallId, Object.freeze({ status: 'failed', error: diagnostic }), signal).catch(() => undefined);
      await this.options.runtime.turns.recordToolResult(event.turnId, toolCallId, Object.freeze({ status: 'failed', error: diagnostic })); await this.recordTaskAccounting(account, event.sessionId, event.turnId); this.changed();
    }
  }

  private awaitBudgetContinuation(decision: BudgetDecision, provenance: ConversationNodeReadModel['provenance'], signal: AbortSignal): Promise<boolean> {
    const nodeId = this.nextNodeId('budget-question');
    const continueOptionId = asStableId(`option:budget-continue:${this.nodeSequence}`);
    const stopOptionId = asStableId(`option:budget-stop:${this.nodeSequence}`);
    const violations = decision.violations.length
      ? decision.violations.map((item) => `${budgetMetricLabel(item.metric)} ${item.projected}/${item.limit}`).join('，')
      : '任务预算已达到当前上限';
    this.project(nodeId, 'question', 'pending', provenance, Object.freeze({
      prompt: `当前任务已达到预算检查点（${violations}）。继续将增加一个与初始任务相同的预算额度，并从当前步骤继续；停止不会回滚已经完成的场景、资源或脚本修改，当前脚本提案也会保留。`,
      options: Object.freeze([
        Object.freeze({ id: continueOptionId, label: '继续处理', description: '批准一个有界的额外预算额度，并从当前工具调用继续。' }),
        Object.freeze({ id: stopOptionId, label: '停止并保留结果', description: '结束当前任务，保留所有已完成修改和当前提案。' }),
      ]),
      allowFreeform: false,
      multiple: false,
    }));
    const active = this.active;
    const releaseHumanWait = active?.sessionId && active.turnId ? this.pauseForHumanInteraction(active.sessionId, active.turnId) : () => {};
    void this.options.operationLog.append({
      kind: 'agent/budget-continuation-requested', severity: 'warning', source: asStableId('studio.conversation-host'), correlation: { sessionId: provenance.sessionId, turnId: provenance.turnId, ...(provenance.stepId ? { toolCallId: provenance.stepId } : {}) },
      payload: { taskId: active?.taskId ?? null, violations: decision.violations.map((item) => ({ metric: item.metric, current: item.current, projected: item.projected, limit: item.limit })) },
    }).catch(() => undefined);
    return new Promise<boolean>((resolve, reject) => {
      const abort = (): void => {
        this.questions.delete(nodeId); releaseHumanWait(); this.finishNode(nodeId, 'cancelled'); reject(signal.reason ?? new Error('Budget continuation cancelled.'));
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.questions.set(nodeId, Object.freeze({
        kind: 'budget', nodeId, continueOptionId, stopOptionId, releaseHumanWait,
        detachAbort: () => signal.removeEventListener('abort', abort), resolve, reject,
      }));
    });
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
    const releaseHumanWait = this.pauseForHumanInteraction(sessionId, turnId);
    return new Promise<JsonObject>((resolve, reject) => {
      const abort = (): void => {
        this.plans.delete(nodeId); releaseHumanWait();
        const current = this.nodes.get(nodeId);
        if (current && current.status === 'pending') this.project(nodeId, 'plan', 'cancelled', current.provenance, Object.freeze({ ...current.content, decision: 'cancelled' }));
        reject(signal.reason ?? new Error('Plan review cancelled.'));
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.plans.set(nodeId, Object.freeze({
        nodeId, toolCallId, sessionId, turnId, title: proposal.title, summary: proposal.summary, items,
        resolve: (result: JsonObject) => { signal.removeEventListener('abort', abort); releaseHumanWait(); resolve(result); },
        reject: (cause: unknown) => { signal.removeEventListener('abort', abort); releaseHumanWait(); reject(cause); },
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
      this.active.decisions.push(`Approved plan: ${pending.title}. ${pending.summary}`);
    } else if (this.active?.sessionId === pending.sessionId && this.active.turnId === pending.turnId) {
      this.active.decisions.push(`Plan revision requested: ${pending.title}.${note?.trim() ? ` User note: ${note.trim().slice(0, 512)}` : ''}`);
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
    const releaseHumanWait = this.pauseForHumanInteraction(preparation.sessionId, preparation.turnId);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const abort = (): void => {
        if (settled) return;
        settled = true; releaseHumanWait(); this.approvals.delete(approval.approvalId);
        void this.options.tools.decide(approval.approvalId, 'cancel').catch(() => undefined);
        const current = this.nodes.get(nodeId);
        if (current && current.status === 'pending') this.project(nodeId, 'approval', 'cancelled', current.provenance, Object.freeze({ ...current.content, decision: 'cancel' }));
        reject(signal.reason ?? new Error('Approval cancelled.'));
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.approvals.set(approval.approvalId, Object.freeze({
        preparation, approval, nodeId,
        resolve: () => { if (settled) return; settled = true; releaseHumanWait(); signal.removeEventListener('abort', abort); resolve(); },
        reject: (cause: unknown) => { if (settled) return; settled = true; releaseHumanWait(); signal.removeEventListener('abort', abort); reject(cause); },
      }));
    });
  }

  private pauseForHumanInteraction(sessionId: StableId, turnId: StableId): () => void {
    const active = this.active;
    if (!active || active.sessionId !== sessionId || active.turnId !== turnId) return () => {};
    active.wallTimeBudget.pause();
    const ledger = this.options.runtime.usage?.get(turnId);
    ledger?.pauseWallTime(Date.now());
    let released = false;
    return () => {
      if (released) return; released = true;
      ledger?.resumeWallTime(Date.now());
      active.wallTimeBudget.resume();
    };
  }

  private async resolveApproval(approvalId: StableId, decision: 'allow-once' | 'allow-always' | 'reject'): Promise<void> {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error('Approval is stale or already resolved.');
    try {
      const resolved = await this.options.tools.decide(approvalId, decision);
      const current = this.nodes.get(pending.nodeId)!;
      this.project(pending.nodeId, 'approval', 'completed', current.provenance, approvalContent(pending.preparation, resolved));
      pending.resolve();
    } catch (cause) {
      const current = this.nodes.get(pending.nodeId);
      const resolved = this.options.tools.approval(approvalId) ?? pending.approval;
      if (current) this.project(pending.nodeId, 'approval', resolved.decision === 'expired' || resolved.decision === 'cancel' ? 'cancelled' : 'failed', current.provenance, approvalContent(pending.preparation, resolved));
      pending.reject(cause);
      throw cause;
    } finally { this.approvals.delete(approvalId); }
  }

  private async refreshBackends(): Promise<void> {
    const values: ConversationBackendReadModel[] = [];
    for (const descriptor of this.options.runtime.registry.descriptors()) {
      const backend = this.options.runtime.registry.get(descriptor.id);
      try {
        const status = await backend.status();
        let catalog: Awaited<ReturnType<AgentBackend['modelCatalog']>>;
        try { catalog = await backend.modelCatalog(); }
        catch (cause) {
          if (status.state !== 'auth-required') throw cause;
          values.push(Object.freeze({ id: descriptor.id, label: descriptor.kind === 'harness-api-key' ? 'DeepSeek Harness' : 'Local Codex', kind: descriptor.kind, ...status, models: Object.freeze([]), selectedModel: null, selectedReasoningEffort: null, outputTokenLimit: null, diagnostic: Object.freeze({ code: errorCode(cause), message: errorMessage(cause) }) }));
          continue;
        }
        const previous = this.backendSelections.get(descriptor.id);
        const selectedModel = catalog.models.find((item) => item.id === previous?.model) ?? catalog.models.find((item) => item.isDefault) ?? catalog.models[0];
        const selectedReasoningEffort = previous?.reasoningEffort && selectedModel?.reasoningEfforts.includes(previous.reasoningEffort) ? previous.reasoningEffort : selectedModel?.defaultReasoningEffort ?? null;
        const outputTokenLimit = selectedModel ? Math.min(previous?.outputTokenLimit ?? selectedModel.maxOutputTokens, selectedModel.maxOutputTokens) : null;
        if (selectedModel && selectedReasoningEffort && outputTokenLimit) this.backendSelections.set(descriptor.id, Object.freeze({ model: selectedModel.id, reasoningEffort: selectedReasoningEffort, outputTokenLimit }));
        values.push(Object.freeze({ id: descriptor.id, label: descriptor.kind === 'harness-api-key' ? 'DeepSeek Harness' : 'Local Codex', kind: descriptor.kind, ...status,
          models: catalog.models.map((item) => Object.freeze({ id: item.id, label: item.label, reasoningEfforts: item.reasoningEfforts, defaultReasoningEffort: item.defaultReasoningEffort, maxOutputTokens: item.maxOutputTokens, isDefault: item.isDefault })), selectedModel: selectedModel?.id ?? null, selectedReasoningEffort, outputTokenLimit }));
      } catch (cause) {
        values.push(Object.freeze({ id: descriptor.id, label: descriptor.kind, kind: descriptor.kind, state: 'error', authMode: descriptor.kind === 'harness-api-key' ? 'api-key' : 'chatgpt', rateLimits: Object.freeze([]), diagnostic: Object.freeze({ code: errorCode(cause), message: errorMessage(cause) }), models: Object.freeze([]), selectedModel: null, selectedReasoningEffort: null, outputTokenLimit: null }));
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
    this.persistProjection(node);
    this.changed();
  }

  private persistProjection(node: ConversationNodeReadModel): void {
    if (!this.projectionPersistenceAvailable()) return;
    const write = async (): Promise<void> => {
      const artifact = await this.options.operationLog.putArtifact(node as unknown as JsonObject, { schemaVersion: 'conversation-node/1', backendId: node.provenance.backendId });
      await this.options.operationLog.append({
        kind: 'conversation/node-projected', severity: node.status === 'failed' ? 'error' : node.status === 'cancelled' ? 'warning' : 'info', source: asStableId('studio.conversation-host'),
        correlation: {
          sessionId: node.provenance.sessionId, turnId: node.provenance.turnId, stepId: node.provenance.stepId,
          ...(typeof node.content.toolCallId === 'string' ? { toolCallId: asStableId(node.content.toolCallId) } : {}),
          ...(typeof node.content.approvalId === 'string' ? { approvalId: asStableId(node.content.approvalId) } : {}),
        },
        payload: { nodeId: node.id, nodeKind: node.kind, nodeStatus: node.status, artifactId: artifact.id, artifactDigest: artifact.digest },
        artifactRefs: [artifact.id],
      });
    };
    this.projectionWriteTail = this.projectionWriteTail.then(write, write).catch((cause) => { this.projectionPersistenceFailure ??= cause; });
  }

  private async restoreProjection(): Promise<void> {
    if (!this.projectionPersistenceAvailable()) return;
    const status = this.options.operationLog.status();
    const afterSequence = status.nextSequence > 5_000 ? status.nextSequence - 5_001 : undefined;
    let cursor: string | undefined;
    const restored: ConversationNodeReadModel[] = [];
    do {
      const page = await this.options.operationLog.query({ kinds: ['conversation/node-projected'], limit: 200, traverseCorrelation: false, ...(afterSequence === undefined ? {} : { afterSequence }), ...(cursor ? { cursor } : {}) });
      for (const event of page.events) {
        const artifactId = event.artifactRefs[0]; if (!artifactId) continue;
        try { restored.push(normalizeConversationNode((await this.options.operationLog.readArtifact(artifactId)).value)); }
        catch { /* A missing/corrupt artifact is already surfaced by Operation Log health and stays hidden from the renderer. */ }
      }
      cursor = page.nextCursor;
    } while (cursor && restored.length < 2_000);
    for (const node of restored.slice(-2_000)) {
      this.nodes.set(node.id, node);
      this.eventSequence += 1;
      this.events.push(Object.freeze({ schemaVersion: 1, sequence: this.eventSequence, source: 'replay', node }));
      const suffix = /:(\d+)$/u.exec(node.id)?.[1]; if (suffix) this.nodeSequence = Math.max(this.nodeSequence, Number(suffix));
    }
    for (const node of [...this.nodes.values()]) {
      if (node.status !== 'pending' && node.status !== 'streaming') continue;
      const content = node.kind === 'approval' ? Object.freeze({ ...node.content, decision: 'stale' }) : node.content;
      this.project(node.id, node.kind, 'cancelled', node.provenance, content);
    }
    if (restored.length) this.stateRevision += 1;
  }

  private projectionPersistenceAvailable(): boolean {
    const value = this.options.operationLog as unknown as Record<string, unknown>;
    return typeof value.putArtifact === 'function' && typeof value.query === 'function' && typeof value.readArtifact === 'function' && typeof value.status === 'function';
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

  private turnConfig(backendId: StableId, taskId: StableId, promptProfile: PromptProfileSnapshot = this.options.runtime.context.prompts.profile): AgentTurnConfigV2 {
    const selection = this.backendSelections.get(backendId); if (!selection) throw new Error('The selected backend has no usable model configuration.');
    return Object.freeze({ schemaVersion: 2, backendId, model: selection.model, reasoningEffort: selection.reasoningEffort, outputTokenLimit: selection.outputTokenLimit,
      taskBudgetId: asStableId(`budget:${taskId}`), promptProfile: Object.freeze({ id: promptProfile.id, version: promptProfile.version, digest: promptProfile.digest }),
      requestedCapabilities: Object.freeze(['agent.model-config', 'agent.usage', 'agent.cache', 'agent.context'] as const) });
  }

  private taskAccountingReadModel(): import('@haiyue/ai-studio-shell').ConversationTaskAccountingReadModel | null {
    if (!this.latestTaskId) return null; const snapshot = this.options.runtime.accounting.get(this.latestTaskId)?.reconcile(); if (!snapshot) return null;
    return Object.freeze({ taskId: snapshot.taskId, budget: snapshot.budget, budgetStatus: snapshot.budgetDecision.status, usage: snapshot.usage, cost: snapshot.cost });
  }

  private async recordTaskAccounting(account: TaskAccount, sessionId: StableId, turnId: StableId): Promise<void> {
    const snapshot = account.reconcile();
    await this.options.operationLog.append({ kind: 'agent/task-accounting', severity: snapshot.budgetDecision.status === 'hard-exceeded' ? 'error' : snapshot.budgetDecision.status === 'soft-exceeded' ? 'warning' : 'info', source: asStableId('studio.conversation-host'), correlation: { sessionId, turnId }, payload: {
      taskId: snapshot.taskId, budgetId: snapshot.budget.id, budgetStatus: snapshot.budgetDecision.status, costRecordIds: snapshot.cost.recordIds, pricingCatalogId: snapshot.cost.pricingCatalogId, pricingCatalogVersion: snapshot.cost.pricingCatalogVersion, pricingEffectiveAt: snapshot.cost.effectiveAt, costStatus: snapshot.cost.status, amountMicros: snapshot.cost.amountMicros, currency: snapshot.cost.currency, cacheSavingMicros: snapshot.cost.cacheSavingMicros, costFinal: snapshot.cost.final,
      inputTokens: snapshot.usage.inputTokens, cachedInputTokens: snapshot.usage.cachedInputTokens, outputTokens: snapshot.usage.outputTokens, reasoningTokens: snapshot.usage.reasoningTokens, toolInputBytes: snapshot.usage.toolInputBytes, toolOutputBytes: snapshot.usage.toolOutputBytes, ...(snapshot.usage.contextCache ? { contextCache: snapshot.usage.contextCache } : {}),
    } }).catch(() => undefined);
  }

  private modelTools(): readonly Readonly<{ id: StableId; description: string; inputSchema: JsonObject }>[] {
    return Object.freeze([PLAN_TOOL_DEFINITION, ...this.options.tools.definitions()].map((definition) => Object.freeze({
      id: definition.id,
      description: `${definition.description} Effect: ${definition.effect}. Risk: ${definition.risk}.${definition.id === 'project.snapshot' ? ' Inspect this before planning or using a document revision.' : ''}`,
      inputSchema: definition.inputSchema,
    })));
  }

  private async commitContext(event: AgentBackendEvent, status: 'completed' | 'cancelled' | 'failed' | 'interrupted'): Promise<void> {
    const active = this.active;
    if (!active || active.contextCommitted || active.sessionId !== event.sessionId || active.turnId !== event.turnId) return;
    active.contextCommitted = true;
    await this.options.runtime.context.commit({
      conversationKey: active.conversationKey, backendId: active.backendId, taskId: active.taskId, sessionId: event.sessionId, turnId: event.turnId,
      projectId: active.projectId, goals: [active.goal], decisions: active.decisions, toolFacts: active.toolFacts,
      blockers: status === 'completed' ? active.blockers : [...active.blockers, `Turn ended with ${status}.`],
    });
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
    previewDigest: presentationDigest(approval.previewDigest), ...(approval.expiresAt ? { expiresAt: approval.expiresAt } : {}),
    scope: approval.decision === 'allow-always' ? 'project-session' : 'operation', decision: approval.decision,
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
function completionSummary(status: 'completed' | 'cancelled' | 'failed' | 'interrupted', toolFacts: readonly string[], blockers: readonly string[]): string {
  const completed = toolFacts.length ? `Completed: ${toolFacts.join(' | ')}` : 'Completed: no Studio tool changes.';
  const incomplete = blockers.length ? ` Incomplete or blocked: ${blockers.join(' | ')}` : ' Incomplete or blocked: none.';
  return `${status}. ${completed}${incomplete}`.slice(0, 4_096);
}
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
    const proposal = typeof raw.proposalId === 'string' ? ` ${raw.proposalId}` : '';
    return errors > 0 ? `脚本提案${proposal}有 ${errors} 个错误，提案已保留，需要修改后重新校验。` : `脚本提案${proposal}校验通过并已保留 · +${numberField(raw.addedLines)}/-${numberField(raw.removedLines)} 行`;
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
function budgetMetricLabel(metric: BudgetDecision['violations'][number]['metric']): string {
  return ({ inputTokens: '输入 token', outputTokens: '输出 token', estimatedCostMicros: '预计成本', wallTimeMs: '执行时间', turns: '回合数', toolCalls: '工具调用数', repairIterations: '修复次数', observationBytes: '工具结果字节数' } as const)[metric];
}
function approvedPlanRequest(plan: ApprovedPlanExecution, projectOpen: boolean): string {
  return [
    projectOpen ? 'Execute the already approved plan against the current project.' : 'The project closed after approval; report that execution cannot continue.',
    canonicalPlan(plan),
    'Do not request the same plan approval again. Re-inspect the current revision, execute accepted reversible steps, and report any scoped approval or capability that still blocks execution.',
  ].join('\n\n');
}
function budgetContinuationRequest(goal: string, projectOpen: boolean): string {
  return [
    projectOpen ? 'Continue the visible task against the current project after a user-approved budget checkpoint.' : 'The project closed while waiting at a budget checkpoint; report that the task cannot safely continue.',
    `Visible goal: ${goal.slice(0, 2_048)}`,
    'Inspect authoritative project state before acting. Preserve and reuse completed work, do not recreate working scene content, and retry only the interrupted step. If project mutations are not covered by an already approved plan, propose a plan before editing.',
  ].join('\n\n');
}
function canonicalPlan(plan: ApprovedPlanExecution): string {
  return JSON.stringify({ title: plan.title, summary: plan.summary, items: plan.items.map((item) => ({ label: item.label, ...(item.details ? { details: item.details } : {}) })), ...(plan.note ? { userNote: plan.note } : {}) });
}
function conversationKeyFor(project: ContextProjectSnapshot | null): StableId { return project ? asStableId(`conversation:${project.projectId}`) : asStableId('conversation:workspace-empty'); }
const DEFAULT_TASK_BUDGET: TaskBudgetV2 = Object.freeze({ schemaVersion: 2, id: asStableId('budget:conversation-default'), enforcement: 'hard', limits: Object.freeze({
  inputTokens: 200_000, outputTokens: 50_000, estimatedCostMicros: 2_000_000, wallTimeMs: 10 * 60_000, turns: 12, toolCalls: 100, repairIterations: 5, observationBytes: 5_000_000,
}) });
function assertBudgetAllowed(decision: Readonly<{ allowed: boolean; warning: string | null }>): void { if (!decision.allowed) throw new BudgetStopError(decision.warning ?? 'Task budget is exhausted.'); }
class BudgetStopError extends Error { readonly code = 'budget.hard-stop'; constructor(message: string) { super(message); this.name = 'BudgetStopError'; } }
interface WallTimeBudget { pause(): void; resume(): void; resetAfterContinuation(): void; dispose(): void; }
function armWallTimeBudget(controller: AbortController, account: TaskAccount): WallTimeBudget {
  if (account.options.budget.enforcement !== 'hard') return Object.freeze({ pause() {}, resume() {}, resetAfterContinuation() {}, dispose() {} });
  let remaining = (account.snapshot().budget.limits.wallTimeMs ?? Number.MAX_SAFE_INTEGER) - account.snapshot().consumption.wallTimeMs;
  let armedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pauseDepth = 0;
  let disposed = false;
  const expire = (): void => {
    timer = null; remaining = 0;
    account.expireWallTime();
  };
  const arm = (): void => {
    if (disposed || pauseDepth > 0 || controller.signal.aborted) return;
    if (remaining <= 0) { expire(); return; }
    armedAt = Date.now(); timer = setTimeout(expire, remaining);
  };
  arm();
  return Object.freeze({
    pause(): void {
      if (disposed) return;
      pauseDepth += 1;
      if (pauseDepth !== 1 || timer === null) return;
      clearTimeout(timer); timer = null;
      remaining = Math.max(0, remaining - (Date.now() - armedAt));
    },
    resume(): void {
      if (disposed || pauseDepth === 0) return;
      pauseDepth -= 1;
      if (pauseDepth === 0) arm();
    },
    resetAfterContinuation(): void {
      if (disposed) return;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      const snapshot = account.snapshot();
      remaining = Math.max(1, (snapshot.budget.limits.wallTimeMs ?? Number.MAX_SAFE_INTEGER) - snapshot.consumption.wallTimeMs);
      if (pauseDepth === 0) arm();
    },
    dispose(): void { if (disposed) return; disposed = true; if (timer !== null) clearTimeout(timer); timer = null; },
  });
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
