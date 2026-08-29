import { asStableId, type AgentTurnConfigV2, type EvaluationResultV2, type JsonObject, type JsonValue, type M12ReasoningEffort, type ObservationArtifactV2, type StableId, type TaskBudgetV2, type TaskSpecV2 } from '@haiyue/ai-studio-contracts';
import { M12_DEFAULT_PRICING_CATALOG, type AgentBackend, type AgentBackendEvent, type AgentLoginHandoff, type AgentRuntimeService, type BudgetDecision, type ContextProjectSnapshot, type PromptProfileSnapshot, type TaskAccount } from '@haiyue/ai-studio-agent-runtime';
import { BoundedPlaytestTask, PlaytestLoopError, type GameAuthoringToolService, type GameToolApproval, type GameToolPreparation } from '@haiyue/ai-studio-game-authoring-tools';
import { sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import {
  normalizeConversationNode,
  normalizeTaskRun,
  validateConversationIntent,
  type ConversationBackendReadModel,
  type ConversationIntent,
  type ConversationNodeReadModel,
  type ConversationProjectionEvent,
  type ConversationReplaySnapshot,
  type ConversationTaskAcceptanceReadModel,
  type ConversationTaskEvidenceReadModel,
  type ConversationTaskPhase,
  type ConversationTaskRunReadModel,
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
  readonly acceptance: readonly PlanAcceptanceProposal[];
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
interface PlanAcceptanceProposal { readonly label: string; readonly required: boolean; readonly category: TaskSpecV2['acceptance'][number]['category']; readonly assertion: string; }

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
  private readonly taskRuns = new Map<StableId, ConversationTaskRunReadModel>();
  private readonly playtestTasks = new Map<StableId, BoundedPlaytestTask>();
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

  async initialize(): Promise<void> { await this.restoreProjection(); await this.restoreTaskRuns(); await this.hydrateTaskPreviews(); await this.refreshBackends(); }

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
      taskRuns: Object.freeze([...this.taskRuns.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)).slice(-50)),
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
          if (this.active) this.updateTaskRun(this.active.taskId, { status: 'running', resumable: false, terminalDiagnostic: null }, { phase: this.taskRuns.get(this.active.taskId)?.phase ?? 'planning', status: 'complete', title: pending.kind === 'budget' ? '预算选择已确认' : '补充信息已提交', detail: pending.kind === 'budget' ? (Array.isArray(intent.answer.optionIds) && intent.answer.optionIds[0] === pending.continueOptionId ? '用户批准继续一个有界预算分段。' : '用户停止并保留已完成产物。') : 'Agent 可以继续处理。' });
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
    if (active) this.updateTaskRun(active.taskId, { status: 'cancelled', phase: 'cancelled', terminalDiagnostic: reason, resumable: false }, { phase: 'cancelled', status: 'warning', title: '任务已取消', detail: reason, turnId: active.turnId });
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
    const now = new Date().toISOString();
    const taskRun: ConversationTaskRunReadModel = Object.freeze({
      schemaVersion: 1, revision: 0, taskId, title: taskTitle(prompt), requestSummary: prompt.slice(0, 2_048), status: 'running', phase: 'planning', startedAt: now, updatedAt: now,
      backendId, sessionId: null, turnId: null, model: Object.freeze({ id: config.model, reasoningEffort: config.reasoningEffort, outputTokenLimit: config.outputTokenLimit }),
      promptProfile: Object.freeze({ id: asStableId(config.promptProfile.id), version: config.promptProfile.version, digest: config.promptProfile.digest }), documentRevision: project?.revision ?? null, repairIteration: 0, repairLimit: budget.limits.repairIterations,
      acceptance: Object.freeze([]), evidence: Object.freeze([]), timeline: Object.freeze([taskTimeline('planning', 'active', '任务已开始', '正在读取项目上下文并形成可审阅的方案。')]), terminalDiagnostic: null, resumable: false,
    });
    this.taskRuns.set(taskId, taskRun); this.persistTaskRun(taskRun);
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
    const playtest = this.playtestTasks.get(taskId);
    if (playtest?.snapshot().phase === 'repairing') playtest.advance('editing');
    this.updateTaskRun(taskId, { status: 'running', phase: playtest?.snapshot().phase ?? (plan ? 'editing' : 'planning'), terminalDiagnostic: null, resumable: false }, { phase: playtest?.snapshot().phase ?? 'editing', status: 'active', title: plan ? '继续执行已批准方案' : '继续预算分段', detail: continuationInstruction ?? '从权威项目状态恢复。' });
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
    const priorTaskId = this.options.runtime.usage.get(turnId)?.snapshot().taskId ?? [...this.taskRuns.values()].find((item) => item.sessionId === sessionId && item.turnId === turnId)?.taskId;
    const taskId = priorTaskId ?? asStableId(`task:resume:${this.nodeSequence + 1}`); const config = this.turnConfig(backendId, taskId);
    const existingAccount = this.options.runtime.accounting.get(taskId);
    const budget = Object.freeze({ ...this.budgetTemplate, id: config.taskBudgetId, limits: Object.freeze({ ...this.budgetTemplate.limits }) });
    const account = existingAccount ?? this.options.runtime.accounting.open({ taskId, budget, pricingCatalog: M12_DEFAULT_PRICING_CATALOG });
    const resumeDecision = existingAccount ? account.snapshot().budgetDecision : account.beginTurn();
    const wallTimeBudget = armWallTimeBudget(controller, account);
    this.latestTaskId = taskId;
    this.updateTaskRun(taskId, { status: 'running', phase: this.playtestTasks.get(taskId)?.snapshot().phase ?? 'editing', terminalDiagnostic: null, resumable: false }, { phase: this.playtestTasks.get(taskId)?.snapshot().phase ?? 'editing', status: 'active', title: '正在恢复任务', detail: '从持久化安全检查点恢复 backend turn。', turnId });
    const project = this.options.projectContext?.() ?? null;
    const restoredRun = this.taskRuns.get(taskId);
    const restoredPlan: ApprovedPlanExecution | null = restoredRun?.acceptance.length ? { title: restoredRun.title, summary: 'Restored user-approved plan and acceptance criteria.', items: Object.freeze([]), attempts: 1, mutationCount: 1 } : null;
    if (restoredPlan) this.approvedPlanTurns.add(turnKey(sessionId, turnId));
    this.active = { backendId, taskId, config, account, sessionId, turnId, controller, wallTimeBudget, initialProgressNodeId, localSessionId: sessionId, localTurnId: turnId, approvedPlan: restoredPlan, continuationRequested: false, continuationInstruction: null, budgetCheckpoint: null, conversationKey: conversationKeyFor(project), projectId: project?.projectId ?? null, goal: restoredRun?.requestSummary ?? 'Retry the interrupted visible task.', decisions: [], toolFacts: [], blockers: [], contextCommitted: false };
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
        this.updateTaskRun(this.active.taskId, { sessionId: event.sessionId, turnId: event.turnId });
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
      if (this.active) this.updateTaskRun(this.active.taskId, { status: 'waiting-user', resumable: true }, { phase: this.taskRuns.get(this.active.taskId)?.phase ?? 'planning', status: 'warning', title: '等待用户补充', detail: 'Agent 需要澄清后才能继续。', turnId: event.turnId });
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
      if (this.active?.continuationRequested) return;
      const taskRun = this.active ? this.taskRuns.get(this.active.taskId) : null;
      if (status === 'cancelled' && this.active) this.updateTaskRun(this.active.taskId, { status: 'cancelled', phase: 'cancelled', terminalDiagnostic: 'task.cancelled', resumable: true }, { phase: 'cancelled', status: 'warning', title: '任务已取消', detail: '已完成产物和现有证据均已保留。', turnId: event.turnId });
      else if (status !== 'completed' && this.active) this.updateTaskRun(this.active.taskId, { status: 'failed', phase: 'blocked', terminalDiagnostic: `turn.${status}`, resumable: status === 'interrupted' }, { phase: 'blocked', status: 'error', title: '任务执行中断', detail: `Backend turn ended with ${status}.`, turnId: event.turnId });
      else if (status === 'completed' && taskRun?.status !== 'completed' && this.active) {
        const diagnostic = taskRun?.acceptance.length ? 'task.acceptance-evidence-incomplete' : 'task.acceptance-criteria-missing';
        this.updateTaskRun(this.active.taskId, { status: 'blocked', phase: 'blocked', terminalDiagnostic: diagnostic, resumable: true }, { phase: 'blocked', status: 'error', title: '不能标记任务完成', detail: taskRun?.acceptance.length ? 'Agent 回合已经结束，但必需验收项没有全部通过并引用持久化证据。' : 'Agent 回合已经结束，但没有经过用户批准的可验证验收标准。', turnId: event.turnId });
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
    let args = isRecord(event.payload.arguments) ? event.payload.arguments as JsonObject : Object.freeze({});
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
      if (toolId === 'task.evaluate') {
        const task = this.active ? this.playtestTasks.get(this.active.taskId)?.task : null;
        if (!task) throw new PlaytestLoopError('task.acceptance-unapproved', 'Task evaluation requires user-approved acceptance criteria.');
        args = Object.freeze({ ...args, taskSpec: task }) as unknown as JsonObject;
      }
      if (this.active) this.beforeProductTool(this.active.taskId, toolId, args, event.turnId, toolCallId);
      const preparation = await this.options.tools.prepare({ schemaVersion: 1, id: toolCallId, sessionId: event.sessionId, turnId: event.turnId, ...(this.active?.taskId ? { taskId: this.active.taskId } : {}), toolId, toolVersion: '1.0.0', arguments: args }, signal);
      this.project(toolNodeId, 'tool-call', 'completed', provenance, Object.freeze({
        toolCallId, toolId, target: preparation.preview.target, effect: preparation.effect, argumentsSummary: preparation.preview.summary,
      }));
      stage = 'approval';
      if (preparation.approvalId) await this.awaitApproval(preparation, provenance, signal);
      stage = 'execute';
      const result = await this.options.tools.execute(preparation.id, signal);
      if (this.active) await this.captureProductToolResult(this.active.taskId, toolId, result.value, event.turnId, toolCallId);
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
    if (active) this.updateTaskRun(active.taskId, { status: 'waiting-user', resumable: true, terminalDiagnostic: decision.warning }, { phase: this.taskRuns.get(active.taskId)?.phase ?? 'planning', status: 'warning', title: '预算检查点', detail: violations, turnId: provenance.turnId, toolCallId: provenance.stepId ?? null });
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
    if (this.active) {
      const acceptance = proposal.acceptance.map((item, index) => acceptanceReadModel(item, asStableId(`acceptance:${this.active!.taskId}:${index + 1}`)));
      this.updateTaskRun(this.active.taskId, { status: 'waiting-user', phase: 'planning', acceptance: Object.freeze(acceptance), resumable: true }, { phase: 'planning', status: 'warning', title: '等待方案与验收标准审批', detail: `${items.length} 个步骤，${acceptance.length} 项可验证标准。`, turnId, toolCallId });
    }
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
        nodeId, toolCallId, sessionId, turnId, title: proposal.title, summary: proposal.summary, items, acceptance: proposal.acceptance,
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
      if (pending.acceptance.length) {
        const taskSpec = taskSpecFromPlan(this.active, pending.acceptance);
        const playtest = new BoundedPlaytestTask(taskSpec, this.active.account.options.budget.limits.repairIterations);
        playtest.advance('editing'); this.playtestTasks.set(this.active.taskId, playtest);
      }
      this.updateTaskRun(this.active.taskId, { status: 'running', phase: 'editing', resumable: false, terminalDiagnostic: pending.acceptance.length ? null : 'acceptance.criteria-missing' }, { phase: 'editing', status: 'active', title: '方案已批准', detail: pending.acceptance.length ? `${pending.acceptance.length} 项验收标准已冻结，开始执行。` : '方案已批准，但尚未提供可执行验收标准。', turnId: pending.turnId, toolCallId: pending.toolCallId });
    } else if (this.active?.sessionId === pending.sessionId && this.active.turnId === pending.turnId) {
      this.active.decisions.push(`Plan revision requested: ${pending.title}.${note?.trim() ? ` User note: ${note.trim().slice(0, 512)}` : ''}`);
      this.updateTaskRun(this.active.taskId, { status: 'running', phase: 'planning', resumable: false }, { phase: 'planning', status: 'warning', title: '要求重新规划', detail: note?.trim() ?? '用户要求调整方案。', turnId: pending.turnId, toolCallId: pending.toolCallId });
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
    if (this.active) this.updateTaskRun(this.active.taskId, { status: 'waiting-user', resumable: true }, { phase: this.taskRuns.get(this.active.taskId)?.phase ?? 'editing', status: 'warning', title: '等待工具授权', detail: `${approval.toolId} · ${approval.effect} · ${approval.target}`, turnId: provenance.turnId, toolCallId: preparation.id });
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
      if (this.active) this.updateTaskRun(this.active.taskId, { status: 'running', resumable: false }, { phase: this.taskRuns.get(this.active.taskId)?.phase ?? 'editing', status: decision === 'reject' ? 'warning' : 'complete', title: decision === 'reject' ? '工具授权已拒绝' : '工具授权已确认', detail: `${resolved.toolId} · ${decision}`, turnId: current.provenance.turnId, toolCallId: pending.preparation.id });
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
      const product = Object.freeze({ protocolVersion: descriptor.protocolVersion, capabilities: Object.freeze({ ...descriptor.capabilities }), promptProfile: Object.freeze({ id: this.options.runtime.context.prompts.profile.id, version: this.options.runtime.context.prompts.profile.version, digest: this.options.runtime.context.prompts.profile.digest }) });
      try {
        const status = await backend.status();
        let catalog: Awaited<ReturnType<AgentBackend['modelCatalog']>>;
        try { catalog = await backend.modelCatalog(); }
        catch (cause) {
          if (status.state !== 'auth-required') throw cause;
          values.push(Object.freeze({ id: descriptor.id, label: descriptor.kind === 'harness-api-key' ? 'DeepSeek Harness' : 'Local Codex', kind: descriptor.kind, ...product, ...status, models: Object.freeze([]), selectedModel: null, selectedReasoningEffort: null, outputTokenLimit: null, diagnostic: Object.freeze({ code: errorCode(cause), message: errorMessage(cause) }) }));
          continue;
        }
        const previous = this.backendSelections.get(descriptor.id);
        const selectedModel = catalog.models.find((item) => item.id === previous?.model) ?? catalog.models.find((item) => item.isDefault) ?? catalog.models[0];
        const selectedReasoningEffort = previous?.reasoningEffort && selectedModel?.reasoningEfforts.includes(previous.reasoningEffort) ? previous.reasoningEffort : selectedModel?.defaultReasoningEffort ?? null;
        const outputTokenLimit = selectedModel ? Math.min(previous?.outputTokenLimit ?? selectedModel.maxOutputTokens, selectedModel.maxOutputTokens) : null;
        if (selectedModel && selectedReasoningEffort && outputTokenLimit) this.backendSelections.set(descriptor.id, Object.freeze({ model: selectedModel.id, reasoningEffort: selectedReasoningEffort, outputTokenLimit }));
        values.push(Object.freeze({ id: descriptor.id, label: descriptor.kind === 'harness-api-key' ? 'DeepSeek Harness' : 'Local Codex', kind: descriptor.kind, ...product, ...status,
          models: catalog.models.map((item) => Object.freeze({ id: item.id, label: item.label, reasoningEfforts: item.reasoningEfforts, defaultReasoningEffort: item.defaultReasoningEffort, maxOutputTokens: item.maxOutputTokens, isDefault: item.isDefault })), selectedModel: selectedModel?.id ?? null, selectedReasoningEffort, outputTokenLimit }));
      } catch (cause) {
        values.push(Object.freeze({ id: descriptor.id, label: descriptor.kind, kind: descriptor.kind, ...product, state: 'error', authMode: descriptor.kind === 'harness-api-key' ? 'api-key' : 'chatgpt', rateLimits: Object.freeze([]), diagnostic: Object.freeze({ code: errorCode(cause), message: errorMessage(cause) }), models: Object.freeze([]), selectedModel: null, selectedReasoningEffort: null, outputTokenLimit: null }));
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
    if (this.active) this.updateTaskRun(this.active.taskId, { status: this.active.controller.signal.aborted ? 'cancelled' : 'failed', phase: this.active.controller.signal.aborted ? 'cancelled' : 'blocked', terminalDiagnostic: errorCode(cause), resumable: !this.active.controller.signal.aborted }, { phase: this.active.controller.signal.aborted ? 'cancelled' : 'blocked', status: 'error', title: '任务执行失败', detail: errorMessage(cause), turnId: turn });
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

  private beforeProductTool(taskId: StableId, toolId: StableId, args: JsonObject, turnId: StableId, toolCallId: StableId): void {
    const target = productPhaseForTool(toolId);
    if (!target) return;
    const playtest = this.playtestTasks.get(taskId);
    if (playtest) advancePlaytest(playtest, target);
    this.updateTaskRun(taskId, { status: 'running', phase: playtest?.snapshot().phase ?? target, resumable: false }, {
      phase: playtest?.snapshot().phase ?? target, status: 'active', title: productToolTitle(toolId), detail: toolArgumentSummary(toolId, args), turnId, toolCallId,
    });
  }

  private async captureProductToolResult(taskId: StableId, toolId: StableId, value: JsonObject, turnId: StableId, toolCallId: StableId): Promise<void> {
    const artifacts = observationArtifacts(value);
    if (artifacts.length) {
      const additions: ConversationTaskEvidenceReadModel[] = [];
      for (const artifact of artifacts) {
        const evidence = await this.evidenceReadModel(artifact, taskId);
        if (evidence) additions.push(evidence);
      }
      if (additions.length) {
        const current = this.taskRuns.get(taskId); if (!current) return;
        const merged = new Map(current.evidence.map((item) => [item.id, item])); for (const item of additions) merged.set(item.id, item);
        const documentRevision = additions.at(-1)?.documentRevision ?? current.documentRevision;
        this.updateTaskRun(taskId, { evidence: Object.freeze([...merged.values()].slice(-256)), documentRevision }, {
          phase: current.phase, status: 'complete', title: `已采集 ${additions.length} 项验收证据`, detail: additions.map((item) => `${item.type}@tick ${item.tick}`).join(' · '), turnId, toolCallId,
          playId: additions.at(-1)?.playId ?? null, tick: additions.at(-1)?.tick ?? null,
        });
      }
    }
    if (toolId !== 'task.evaluate') return;
    const evaluation = evaluationResult(value, taskId);
    const playtest = this.playtestTasks.get(taskId); if (!playtest) throw new PlaytestLoopError('task.acceptance-unapproved', 'Task evaluation has no approved lifecycle owner.');
    advancePlaytest(playtest, 'evaluating');
    const evidence = this.taskRuns.get(taskId)?.evidence ?? Object.freeze([]);
    const acceptance: readonly ConversationTaskAcceptanceReadModel[] = playtest.task.acceptance.map((criterion) => {
      const result = evaluation.acceptanceResults.find((item) => item.acceptanceId === criterion.id);
      return Object.freeze({ id: asStableId(criterion.id), label: acceptanceLabel(criterion.assertion), assertion: criterion.assertion, category: criterion.category, required: criterion.required, visibility: criterion.visibility, status: result?.status ?? 'blocked', evidenceIds: Object.freeze(result?.evidenceIds.filter((id) => evidence.some((item) => item.id === id)).map((id) => asStableId(id)) ?? []), diagnostic: result?.diagnostic ?? 'evaluation.result-missing' });
    });
    const untrustedEvidence = evaluation.acceptanceResults.flatMap((item) => item.evidenceIds).filter((id) => !evidence.some((candidate) => candidate.id === id && candidate.provenanceStatus === 'current'));
    if (untrustedEvidence.length) {
      const diagnostic = 'task.evaluation-evidence-not-retained';
      playtest.block(diagnostic, Object.freeze(evidence.filter((item) => item.provenanceStatus === 'current').map((item) => item.id)));
      this.updateTaskRun(taskId, { status: 'blocked', phase: 'blocked', acceptance: Object.freeze(acceptance.map((item) => item.status === 'pass' ? Object.freeze({ ...item, status: 'blocked' as const, diagnostic }) : item)), terminalDiagnostic: diagnostic, resumable: true }, { phase: 'blocked', status: 'error', title: '验收证据不可采信', detail: `${untrustedEvidence.length} 个证据引用未保留、已过期或跨任务。`, turnId, toolCallId });
      return;
    }
    const snapshot = playtest.recordEvaluation(evaluation);
    if (snapshot.phase === 'complete') {
      this.updateTaskRun(taskId, { status: 'completed', phase: 'complete', acceptance: Object.freeze(acceptance), terminalDiagnostic: null, resumable: false }, { phase: 'complete', status: 'complete', title: '逐项验收通过', detail: `${acceptance.filter((item) => item.status === 'pass').length}/${acceptance.length} 项通过。`, turnId, toolCallId });
      return;
    }
    if (snapshot.phase === 'blocked') {
      this.updateTaskRun(taskId, { status: 'blocked', phase: 'blocked', acceptance: Object.freeze(acceptance), terminalDiagnostic: snapshot.diagnostic, resumable: false }, { phase: 'blocked', status: 'error', title: '验收被阻塞', detail: snapshot.diagnostic ?? '证据来源不兼容。', turnId, toolCallId });
      return;
    }
    const failedEvidence = evaluation.acceptanceResults.filter((item) => item.status === 'fail').flatMap((item) => item.evidenceIds).map((id) => asStableId(id));
    try {
      const account = this.active?.taskId === taskId ? this.active.account : null;
      if (account) assertBudgetAllowed(account.repair());
      const repair = playtest.beginRepair({ turnId, arguments: Object.freeze({ failedAcceptance: evaluation.acceptanceResults.filter((item) => item.status === 'fail').map((item) => item.acceptanceId) }) as JsonValue, evidenceIds: Object.freeze([...new Set(failedEvidence)]), usageRecordIds: Object.freeze(evaluation.usageRecordIds.map((id) => asStableId(id))), costRecordIds: Object.freeze(evaluation.costRecordIds.map((id) => asStableId(id))) });
      if (repair.phase === 'blocked') {
        this.updateTaskRun(taskId, { status: 'blocked', phase: 'blocked', acceptance: Object.freeze(acceptance), repairIteration: repair.attempts.length, terminalDiagnostic: repair.diagnostic, resumable: false }, { phase: 'blocked', status: 'error', title: '修复循环已停止', detail: repair.diagnostic ?? '修复预算已耗尽。', turnId, toolCallId });
      } else {
        this.updateTaskRun(taskId, { status: 'running', phase: 'repairing', acceptance: Object.freeze(acceptance), repairIteration: repair.attempts.length, terminalDiagnostic: null, resumable: false }, { phase: 'repairing', status: 'warning', title: `开始第 ${repair.attempts.length} 轮修复`, detail: failedEvidence.length ? `依据 ${failedEvidence.length} 项失败证据。` : '等待可采信失败证据。', turnId, toolCallId });
        if (this.active?.taskId === taskId) {
          this.active.continuationRequested = true;
          this.active.continuationInstruction = repairRequest(playtest.task, evaluation, repair.attempts.length);
          this.active.decisions.push(`Evaluation failed; bounded repair iteration ${repair.attempts.length} approved by the task budget.`);
        }
      }
    } catch (cause) {
      const code = errorCode(cause);
      try { playtest.block(code, failedEvidence); } catch { /* task may already be terminal */ }
      this.updateTaskRun(taskId, { status: 'blocked', phase: 'blocked', acceptance: Object.freeze(acceptance), terminalDiagnostic: code, resumable: code === 'budget.hard-stop' }, { phase: 'blocked', status: 'error', title: '无法启动下一轮修复', detail: errorMessage(cause), turnId, toolCallId });
    }
  }

  private async evidenceReadModel(artifact: ObservationArtifactV2, taskId: StableId): Promise<ConversationTaskEvidenceReadModel | null> {
    const current = this.taskRuns.get(taskId); if (!current) return null;
    let previewDataUrl: string | undefined;
    if (artifact.type === 'screenshot' && artifact.taskId === taskId && artifact.byteLength <= 512 * 1024) previewDataUrl = await this.approvedScreenshotDataUrl(asStableId(artifact.id));
    const provenanceStatus: ConversationTaskEvidenceReadModel['provenanceStatus'] = artifact.taskId !== taskId ? 'invalid' : current.documentRevision !== null && artifact.documentRevision !== current.documentRevision ? 'stale' : 'current';
    return Object.freeze({ id: asStableId(artifact.id), type: artifact.type, taskId: asStableId(artifact.taskId), turnId: asStableId(artifact.turnId), playId: asStableId(artifact.playId), documentRevision: artifact.documentRevision, tick: artifact.tick, frame: artifact.frame, viewport: artifact.viewport, device: artifact.device, capturedAt: artifact.capturedAt, byteLength: artifact.byteLength, redacted: artifact.redacted, producerVersion: artifact.producerVersion, provenanceStatus, ...(previewDataUrl ? { previewDataUrl } : {}) });
  }

  private async approvedScreenshotDataUrl(id: StableId): Promise<string | undefined> {
    try {
      const stored = await this.options.operationLog.readArtifact(id); const value = stored.value;
      if (!isRecord(value) || value.kind !== 'haiyue.play-observation.v2' || value.type !== 'screenshot' || !isRecord(value.payload) || value.payload.mediaType !== 'image/png' || typeof value.payload.base64 !== 'string') return undefined;
      if (value.payload.base64.length > 512 * 1024 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u.test(value.payload.base64)) return undefined;
      return `data:image/png;base64,${value.payload.base64}`;
    } catch { return undefined; }
  }

  private updateTaskRun(taskId: StableId, patch: Partial<ConversationTaskRunReadModel>, timeline?: Readonly<{ phase: ConversationTaskPhase; status: 'active' | 'complete' | 'warning' | 'error'; title: string; detail: string; turnId?: StableId | null; toolCallId?: StableId | null; playId?: StableId | null; tick?: number | null }>): void {
    const current = this.taskRuns.get(taskId); if (!current) return;
    const nextTimeline = timeline ? Object.freeze([...current.timeline, taskTimeline(timeline.phase, timeline.status, timeline.title, timeline.detail, timeline)].slice(-400)) : current.timeline;
    const next = Object.freeze({ ...current, ...patch, schemaVersion: 1 as const, taskId, revision: current.revision + 1, updatedAt: new Date().toISOString(), timeline: nextTimeline });
    this.taskRuns.set(taskId, next); this.persistTaskRun(next); this.changed();
  }

  private persistTaskRun(run: ConversationTaskRunReadModel): void {
    if (!this.projectionPersistenceAvailable()) return;
    const persisted = Object.freeze({ ...run, evidence: Object.freeze(run.evidence.map(({ previewDataUrl: _preview, ...item }) => Object.freeze(item))) });
    const write = async (): Promise<void> => {
      const artifact = await this.options.operationLog.putArtifact(persisted as unknown as JsonObject, { schemaVersion: 'conversation-task/1' });
      await this.options.operationLog.append({ kind: 'conversation/task-projected', severity: run.status === 'failed' || run.status === 'blocked' ? 'warning' : 'info', source: asStableId('studio.conversation-host'), correlation: { ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(run.turnId ? { turnId: run.turnId } : {}) }, payload: { taskId: run.taskId, revision: run.revision, status: run.status, phase: run.phase, artifactId: artifact.id }, artifactRefs: [artifact.id] });
    };
    this.projectionWriteTail = this.projectionWriteTail.then(write, write).catch((cause) => { this.projectionPersistenceFailure ??= cause; });
  }

  private async restoreTaskRuns(): Promise<void> {
    if (!this.projectionPersistenceAvailable()) return;
    let cursor: string | undefined; let count = 0;
    do {
      const page = await this.options.operationLog.query({ kinds: ['conversation/task-projected'], limit: 200, traverseCorrelation: false, ...(cursor ? { cursor } : {}) });
      for (const event of page.events) {
        const id = event.artifactRefs[0]; if (!id) continue;
        try {
          const run = normalizeTaskRun((await this.options.operationLog.readArtifact(id)).value); const prior = this.taskRuns.get(run.taskId);
          if (!prior || run.revision > prior.revision) this.taskRuns.set(run.taskId, run);
        } catch { /* corrupt/future projections stay hidden */ }
        count += 1;
      }
      cursor = page.nextCursor;
    } while (cursor && count < 5_000);
    for (const run of [...this.taskRuns.values()]) {
      if (run.acceptance.length && !this.playtestTasks.has(run.taskId) && run.status !== 'completed') {
        const restored = new BoundedPlaytestTask(taskSpecFromRun(run), run.repairLimit); restored.advance('editing'); this.playtestTasks.set(run.taskId, restored);
      }
      if (run.status === 'running' || run.status === 'waiting-user') this.updateTaskRun(run.taskId, { status: 'blocked', phase: 'blocked', terminalDiagnostic: 'task.interrupted-by-restart', resumable: run.sessionId !== null && run.turnId !== null }, { phase: 'blocked', status: 'warning', title: '任务因 Studio 重启中断', detail: '已完成产物和证据均已保留；可从最后一个安全检查点恢复。', turnId: run.turnId });
    }
  }

  private async hydrateTaskPreviews(): Promise<void> {
    for (const run of [...this.taskRuns.values()]) {
      let changed = false;
      const evidence = await Promise.all(run.evidence.map(async (item) => {
        if (item.type !== 'screenshot' || item.previewDataUrl) return item;
        const previewDataUrl = await this.approvedScreenshotDataUrl(item.id); if (!previewDataUrl) return item;
        changed = true; return Object.freeze({ ...item, previewDataUrl });
      }));
      if (changed) this.taskRuns.set(run.taskId, Object.freeze({ ...run, evidence: Object.freeze(evidence) }));
    }
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
let taskTimelineSequence = 0;
function taskTimeline(phase: ConversationTaskPhase, status: 'active' | 'complete' | 'warning' | 'error', title: string, detail: string, coordinates: Readonly<{ turnId?: StableId | null; toolCallId?: StableId | null; playId?: StableId | null; tick?: number | null }> = {}): ConversationTaskRunReadModel['timeline'][number] {
  taskTimelineSequence += 1; const at = new Date().toISOString();
  return Object.freeze({ id: asStableId(`timeline:${sha256(`${at}:${taskTimelineSequence}:${title}`).slice(7, 31)}`), at, phase, status, title: title.slice(0, 160), detail: detail.slice(0, 1_024), turnId: coordinates.turnId ?? null, toolCallId: coordinates.toolCallId ?? null, playId: coordinates.playId ?? null, tick: coordinates.tick ?? null });
}
function taskTitle(prompt: string): string { const first = prompt.trim().split(/\r?\n/u)[0] ?? 'Agent task'; return first.length > 80 ? `${first.slice(0, 77)}…` : first || 'Agent task'; }
function acceptanceReadModel(value: PlanAcceptanceProposal, id: StableId): ConversationTaskAcceptanceReadModel { return Object.freeze({ id, label: value.label, assertion: value.assertion, category: value.category, required: value.required, visibility: 'agent', status: 'pending', evidenceIds: Object.freeze([]), diagnostic: null }); }
function acceptanceLabel(assertion: string): string {
  const match = /^evidence ([a-z-]+)/u.exec(assertion); return match ? `${match[1]} 验收` : '验收标准';
}
function taskSpecFromPlan(active: ActiveTurn, acceptance: readonly PlanAcceptanceProposal[]): TaskSpecV2 {
  const criteria = acceptance.map((item, index) => Object.freeze({ id: asStableId(`acceptance:${active.taskId}:${index + 1}`), required: item.required, visibility: 'agent' as const, category: item.category, assertion: item.assertion }));
  const requiredCapabilities = new Set<TaskSpecV2['requiredCapabilities'][number]>(['task.evaluate']);
  for (const item of acceptance) {
    if (/^evidence screenshot/u.test(item.assertion)) requiredCapabilities.add('play.capture');
    if (/^evidence (?:state|event-trace|runtime-errors|performance|visual-analysis|lifecycle)/u.test(item.assertion)) requiredCapabilities.add('play.inspect');
  }
  return Object.freeze({ schemaVersion: 2, id: active.taskId, request: active.goal.slice(0, 20_000), visibleConstraints: Object.freeze([]), budgetId: active.account.options.budget.id, requiredCapabilities: Object.freeze([...requiredCapabilities]), acceptance: Object.freeze(criteria) });
}
function taskSpecFromRun(run: ConversationTaskRunReadModel): TaskSpecV2 {
  const requiredCapabilities = new Set<TaskSpecV2['requiredCapabilities'][number]>(['task.evaluate']);
  for (const item of run.acceptance) { if (item.category === 'visual') requiredCapabilities.add('play.capture'); else requiredCapabilities.add('play.inspect'); }
  return Object.freeze({ schemaVersion: 2, id: run.taskId, request: run.requestSummary, visibleConstraints: Object.freeze([]), budgetId: asStableId(`budget:${run.taskId}`), requiredCapabilities: Object.freeze([...requiredCapabilities]), acceptance: Object.freeze(run.acceptance.map((item) => Object.freeze({ id: item.id, required: item.required, visibility: item.visibility, category: item.category, assertion: item.assertion }))) });
}
function productPhaseForTool(toolId: StableId): Extract<ConversationTaskPhase, 'editing' | 'validating' | 'playing' | 'evaluating'> | null {
  if (toolId === 'preview.validate') return 'validating';
  if (toolId === 'preview.start' || toolId === 'play.start' || toolId === 'play.step' || toolId === 'play.input' || toolId === 'play.inspect' || toolId === 'play.capture' || toolId === 'play.stop' || toolId === 'preview.stop') return 'playing';
  if (toolId === 'task.evaluate') return 'evaluating';
  if (['entity.create', 'entity.rename', 'transform.set', 'material.set', 'component.add', 'component.update', 'component.remove', 'script.apply', 'script.propose', 'camera.set'].includes(toolId)) return 'editing';
  return null;
}
function productToolTitle(toolId: StableId): string {
  if (toolId === 'task.evaluate') return '正在逐项验收';
  if (toolId.startsWith('play.') || toolId.startsWith('preview.')) return '正在运行与采集证据';
  return '正在编辑项目';
}
function advancePlaytest(playtest: BoundedPlaytestTask, target: Extract<ConversationTaskPhase, 'editing' | 'validating' | 'playing' | 'evaluating'>): void {
  for (let guard = 0; guard < 5 && playtest.snapshot().phase !== target; guard += 1) {
    const phase = playtest.snapshot().phase;
    if (phase === 'planning' || phase === 'repairing' || phase === 'evaluating' && target === 'editing') playtest.advance('editing');
    else if (phase === 'editing' && target !== 'editing') playtest.advance('validating');
    else if (phase === 'validating' && (target === 'playing' || target === 'evaluating')) playtest.advance('playing');
    else if (phase === 'playing' && target === 'evaluating') playtest.advance('evaluating');
    else break;
  }
  if (playtest.snapshot().phase !== target) throw new PlaytestLoopError('task.transition-invalid', `Cannot enter ${target} from ${playtest.snapshot().phase}.`);
}
function observationArtifacts(value: JsonObject): readonly ObservationArtifactV2[] {
  const candidates: unknown[] = [];
  if (isRecord(value.observation)) candidates.push(value.observation);
  if (Array.isArray(value.observations)) candidates.push(...value.observations);
  const values: ObservationArtifactV2[] = [];
  for (const item of candidates) {
    if (!isRecord(item) || item.schemaVersion !== 2 || !['state', 'event-trace', 'runtime-errors', 'performance', 'screenshot', 'visual-analysis', 'lifecycle'].includes(String(item.type))
      || typeof item.id !== 'string' || typeof item.taskId !== 'string' || typeof item.turnId !== 'string' || typeof item.playId !== 'string' || !Number.isSafeInteger(item.documentRevision)
      || !Number.isSafeInteger(item.tick) || !Number.isSafeInteger(item.frame) || typeof item.capturedAt !== 'string' || !Number.isSafeInteger(item.byteLength) || typeof item.producerVersion !== 'string') continue;
    values.push(item as unknown as ObservationArtifactV2);
  }
  return Object.freeze(values);
}
function evaluationResult(value: JsonObject, taskId: StableId): EvaluationResultV2 {
  if (value.schemaVersion !== 2 || value.taskId !== taskId || typeof value.id !== 'string' || !['pass', 'fail', 'blocked'].includes(String(value.status)) || !Array.isArray(value.acceptanceResults)
    || !Array.isArray(value.usageRecordIds) || !Array.isArray(value.costRecordIds) || typeof value.completedAt !== 'string' || typeof value.evaluatorVersion !== 'string') throw new PlaytestLoopError('task.evaluation-invalid', 'Evaluator returned an invalid task result.');
  const results = value.acceptanceResults.map((item) => {
    if (!isRecord(item) || typeof item.acceptanceId !== 'string' || !['pass', 'fail', 'blocked'].includes(String(item.status)) || !Array.isArray(item.evidenceIds) || !item.evidenceIds.every((id) => typeof id === 'string')) throw new PlaytestLoopError('task.evaluation-invalid', 'Evaluator returned an invalid acceptance result.');
    return Object.freeze({ acceptanceId: asStableId(item.acceptanceId), status: item.status as 'pass' | 'fail' | 'blocked', evidenceIds: Object.freeze(item.evidenceIds.map((id) => asStableId(id as string))), diagnostic: typeof item.diagnostic === 'string' ? item.diagnostic.slice(0, 512) : null });
  });
  return Object.freeze({ schemaVersion: 2, id: asStableId(value.id), taskId, evaluatorVersion: value.evaluatorVersion.slice(0, 96), status: value.status as EvaluationResultV2['status'], acceptanceResults: Object.freeze(results), budgetStatus: ['within', 'soft-exceeded', 'hard-exceeded'].includes(String(value.budgetStatus)) ? value.budgetStatus as EvaluationResultV2['budgetStatus'] : 'within', usageRecordIds: Object.freeze((value.usageRecordIds as unknown[]).filter((id): id is string => typeof id === 'string').map((id) => asStableId(id))), costRecordIds: Object.freeze((value.costRecordIds as unknown[]).filter((id): id is string => typeof id === 'string').map((id) => asStableId(id))), turns: Object.freeze([]), tools: Object.freeze([]), completedAt: value.completedAt });
}
function repairRequest(task: TaskSpecV2, evaluation: EvaluationResultV2, iteration: number): string {
  const failed = evaluation.acceptanceResults.filter((item) => item.status === 'fail');
  return ['Continue the same visible task with a bounded evidence-led repair.', `Repair iteration: ${iteration}.`, `Failed acceptance: ${JSON.stringify(failed.map((item) => ({ acceptanceId: item.acceptanceId, evidenceIds: item.evidenceIds, diagnostic: item.diagnostic })))}`, 'Re-inspect the authoritative revision, change only causes supported by the cited evidence, run Play again, collect fresh same-revision evidence, and call task.evaluate with the approved criteria. Do not repeat an unchanged repair.'].join('\n');
}
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
  description: 'Submit the complete implementation plan and machine-checkable acceptance criteria for user review before any project mutation. Include authored entities, responsibilities, scripts, dynamic state ownership, rendering strategy, and fixed evidence assertions. The result blocks until the user approves or requests a revision.',
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
      acceptance: Object.freeze({ type: 'array', minItems: 1, maxItems: 50, items: Object.freeze({
        type: 'object', additionalProperties: false, required: Object.freeze(['label', 'required', 'category', 'assertion']), properties: Object.freeze({
          label: Object.freeze({ type: 'string', minLength: 1, maxLength: 240 }), required: Object.freeze({ type: 'boolean' }),
          category: Object.freeze({ enum: Object.freeze(['functional', 'visual', 'performance', 'lifecycle', 'budget', 'security']) }),
          assertion: Object.freeze({ type: 'string', minLength: 1, maxLength: 2_000, pattern: '^evidence (state|event-trace|runtime-errors|performance|screenshot|visual-analysis|lifecycle)(?: signal [A-Za-z0-9_.-]+ (?:equals|gte|lte) .+)?$' }),
        }),
      }) }),
    }),
  }) as JsonObject,
});

function validatePlanProposal(value: JsonObject): Readonly<{ title: string; summary: string; items: readonly Readonly<{ label: string; details?: string }>[]; acceptance: readonly PlanAcceptanceProposal[] }> {
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['title', 'summary', 'items', 'acceptance'].includes(key)) || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 160
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
  const acceptance = raw.acceptance === undefined ? [] : !Array.isArray(raw.acceptance) || raw.acceptance.length < 1 || raw.acceptance.length > 50
    ? (() => { throw new PlanProtocolError('plan.payload-invalid', 'Plan acceptance requires 1-50 criteria.'); })()
    : raw.acceptance.map((entry, index) => {
      if (!isRecord(entry) || Object.keys(entry).some((key) => !['label', 'required', 'category', 'assertion'].includes(key)) || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 240
        || typeof entry.required !== 'boolean' || !['functional', 'visual', 'performance', 'lifecycle', 'budget', 'security'].includes(String(entry.category))
        || typeof entry.assertion !== 'string' || entry.assertion.length > 2_000 || !/^evidence (?:state|event-trace|runtime-errors|performance|screenshot|visual-analysis|lifecycle)(?: signal [A-Za-z0-9_.-]+ (?:equals|gte|lte) .+)?$/u.test(entry.assertion)) {
        throw new PlanProtocolError('plan.payload-invalid', `Acceptance criterion ${index + 1} is invalid or not machine-checkable.`);
      }
      return Object.freeze({ label: entry.label.trim(), required: entry.required, category: entry.category as PlanAcceptanceProposal['category'], assertion: entry.assertion.trim() });
    });
  return Object.freeze({ title: raw.title.trim(), summary: raw.summary.trim(), items: Object.freeze(items), acceptance: Object.freeze(acceptance) });
}
function turnKey(sessionId: StableId, turnId: StableId): string { return `${sessionId}\u0000${turnId}`; }
class PlanProtocolError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'PlanProtocolError'; } }
function errorCode(value: unknown): string { return value && typeof value === 'object' && 'code' in value ? String((value as { code: unknown }).code).slice(0, 96) : 'conversation.operation-failed'; }
function errorMessage(value: unknown): string { return (value instanceof Error ? value.message : String(value)).slice(0, 2_000); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
