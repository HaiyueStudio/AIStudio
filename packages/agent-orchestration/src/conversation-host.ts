import { stringField, isRecord, errorCode, errorMessage } from './value-utils.js';
import { budgetMetricLabel, budgetContinuationRequest, DEFAULT_TASK_BUDGET, assertBudgetAllowed, armWallTimeBudget, type WallTimeBudget } from './budget-policy.js';
import { approvedPlanRequest, PLAN_TOOL_ID, PLAN_TOOL_DEFINITION, validatePlanProposal, PlanProtocolError, type ApprovedPlanExecution, type PlanAcceptanceProposal } from './plan-policy.js';
import { taskTimeline, taskTitle, acceptanceReadModel, acceptanceLabel, taskSpecFromPlan, taskSpecFromRun, productPhaseForTool, productToolTitle, advancePlaytest, observationArtifacts, evaluationResult, repairRequest, taskAccountingProjection } from './task-acceptance.js';
import { queryRetainedOperationEvents } from './retained-events.js';
import { compareExecutionGraphs } from '@haiyue/ai-studio-shell/conversation';
import { approvalContent, presentationDigest, intentLogPayload, localCompactionSummary, questionOptions, terminalStatus, completionSummary, boundedJson, projectToolModelResult, toolArgumentSummary, toolResultSummary } from './conversation-presentation.js';
import { asStableId, type AgentTurnConfigV2, type JsonObject, type JsonValue, type M12ReasoningEffort, type ObservationArtifactV2, type StableId, type TaskBudgetV2, type ToolBatchNodeV1 } from '@haiyue/ai-studio-contracts';
import { M12_DEFAULT_PRICING_CATALOG, type AgentBackend, type AgentBackendEvent, type AgentLoginHandoff, type AgentRuntimeService, type AgentTurnInput, type BackendSessionAdapter, type BudgetDecision, type CompactionSummaryRequestV1, type ContextCompactionRuntime, type ContextProjectSnapshot, type DurableSessionHandle, type PromptProfileSnapshot, type SessionReplaySnapshotV1, type TaskAccount } from '@haiyue/ai-studio-agent-runtime';
import { BoundedPlaytestTask, GameToolProtocolError, MODEL_TOOL_INVOKE_DEFINITION, PlaytestLoopError, RollingToolBatchScheduler, normalizeToolBatchRequest, resolveModelToolInvocation, type GameAuthoringToolService, type GameToolApproval, type GameToolApprovalResolution, type GameToolPreparation, type GameToolResult, type LegacyToolRequest, type RollingToolWorkResult, type ToolBatchDiagnostic, type ToolBatchNodeStatus } from '@haiyue/ai-studio-game-authoring-tools';
import { canonicalStringify, redactObject, sha256, type ConversationOperationLog } from '@haiyue/ai-studio-operation-log';
import { normalizeConversationNode, normalizeTaskAccounting, normalizeTaskRun, projectExecutionGraph, validateConversationIntent, type ConversationBackendReadModel, type ConversationNodeReadModel, type ConversationProjectionEvent, type ConversationReplaySnapshot, type ConversationTaskAcceptanceReadModel, type ConversationTaskAccountingReadModel, type ConversationTaskEvidenceReadModel, type ConversationTaskPhase, type ConversationTaskRunReadModel, type ExecutionGraphReadModel } from '@haiyue/ai-studio-shell/conversation';
import { migrateLegacySessions } from './legacy-session-migration.js';

interface ActiveTurn {
  readonly backendId: StableId;
  readonly taskId: StableId;
  readonly config: AgentTurnConfigV2;
  readonly tools: AgentTurnInput['tools'] | null;
  providerStarted: boolean;
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
  suspendedBarrierId: StableId | null;
}
interface BackendSelection { readonly model: string; readonly reasoningEffort: M12ReasoningEffort; readonly outputTokenLimit: number; }
interface PendingApproval { readonly preparation: GameToolPreparation; readonly approval: GameToolApproval; readonly nodeId: StableId; readonly sessionId: StableId; readonly turnId: StableId; readonly resolve: () => void; readonly reject: (cause: unknown) => void; }
interface PendingBackendQuestion { readonly kind: 'backend'; readonly backend: AgentBackend; readonly nodeId: StableId; readonly backendNodeId: StableId; readonly sessionId: StableId; readonly turnId: StableId; readonly releaseHumanWait: () => void; readonly detachAbort: () => void; }
interface PendingBudgetQuestion { readonly kind: 'budget'; readonly nodeId: StableId; readonly sessionId: StableId; readonly turnId: StableId; readonly continueOptionId: StableId; readonly stopOptionId: StableId; readonly releaseHumanWait: () => void; readonly detachAbort: () => void; readonly resolve: (continued: boolean) => void; readonly reject: (cause: unknown) => void; }
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
interface ToolExecutionContext {
  readonly backend: AgentBackend;
  readonly event: AgentBackendEvent;
  readonly toolCallId: StableId;
  readonly toolId: StableId;
  readonly args: JsonObject;
  readonly provenance: ConversationNodeReadModel['provenance'];
  readonly toolNodeId: StableId;
  readonly node: ToolBatchNodeV1;
  readonly invocationError?: Readonly<{ code: string; message: string }>;
}
interface HostToolBody {
  readonly status: ToolBatchNodeStatus;
  readonly backendResult: JsonObject;
  readonly toolCallStatus: 'completed' | 'cancelled' | 'failed';
  readonly toolCallContent: JsonObject;
  readonly resultStatus: 'completed' | 'cancelled' | 'failed';
  readonly resultContent: JsonObject;
  readonly resultValue: JsonObject | null;
  readonly fact: string | null;
  readonly blocker: string | null;
  readonly mutation: boolean;
  readonly cancelTurnAfterCommit: boolean;
  readonly latencyMs: number;
  readonly finishedAt: string;
}
interface PreparedMutationWork {
  readonly kind: 'prepared-mutation';
  readonly context: ToolExecutionContext;
  readonly preparation: GameToolPreparation;
  readonly startedAtMs: number;
  readonly group: BatchTransactionGroup;
}
type HostToolWork = HostToolBody | PreparedMutationWork;
interface BatchTransactionGroup {
  readonly id: StableId;
  readonly entries: Array<Readonly<{ context: ToolExecutionContext; work: Promise<RollingToolWorkResult<HostToolWork>> }>>;
  flush: Promise<ReadonlyMap<StableId, HostToolBody>> | null;
}
interface ActiveToolBatch {
  readonly id: StableId;
  readonly backend: AgentBackend;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly startedAtMs: number;
  readonly calls: LegacyToolRequest[];
  readonly contexts: Map<StableId, ToolExecutionContext>;
  readonly bodies: HostToolBody[];
  readonly scheduler: RollingToolBatchScheduler<HostToolWork>;
  transactionGroup: BatchTransactionGroup | null;
  startTail: Promise<void>;
  commitTail: Promise<void>;
  drain: Promise<void> | null;
  outputBytes: number;
}
interface RecoveredContinuationSeed {
  readonly taskId: StableId;
  readonly instruction: string;
  readonly plan: ApprovedPlanExecution | null;
  readonly budgetGranted: boolean;
}
interface QueuedConversationPrompt { readonly backendId: StableId; readonly prompt: string; readonly recovered?: RecoveredContinuationSeed; }

type BarrierWaitResult = 'suspended';

export interface ConversationHostOptions {
  readonly runtime: AgentRuntimeService;
  readonly tools: GameAuthoringToolService;
  readonly operationLog: ConversationOperationLog;
  readonly recordProjectId?: StableId;
  readonly idPrefix?: string;
  readonly initialSettings?: ConversationHostSettings;
  readonly isProjectOpen?: () => boolean;
  readonly projectContext?: () => ContextProjectSnapshot | null;
  /** Best-effort local retrieval refresh. Failure degrades to exact context and must never block a turn. */
  readonly prepareKnowledge?: (project: ContextProjectSnapshot | null, signal?: AbortSignal) => Promise<void>;
  readonly knowledgeRefreshTimeoutMs?: number;
  readonly sessionRecovery?: Readonly<{ recover(handle: DurableSessionHandle, claimId?: StableId): Promise<unknown> }>;
  readonly openLoginHandoff?: (backendId: StableId, handoff: AgentLoginHandoff) => Promise<void>;
}

export interface ConversationHostSettings {
  readonly backendId: StableId | null;
  readonly selections: readonly (BackendSelection & Readonly<{ backendId: StableId }>)[];
  readonly budget: TaskBudgetV2;
}

/** Headless workflow owner for backend streams, tool execution, approvals and replayable read models. The composition root owns initialization and disposal. */
export class StudioConversationHost {
  private readonly events: ConversationProjectionEvent[] = [];
  private readonly nodes = new Map<StableId, ConversationNodeReadModel>();
  private readonly pendingRecordContents = new Map<StableId, JsonObject>();
  private readonly approvals = new Map<StableId, PendingApproval>();
  private readonly questions = new Map<StableId, PendingQuestion>();
  private readonly plans = new Map<StableId, PendingPlan>();
  private readonly approvedPlanTurns = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly backendSelections = new Map<StableId, BackendSelection>();
  private readonly taskRuns = new Map<StableId, ConversationTaskRunReadModel>();
  private readonly restoredTaskAccounting = new Map<StableId, ConversationTaskAccountingReadModel>();
  private readonly playtestTasks = new Map<StableId, BoundedPlaytestTask>();
  private backends: readonly ConversationBackendReadModel[] = Object.freeze([]);
  private backendId: StableId | null = null;
  private active: ActiveTurn | null = null;
  private eventSequence = 0;
  private nodeSequence = 0;
  private stateRevision = 0;
  private disposed = false;
  private stopping = false;
  private disposeResult: Promise<void> | null = null;
  private readonly pendingWork = new Set<Promise<unknown>>();
  private latestTaskId: StableId | null = null;
  private budgetTemplate: TaskBudgetV2 = DEFAULT_TASK_BUDGET;
  private projectionWriteTail: Promise<void> = Promise.resolve();
  private projectionPersistenceFailure: unknown = null;
  private readonly durableSessions = new Map<StableId, Promise<DurableSessionHandle>>();
  private readonly executionGraphs = new Map<StableId, ExecutionGraphReadModel>();
  private readonly restoredGraphSessions = new Map<StableId, string>();
  private readonly pendingGraphSnapshots = new Map<StableId, SessionReplaySnapshotV1>();
  private readonly initializedSessionTurns = new Set<string>();
  private readonly finalizedSessionTurns = new Set<string>();
  private readonly capturedContextTurns = new Set<string>();
  private readonly manualCompactors = new Map<StableId, ContextCompactionRuntime>();
  private readonly manualCompactionRequests = new Map<StableId, Promise<void>>();
  private graphProjectionTimer: ReturnType<typeof setTimeout> | null = null;
  private toolBatchSequence = 0;
  private readonly queuedPrompts: QueuedConversationPrompt[] = [];
  private queuedPromptDrainActive = false;

  constructor(private readonly options: ConversationHostOptions) {
    if (options.initialSettings) {
      this.backendId = options.initialSettings.backendId; this.budgetTemplate = options.initialSettings.budget;
      for (const { backendId, ...selection } of options.initialSettings.selections) this.backendSelections.set(backendId, selection);
    }
  }

  settings(): ConversationHostSettings {
    return Object.freeze({ backendId: this.backendId, budget: this.budgetTemplate, selections: Object.freeze([...this.backendSelections].map(([backendId, selection]) => Object.freeze({ backendId, ...selection }))) });
  }

  async flushRecords(): Promise<void> {
    await this.projectionWriteTail;
    if (this.projectionPersistenceFailure) throw new AggregateError([this.projectionPersistenceFailure], 'Conversation record persistence failed.');
  }

  async initialize(): Promise<void> { await this.restoreProjection(); await this.restoreTaskRuns(); await this.migrateLegacySessions(); await this.restoreTaskAccounting(); await this.hydrateTaskPreviews(); await this.restoreExecutionGraphs(); await this.refreshBackends(); }

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
      busy: this.active !== null || this.queuedPromptDrainActive || this.queuedPrompts.length > 0,
      backendId: this.backendId,
      backends: this.backends,
      taskAccounting: this.taskAccountingReadModel(),
      taskRuns: Object.freeze([...this.taskRuns.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)).slice(-50)),
      executionGraphs: Object.freeze([...this.executionGraphs.values()].sort(compareExecutionGraphs).slice(-50)),
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
        if (intent.backendId !== this.backendId) throw new Error('Selected backend changed before send.');
        if (this.active || this.queuedPromptDrainActive) {
          if (this.queuedPrompts.length >= 16) throw new Error('The Agent message queue is full.');
          this.queuedPrompts.push(Object.freeze({ backendId: intent.backendId, prompt: intent.prompt }));
          await this.options.operationLog.append({
            kind: 'conversation/prompt-queued', severity: 'info', source: asStableId('studio.conversation-host'), correlation: {},
            payload: { backendId: intent.backendId, promptDigest: sha256(intent.prompt), promptBytes: Buffer.byteLength(intent.prompt), queueDepth: this.queuedPrompts.length, supersedesBarrier: this.hasPendingHumanBarrier() },
          });
          if (this.hasPendingHumanBarrier()) {
            const active = this.active;
            active?.controller.abort(new Error('Active wait was superseded by a new user message; committed work is preserved.'));
            if (active?.sessionId && active.turnId) await this.options.runtime.turns.cancel(active.backendId, active.sessionId, active.turnId).catch(() => undefined);
          }
          this.changed();
          return;
        }
        // Claim the launch slot before the first asynchronous context read. Without
        // this fence replay() can briefly report idle, allowing compaction or a
        // second send to race a turn whose Session has not been created yet.
        this.queuedPromptDrainActive = true;
        this.changed();
        this.track(this.start(intent.backendId, intent.prompt)
          .catch((cause) => this.captureFailure(intent.backendId, cause))
          .finally(() => {
            this.queuedPromptDrainActive = false;
            this.changed();
            this.drainQueuedPrompts();
          }));
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
        this.track(this.resume(intent.backendId, intent.sessionId, intent.turnId).catch((cause) => this.captureFailure(intent.backendId, cause, intent.sessionId, intent.turnId)));
        return;
      case 'conversation/reconnect': await this.refreshBackends(); return;
      case 'conversation/answer-question': {
        const pending = this.questions.get(intent.nodeId);
        if (!pending) { await this.resolveRecoveredQuestion(intent.nodeId, intent.answer); return; }
        try {
          if (pending.kind === 'backend') await pending.backend.answerQuestion(pending.backendNodeId, intent.answer, signal);
          else {
            const optionIds = Array.isArray(intent.answer.optionIds) ? intent.answer.optionIds : [];
            if (optionIds.length !== 1 || (optionIds[0] !== pending.continueOptionId && optionIds[0] !== pending.stopOptionId)) throw new Error('Budget continuation answer is invalid.');
          }
          await this.resolveQuestionBarrier(pending, intent.answer, 'answered');
          this.questions.delete(intent.nodeId); pending.detachAbort(); pending.releaseHumanWait();
          if (pending.kind === 'budget') {
            const optionIds = intent.answer.optionIds as readonly JsonValue[];
            pending.resolve(optionIds[0] === pending.continueOptionId);
          }
          this.finishNode(intent.nodeId, 'completed');
          if (this.active) this.updateTaskRun(this.active.taskId, { status: 'running', resumable: false, terminalDiagnostic: null }, { phase: this.taskRuns.get(this.active.taskId)?.phase ?? 'planning', status: 'complete', title: pending.kind === 'budget' ? '预算选择已确认' : '补充信息已提交', detail: pending.kind === 'budget' ? (Array.isArray(intent.answer.optionIds) && intent.answer.optionIds[0] === pending.continueOptionId ? '用户批准继续一个有界预算分段。' : '用户停止并保留已完成产物。') : 'Agent 可以继续处理。' });
        }
        catch (cause) { if (pending.kind === 'budget') pending.reject(cause); this.finishNode(intent.nodeId, 'failed'); throw cause; }
        return;
      }
      case 'conversation/accept-plan': if (this.plans.has(intent.nodeId)) await this.resolvePlan(intent.nodeId, intent.acceptedItemIds, intent.note, intent.mode ?? 'approve'); else await this.resolveRecoveredPlan(intent.nodeId, intent.acceptedItemIds, intent.note, intent.mode ?? 'approve'); return;
      case 'conversation/resolve-approval': if (this.approvals.has(intent.approvalId)) await this.resolveApproval(intent.approvalId, intent.decision); else await this.resolveRecoveredApproval(intent.approvalId, intent.decision); return;
      case 'conversation/request-compaction': await this.requestManualCompaction(intent.sessionId, intent.requestId, signal); return;
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

  dispose(): Promise<void> {
    return this.disposeResult ??= this.stopAndDispose();
  }

  private async stopAndDispose(): Promise<void> {
    if (this.disposed) return;
    this.stopping = true;
    this.queuedPrompts.length = 0;
    this.cancelPending('Conversation host disposed.');
    await Promise.allSettled([...this.pendingWork, ...this.manualCompactionRequests.values()]);
    if (this.graphProjectionTimer) { clearTimeout(this.graphProjectionTimer); this.graphProjectionTimer = null; }
    this.pendingGraphSnapshots.clear();
    this.pendingRecordContents.clear();
    this.questions.clear();
    this.plans.clear();
    this.approvedPlanTurns.clear();
    this.manualCompactionRequests.clear();
    this.manualCompactors.clear();
    this.capturedContextTurns.clear();
    this.listeners.clear();
    this.disposed = true;
    await this.projectionWriteTail;
    await Promise.allSettled([...this.durableSessions.values()].map(async (handle) => (await handle).dispose()));
    this.durableSessions.clear();
    if (this.projectionPersistenceFailure) throw new AggregateError([this.projectionPersistenceFailure], 'Conversation projection persistence failed.');
  }

  cancelPending(reason = 'Renderer owner changed.'): void {
    const active = this.active;
    const liveBarrierNodeIds = new Set<StableId>([
      ...[...this.approvals.values()].map((pending) => pending.nodeId),
      ...[...this.questions.values()].map((pending) => pending.nodeId),
      ...[...this.plans.values()].map((pending) => pending.nodeId),
    ]);
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
      if ((node.kind === 'approval' || node.kind === 'question' || node.kind === 'plan') && !liveBarrierNodeIds.has(node.id)) continue;
      const content = node.kind === 'approval' ? Object.freeze({ ...node.content, decision: 'stale' }) : node.content;
      this.project(node.id, node.kind, 'cancelled', node.provenance, content);
    }
    this.changed();
  }

  private async start(backendId: StableId, prompt: string): Promise<void> {
    const controller = new AbortController();
    const localSessionId = this.localId(`session:pending:${this.nodeSequence + 1}`);
    const localTurnId = this.localId(`turn:pending:${this.nodeSequence + 1}`);
    const userNodeId = this.nextNodeId('00-user');
    const initialProgressNodeId = this.nextNodeId('01-progress');
    const provenance = Object.freeze({ backendId, sessionId: localSessionId, turnId: localTurnId });
    const taskId = this.localId(`task:conversation:${this.nodeSequence + 1}`);
    const tools = this.modelTools(prompt);
    const project = this.options.projectContext?.() ?? null;
    await this.prepareKnowledge(project, controller.signal);
    const conversationKey = conversationKeyFor(project);
    const context = await this.options.runtime.context.prepare({ conversationKey, backendId, taskId, request: prompt, tools, project });
    if (this.stopping) return;
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
    this.active = { backendId, taskId, config, tools, providerStarted: false, account, sessionId: null, turnId: null, controller, wallTimeBudget, initialProgressNodeId, localSessionId, localTurnId, approvedPlan: null, continuationRequested: false, continuationInstruction: null, budgetCheckpoint: null, conversationKey, projectId: project?.projectId ?? null, goal: prompt, decisions: [], toolFacts: [], blockers: [], contextCommitted: false, suspendedBarrierId: null };
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
      if (owned?.continuationRequested && owned.suspendedBarrierId === null) {
        await this.continueTask(backendId, owned.approvedPlan, owned.taskId, owned.config, owned.account, owned.conversationKey, owned.goal, owned.continuationInstruction).catch((cause) => this.captureFailure(backendId, cause));
        if (this.active?.controller === controller) { this.active = null; this.changed(); }
      } else if (owned) { this.active = null; this.changed(); }
      this.drainQueuedPrompts();
    }
  }

  private async continueTask(backendId: StableId, plan: ApprovedPlanExecution | null, taskId: StableId, config: AgentTurnConfigV2, account: TaskAccount, conversationKey: StableId, goal: string, continuationInstruction: string | null): Promise<void> {
    const controller = new AbortController();
    const localSessionId = this.localId(`session:approved-plan:${this.nodeSequence + 1}`);
    const localTurnId = this.localId(`turn:approved-plan:${this.nodeSequence + 1}`);
    const initialProgressNodeId = this.nextNodeId('approved-plan-progress');
    let beginDecision = account.beginTurn();
    if (!beginDecision.allowed && beginDecision.status === 'hard-exceeded') {
      const provenance = Object.freeze({ backendId, sessionId: localSessionId, turnId: localTurnId });
      const continued = await this.awaitBudgetContinuation(beginDecision, provenance, controller.signal);
      if (continued === 'suspended') return;
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
    const project = this.options.projectContext?.() ?? null;
    const request = [
      plan ? approvedPlanRequest(plan, project !== null) : budgetContinuationRequest(goal, project !== null),
      continuationInstruction,
    ].filter((value): value is string => Boolean(value)).join('\n\n');
    const tools = this.modelTools(request);
    await this.prepareKnowledge(project, controller.signal);
    const context = await this.options.runtime.context.prepare({ conversationKey, backendId, taskId, request, tools, project });
    if (this.stopping) { wallTimeBudget.dispose(); return; }
    const playtest = this.playtestTasks.get(taskId);
    if (playtest?.snapshot().phase === 'repairing') playtest.advance('editing');
    this.updateTaskRun(taskId, { status: 'running', phase: playtest?.snapshot().phase ?? (plan ? 'editing' : 'planning'), terminalDiagnostic: null, resumable: false }, { phase: playtest?.snapshot().phase ?? 'editing', status: 'active', title: plan ? '继续执行已批准方案' : '继续预算分段', detail: continuationInstruction ?? '从权威项目状态恢复。' });
    this.active = { backendId, taskId, config, tools, providerStarted: false, account, sessionId: null, turnId: null, controller, wallTimeBudget, initialProgressNodeId, localSessionId, localTurnId, approvedPlan: plan, continuationRequested: false, continuationInstruction: null, budgetCheckpoint: null, conversationKey, projectId: project?.projectId ?? null, goal, decisions: plan ? [`Approved plan: ${plan.title}. ${plan.summary}`] : ['User approved continuation after a completed budget checkpoint.'], toolFacts: [], blockers: [], contextCommitted: false, suspendedBarrierId: null };
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
      if (owned?.continuationRequested && owned.suspendedBarrierId === null) {
        await this.continueTask(backendId, owned.approvedPlan, owned.taskId, owned.config, owned.account, owned.conversationKey, owned.goal, owned.continuationInstruction).catch((cause) => this.captureFailure(backendId, cause));
        if (this.active?.controller === controller) { this.active = null; this.changed(); }
      } else if (owned) { this.active = null; this.changed(); }
      this.drainQueuedPrompts();
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
    this.active = { backendId, taskId, config, tools: null, providerStarted: false, account, sessionId, turnId, controller, wallTimeBudget, initialProgressNodeId, localSessionId: sessionId, localTurnId: turnId, approvedPlan: restoredPlan, continuationRequested: false, continuationInstruction: null, budgetCheckpoint: null, conversationKey: conversationKeyFor(project), projectId: project?.projectId ?? null, goal: restoredRun?.requestSummary ?? 'Retry the interrupted visible task.', decisions: [], toolFacts: [], blockers: [], contextCommitted: false, suspendedBarrierId: null };
    this.project(initialProgressNodeId, 'progress', 'pending', Object.freeze({ backendId, sessionId, turnId }), Object.freeze({
      label: '正在恢复任务', message: 'Agent 正在恢复上次任务的上下文。', phase: 'awaiting-first-step',
    }));
    try {
      if (!resumeDecision.allowed && resumeDecision.status === 'hard-exceeded') {
        const continued = await this.awaitBudgetContinuation(resumeDecision, Object.freeze({ backendId, sessionId, turnId }), controller.signal);
        if (continued === 'suspended') return;
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
      this.drainQueuedPrompts();
    }
  }

  private async consume(backendId: StableId, stream: AsyncIterable<AgentBackendEvent>, signal: AbortSignal): Promise<void> {
    const backend = this.options.runtime.registry.get(backendId);
    let batch: ActiveToolBatch | null = null;
    let lastCoordinates: Readonly<{ sessionId: StableId; turnId: StableId }> | null = null;
    let streamFailed = false;
    try {
      for await (const event of stream) {
        lastCoordinates = Object.freeze({ sessionId: event.sessionId, turnId: event.turnId });
        await this.ensureSessionTurnStarted(event);
        if (signal.aborted && event.kind !== 'usage' && event.kind !== 'completed') continue;
        if (this.active) {
          if (event.kind === 'status' && event.payload.status === 'running') this.active.providerStarted = true;
          this.active.sessionId = event.sessionId; this.active.turnId = event.turnId;
          this.updateTaskRun(this.active.taskId, { sessionId: event.sessionId, turnId: event.turnId });
          const model = typeof event.payload.model === 'string' ? event.payload.model : this.active.config.model;
          this.active.account.bindTurn(event.turnId, { provider: backend.descriptor.kind === 'harness-api-key' ? 'deepseek' : 'openai', model, billingMode: backend.descriptor.kind === 'harness-api-key' ? 'api' : 'subscription' });
          if (this.active.approvedPlan) this.approvedPlanTurns.add(turnKey(event.sessionId, event.turnId));
        }
        if (!signal.aborted && event.kind === 'tool-request') {
          if (!batch || batch.sessionId !== event.sessionId || batch.turnId !== event.turnId) {
            if (batch) await this.drainToolBatch(batch);
            batch = this.createToolBatch(backend, event, signal);
          }
          this.enqueueTool(batch, event, signal);
          continue;
        }
        if (batch) { await this.drainToolBatch(batch); batch = null; }
        if (!signal.aborted) await this.captureEvent(backend, event, signal);
        else if (event.kind === 'completed') await this.commitContext(event, terminalStatus(event.payload.status));
        if (event.kind === 'completed') await this.finalizeSessionTurn(event.sessionId, event.turnId, terminalStatus(event.payload.status));
        if ((event.kind === 'usage' || event.kind === 'completed') && this.active) { await this.recordTaskAccounting(this.active.account, event.sessionId, event.turnId); this.changed(); }
      }
    } catch (cause) {
      streamFailed = true;
      throw cause;
    } finally {
      try {
        if (batch) await this.drainToolBatch(batch);
      } catch (cause) {
        if (!streamFailed) throw cause;
        await this.options.operationLog.append({ kind: 'conversation/batch-cleanup-failed', severity: 'error', source: asStableId('studio.conversation-host'), correlation: lastCoordinates ?? {}, payload: { code: errorCode(cause), message: errorMessage(cause) } }).catch(() => undefined);
      } finally {
        if (lastCoordinates && !this.finalizedSessionTurns.has(turnKey(lastCoordinates.sessionId, lastCoordinates.turnId))) await this.finalizeSessionTurn(lastCoordinates.sessionId, lastCoordinates.turnId, 'interrupted').catch(() => undefined);
      }
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
      const text = `${typeof previous?.content.text === 'string' ? previous.content.text : ''}${typeof event.payload.delta === 'string' ? event.payload.delta : ''}`;
      this.project(id, 'text', event.payload.status === 'completed' ? 'completed' : 'streaming', provenance, Object.freeze({ text, role: 'assistant' }));
      return;
    }
    if (event.kind === 'question') {
      const backendNodeId = stablePayloadId(event.payload.nodeId, 'question node');
      const nodeId = this.nextNodeId('question');
      const options = questionOptions(event.payload.questions);
      await this.requestQuestionBarrier({ sessionId: event.sessionId, turnId: event.turnId, nodeId, kind: 'backend-question', reason: 'The Agent needs clarification before continuing.', scopeDigest: sha256(canonicalStringify(event.payload)) });
      if (this.active) this.updateTaskRun(this.active.taskId, { status: 'waiting-user', resumable: true }, { phase: this.taskRuns.get(this.active.taskId)?.phase ?? 'planning', status: 'warning', title: '等待用户补充', detail: 'Agent 需要澄清后才能继续。', turnId: event.turnId });
      if (this.durableBarrierMode()) {
        this.project(nodeId, 'question', 'pending', provenance, Object.freeze({ prompt: 'The Agent needs clarification before continuing.', options, allowFreeform: true, multiple: false, backendNodeId }));
        if (this.active) this.active.suspendedBarrierId = nodeId;
        await this.options.runtime.turns.cancel(event.backendId, event.sessionId, event.turnId).catch(() => undefined);
        return;
      }
      const releaseHumanWait = this.pauseForHumanInteraction(event.sessionId, event.turnId);
      const abort = (): void => {
        const pending = this.questions.get(nodeId); if (!pending) return;
        this.questions.delete(nodeId); pending.releaseHumanWait(); this.finishNode(nodeId, 'cancelled');
        void this.resolveQuestionBarrier(pending, Object.freeze({}), 'cancelled').catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.questions.set(nodeId, Object.freeze({ kind: 'backend', backend, nodeId, backendNodeId, sessionId: event.sessionId, turnId: event.turnId, releaseHumanWait, detachAbort: () => signal.removeEventListener('abort', abort) }));
      this.project(nodeId, 'question', 'pending', provenance, Object.freeze({ prompt: 'The Agent needs clarification before continuing.', options, allowFreeform: true, multiple: false }));
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
      if (this.active?.suspendedBarrierId) {
        await this.options.operationLog.append({ kind: 'conversation/barrier-provider-released', severity: 'info', source: asStableId('studio.conversation-host'), correlation: { sessionId: event.sessionId, turnId: event.turnId }, payload: { barrierId: this.active.suspendedBarrierId, terminalStatus: status, providerActiveCalls: 0 } }).catch(() => undefined);
        return;
      }
      const checkpoint = this.active?.budgetCheckpoint;
      if (checkpoint && this.active) {
        const active = this.active;
        const continued = await this.awaitBudgetContinuation(active.account.snapshot().budgetDecision, provenance, signal);
        if (continued === 'suspended') return;
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

  private createToolBatch(backend: AgentBackend, event: AgentBackendEvent, signal: AbortSignal): ActiveToolBatch {
    this.toolBatchSequence += 1;
    const id = asStableId(`batch:${event.turnId}:${this.toolBatchSequence}`);
    const contexts = new Map<StableId, ToolExecutionContext>();
    const scheduler = new RollingToolBatchScheduler<HostToolWork>({
      maxNodes: 64, maxConcurrency: 4, maxWallTimeMs: 60_000, signal,
      cancelled: (node, diagnostic) => Object.freeze({ status: 'cancelled', value: this.cancelledToolBody(contexts.get(asStableId(node.id)), diagnostic) }),
    });
    const batch: ActiveToolBatch = { id, backend, sessionId: event.sessionId, turnId: event.turnId, startedAtMs: Date.now(), calls: [], contexts, bodies: [], scheduler, transactionGroup: null, startTail: Promise.resolve(), commitTail: Promise.resolve(), drain: null, outputBytes: 0 };
    batch.startTail = this.startToolBatchSession(batch);
    return batch;
  }

  private enqueueTool(batch: ActiveToolBatch, event: AgentBackendEvent, signal: AbortSignal): void {
    const toolCallId = stablePayloadId(event.payload.toolCallId, 'tool call');
    let toolId = stablePayloadId(event.payload.toolId, 'tool');
    let args = isRecord(event.payload.arguments) ? event.payload.arguments as JsonObject : Object.freeze({});
    let toolVersion = typeof event.payload.toolVersion === 'string' ? event.payload.toolVersion : '1.0.0';
    const invokedVia = toolId === MODEL_TOOL_INVOKE_DEFINITION.id ? toolId : null;
    let invocationError: ToolExecutionContext['invocationError'];
    if (invokedVia) {
      // Classify the target, so deferred edits keep their own effect locks and approval barriers.
      try {
        const target = resolveModelToolInvocation(event.payload.arguments, this.options.tools.definitions());
        toolId = target.toolId; toolVersion = target.toolVersion; args = target.arguments;
      }
      catch (cause) { invocationError = Object.freeze({ code: errorCode(cause), message: errorMessage(cause) }); args = Object.freeze({}); }
    }
    const call: LegacyToolRequest = Object.freeze({ toolCallId, toolId, toolVersion, arguments: args,
      ...(Array.isArray(event.payload.dependsOn) ? { dependsOn: Object.freeze(event.payload.dependsOn.filter((item): item is string => typeof item === 'string')) } : {}),
      ...(event.payload.outputProjection === 'summary' || event.payload.outputProjection === 'digest-only' ? { outputProjection: event.payload.outputProjection } : {}),
      ...(event.payload.onFailure === 'stop-batch' ? { onFailure: 'stop-batch' as const } : {}),
    });
    batch.calls.push(call);
    const request = normalizeToolBatchRequest({ id: batch.id, sessionId: batch.sessionId, turnId: batch.turnId, calls: batch.calls, maxConcurrency: 4, maxResultBytes: 1024 * 1024 }, this.options.tools.definitions());
    const node = request.nodes.at(-1)!;
    const provenance = Object.freeze({ backendId: event.backendId, sessionId: event.sessionId, turnId: event.turnId, stepId: toolCallId });
    const toolNodeId = this.nextNodeId('tool-call');
    const context: ToolExecutionContext = Object.freeze({ backend: batch.backend, event, toolCallId, toolId, args, provenance, toolNodeId, node, ...(invocationError ? { invocationError } : {}) });
    batch.contexts.set(asStableId(node.id), context);
    this.project(toolNodeId, 'tool-call', 'pending', provenance, Object.freeze({ toolCallId, toolId, executionClass: node.executionClass, argumentsSummary: toolArgumentSummary(toolId, args), ...(this.options.recordProjectId ? { parameters: args } : {}) }));
    const dispatched = batch.startTail.then(async () => {
      const handle = await this.ensureDurableSession(batch.sessionId);
      await handle.append({ kind: 'tool-batch.planned', turnId: batch.turnId, batchId: batch.id, nodeId: node.id, dependsOn: node.dependsOn, projectRevision: this.options.projectContext?.()?.revision ?? null,
        payload: Object.freeze({ profile: 'tool-node-plan/1', toolCallId, toolId, toolVersion: node.toolVersion, executionClass: node.executionClass, effects: node.effects, effectKeys: node.effectKeys, expectedRevision: node.expectedRevision }) });
      await this.appendToolSessionOp(batch, context, 'tool.started', Object.freeze({ toolCallId, toolId, toolVersion: node.toolVersion, executionClass: node.executionClass, effects: node.effects, effectKeys: node.effectKeys, expectedRevision: node.expectedRevision, ...(invokedVia ? { invokedVia } : {}) }));
    });
    batch.startTail = dispatched;
    const transactionEligible = node.executionClass === 'exclusive-mutation' && typeof this.options.tools.executeTransaction === 'function';
    let group: BatchTransactionGroup | null = null;
    let precedingTransaction: Promise<ReadonlyMap<StableId, HostToolBody>> | null = null;
    if (transactionEligible) {
      group = batch.transactionGroup ?? { id: asStableId(`transaction-group:${batch.id}:${batch.calls.length}`), entries: [], flush: null };
      batch.transactionGroup = group;
    } else if (batch.transactionGroup) {
      precedingTransaction = this.flushTransactionGroup(batch, batch.transactionGroup, signal);
      batch.transactionGroup = null;
    }
    const work = batch.scheduler.enqueue(node, async (batchSignal): Promise<RollingToolWorkResult<HostToolWork>> => {
      await dispatched;
      if (precedingTransaction) await precedingTransaction;
      if (batchSignal.aborted) return Object.freeze({ status: 'cancelled', value: this.cancelledToolBody(context, Object.freeze({ code: 'tool-batch.cancelled', message: 'Tool batch was cancelled before execution.', retryable: true })) });
      if (group) {
        const prepared = await this.prepareMutationWork(context, group, batchSignal);
        return Object.freeze({ status: isPreparedMutationWork(prepared) ? 'completed' : prepared.status, value: prepared });
      }
      const body = await this.executeToolBody(context, batchSignal);
      return Object.freeze({ status: body.status, value: body });
    });
    if (group) group.entries.push(Object.freeze({ context, work }));
    batch.commitTail = batch.commitTail.then(async () => {
      // The scheduler can cancel a queued node without running its body/start await.
      await dispatched;
      const value = (await work).value;
      const body = isPreparedMutationWork(value) ? (await this.flushTransactionGroup(batch, value.group, signal)).get(asStableId(context.node.id)) ?? this.cancelledToolBody(context, Object.freeze({ code: 'scene-transaction.result-missing', message: 'Scene transaction did not produce a member result.', retryable: false }), Date.now() - value.startedAtMs, 'failed') : value;
      const committed = await this.commitToolBody(batch, context, body, signal);
      batch.bodies.push(committed);
    });
  }

  private drainToolBatch(batch: ActiveToolBatch): Promise<void> {
    return batch.drain ??= this.finishToolBatch(batch);
  }

  private async finishToolBatch(batch: ActiveToolBatch): Promise<void> {
    const pendingTransaction = batch.transactionGroup ? this.flushTransactionGroup(batch, batch.transactionGroup) : null;
    batch.transactionGroup = null;
    await batch.scheduler.drain();
    await pendingTransaction;
    // Even a rejected first request owns an asynchronously started, empty batch.
    await batch.startTail;
    await batch.commitTail;
    const completed = batch.bodies.filter((body) => body.status === 'completed').length;
    const failed = batch.bodies.filter((body) => body.status === 'failed').length;
    const cancelled = batch.bodies.length - completed - failed;
    const resultDigest = sha256(canonicalStringify(batch.bodies.map((body, index) => ({ nodeId: batch.calls[index]?.toolCallId ?? `missing:${index}`, status: body.status, result: body.backendResult })) as unknown as JsonValue));
    const handle = await this.ensureDurableSession(batch.sessionId);
    await handle.append({ kind: 'tool-batch.completed', turnId: batch.turnId, batchId: batch.id, projectRevision: this.options.projectContext?.()?.revision ?? null,
      payload: Object.freeze({ status: failed > 0 ? 'failed' : cancelled > 0 ? 'cancelled' : 'completed', nodeCount: batch.bodies.length, completed, failed, cancelled, outputBytes: batch.outputBytes, wallTimeMs: Math.max(0, Date.now() - batch.startedAtMs), resultDigest }) });
    await this.options.operationLog.append({ kind: 'agent/tool-batch-completed', severity: failed > 0 ? 'warning' : 'info', source: asStableId('studio.conversation-host'), correlation: { sessionId: batch.sessionId, turnId: batch.turnId }, payload: { batchId: batch.id, nodeCount: batch.bodies.length, completed, failed, cancelled, outputBytes: batch.outputBytes, resultDigest } });
  }

  private async startToolBatchSession(batch: ActiveToolBatch): Promise<void> {
    const handle = await this.ensureDurableSession(batch.sessionId);
    const limits = Object.freeze({ maxNodes: 64, maxConcurrency: 4, maxWallTimeMs: 60_000, maxOutputBytes: 1024 * 1024, maxRepairRounds: 3 });
    await handle.append({ kind: 'tool-batch.planned', turnId: batch.turnId, batchId: batch.id, projectRevision: this.options.projectContext?.()?.revision ?? null, payload: Object.freeze({ limits, protocol: 'plan-tool-batch-check', source: 'stream-normalization' }) });
    await handle.append({ kind: 'tool-batch.started', turnId: batch.turnId, batchId: batch.id, projectRevision: this.options.projectContext?.()?.revision ?? null, payload: Object.freeze({ limits }) });
  }

  private async appendToolSessionOp(batch: ActiveToolBatch, context: ToolExecutionContext, kind: 'tool.started' | 'tool.completed' | 'tool.outcome-unknown', payload: JsonObject): Promise<void> {
    const handle = await this.ensureDurableSession(batch.sessionId);
    await handle.append({ kind, turnId: batch.turnId, batchId: batch.id, nodeId: context.node.id, dependsOn: context.node.dependsOn, projectRevision: this.options.projectContext?.()?.revision ?? null, payload });
  }

  private ensureDurableSession(sessionId: StableId): Promise<DurableSessionHandle> {
    const existing = this.durableSessions.get(sessionId); if (existing) return existing;
    const sessions = this.options.runtime.sessions;
    if (!sessions) {
      const compatibility = Promise.resolve(Object.freeze({ id: sessionId, async append() { return undefined; }, async checkpoint() { return undefined; }, async dispose() {} }) as unknown as DurableSessionHandle);
      this.durableSessions.set(sessionId, compatibility); return compatibility;
    }
    const pending = sessions.open(sessionId, { repairOpenOperations: false }).then(async (handle) => {
      await this.options.sessionRecovery?.recover(handle);
      if (!isCompleteDurableSessionHandle(handle)) return handle;
      const observed = this.observeDurableSession(handle); await observed.snapshot(); return observed;
    }).catch(async (cause) => {
      if (!isRecord(cause) || cause.code !== 'session.not-found') throw cause;
      const project = this.options.projectContext?.() ?? null;
      const handle = await sessions.create({ id: sessionId, projectId: project?.projectId ?? null, documentId: project?.documentId ?? null, activeGoal: this.active?.goal ?? null, taskBudgetId: this.active?.account.options.budget.id ?? null });
      if (!isCompleteDurableSessionHandle(handle)) return handle;
      const observed = this.observeDurableSession(handle); await observed.snapshot(); return observed;
    });
    this.durableSessions.set(sessionId, pending);
    return pending;
  }

  private observeDurableSession(handle: DurableSessionHandle): DurableSessionHandle {
    const capture = (snapshot: SessionReplaySnapshotV1): SessionReplaySnapshotV1 => { this.captureGraphSnapshot(snapshot); return snapshot; };
    return Object.freeze({
      id: handle.id,
      snapshot: async () => capture(await handle.snapshot()),
      append: async (input: Parameters<DurableSessionHandle['append']>[0]) => capture(await handle.append(input)),
      appendMessage: async (input: Parameters<DurableSessionHandle['appendMessage']>[0]) => capture(await handle.appendMessage(input)),
      replaceSurface: async (input: Parameters<DurableSessionHandle['replaceSurface']>[0]) => capture(await handle.replaceSurface(input)),
      bindBackend: async (binding: Parameters<DurableSessionHandle['bindBackend']>[0]) => capture(await handle.bindBackend(binding)),
      checkpoint: async () => capture(await handle.checkpoint()),
      fork: async (input: Parameters<DurableSessionHandle['fork']>[0]) => { const forked = this.observeDurableSession(await handle.fork(input)); this.durableSessions.set(forked.id as StableId, Promise.resolve(forked)); await forked.snapshot(); return forked; },
      flush: () => handle.flush(),
      dispose: () => handle.dispose(),
    });
  }

  private captureGraphSnapshot(snapshot: SessionReplaySnapshotV1, immediate = false): void {
    if (this.disposed) return;
    const id = snapshot.session.id as StableId;
    const sequence = snapshot.ops.at(-1)?.sequence ?? -1;
    const pendingSequence = this.pendingGraphSnapshots.get(id)?.ops.at(-1)?.sequence ?? -1;
    const displayedSequence = this.executionGraphs.get(id)?.throughSequence ?? -1;
    if (sequence < Math.max(pendingSequence, displayedSequence)) return;
    this.pendingGraphSnapshots.set(id, snapshot);
    if (immediate) { this.flushGraphProjections(); return; }
    if (this.graphProjectionTimer) return;
    this.graphProjectionTimer = setTimeout(() => { this.graphProjectionTimer = null; this.flushGraphProjections(); }, 16);
  }

  private flushGraphProjections(): void {
    if (this.disposed || this.pendingGraphSnapshots.size === 0) return;
    let changed = false;
    for (const [sessionId, snapshot] of this.pendingGraphSnapshots) {
      const graph = projectExecutionGraph({ sessionId, activeGoal: snapshot.session.activeGoal, status: snapshot.session.status, ops: snapshot.ops, transcript: snapshot.transcript });
      if (this.executionGraphs.get(sessionId)?.digest !== graph.digest) { this.executionGraphs.set(sessionId, graph); changed = true; }
    }
    this.pendingGraphSnapshots.clear();
    if (changed) this.changed();
  }

  private async restoreExecutionGraphs(): Promise<void> {
    const sessions = this.options.runtime.sessions;
    if (!sessions) return;
    const candidates = new Map(this.restoredGraphSessions);
    const remember = (id: StableId, timestamp: string): void => { if (timestamp > (candidates.get(id) ?? '')) candidates.set(id, timestamp); };
    for (const run of this.taskRuns.values()) if (run.sessionId) remember(run.sessionId, run.updatedAt);
    for (const node of this.nodes.values()) remember(node.provenance.sessionId, node.createdAt);
    const ids = [...candidates].sort((left, right) => right[1].localeCompare(left[1]) || right[0].localeCompare(left[0])).slice(0, 50).map(([id]) => id);
    for (const sessionId of ids) {
      try {
        const existing = this.durableSessions.get(sessionId);
        const base = existing ? await existing : await sessions.open(sessionId, { repairOpenOperations: false });
        if (!isCompleteDurableSessionHandle(base)) continue;
        const observed = existing ? base : this.observeDurableSession(base); this.durableSessions.set(sessionId, Promise.resolve(observed));
        this.captureGraphSnapshot(await observed.snapshot(), true);
      } catch { /* Legacy task projections without a durable M13 session remain available through the Transcript fallback. */ }
    }
  }

  private async migrateLegacySessions(): Promise<void> {
    const sessions = this.options.runtime.sessions;
    if (!sessions || !this.projectionPersistenceAvailable()) return;
    const result = await migrateLegacySessions({
      sessions,
      operationLog: this.options.operationLog,
      nodes: Object.freeze([...this.nodes.values()]),
      taskRuns: Object.freeze([...this.taskRuns.values()]),
      project: this.options.projectContext?.() ?? null,
    });
    if (result.migrated.length || result.resumed.length || result.failed.length) await this.options.operationLog.append({
      kind: 'conversation/legacy-session-migration',
      severity: result.failed.length ? 'warning' : 'info',
      source: asStableId('studio.conversation-host'),
      correlation: {},
      payload: {
        migratedSessionIds: result.migrated,
        resumedSessionIds: result.resumed,
        alreadyDurableCount: result.alreadyDurable.length,
        failures: result.failed,
        mutationReplayCount: 0,
      },
    }).catch(() => undefined);
  }

  private async ensureSessionTurnStarted(event: AgentBackendEvent): Promise<void> {
    const key = turnKey(event.sessionId, event.turnId);
    if (this.initializedSessionTurns.has(key)) return;
    const handle = await this.ensureDurableSession(event.sessionId);
    if (isCompleteDurableSessionHandle(handle)) {
      let snapshot = await handle.snapshot();
      if (!snapshot.recovery.openTurnIds.includes(event.turnId)) {
        const prior = snapshot.ops.filter((op) => op.turnId === event.turnId && op.kind === 'turn.completed').at(-1);
        await handle.append({ kind: 'turn.started', turnId: event.turnId, projectRevision: this.options.projectContext?.()?.revision ?? null, ...(prior ? { dependsOn: [prior.id] } : {}), payload: { status: 'running', ...(prior ? { resumedFrom: prior.id } : {}), taskId: this.active?.taskId ?? null } });
        const content = this.active?.continuationInstruction ?? this.active?.goal;
        if (content) await handle.appendMessage({ role: 'user', content, turnId: event.turnId, projectRevision: this.options.projectContext?.()?.revision ?? null });
        snapshot = await handle.snapshot();
      }
      await this.ensureBackendSessionBinding(event, handle, snapshot);
      await this.captureSessionContextFrame(event);
    } else await handle.append({ kind: 'turn.started', turnId: event.turnId, projectRevision: this.options.projectContext?.()?.revision ?? null, payload: { status: 'running' } });
    this.initializedSessionTurns.add(key);
  }

  private async ensureBackendSessionBinding(event: AgentBackendEvent, handle: DurableSessionHandle, snapshot: SessionReplaySnapshotV1): Promise<void> {
    if (snapshot.session.backendBindings.some((binding) => binding.backendId === event.backendId && binding.status === 'active')) return;
    const backend = this.options.runtime.registry.get(event.backendId);
    if (!isBackendSessionAdapter(backend)) return;
    const model = typeof event.payload.model === 'string' ? event.payload.model : this.active?.config.model ?? this.backendSelections.get(event.backendId)?.model;
    if (!model) return;
    const capabilities = await backend.capabilities(model).catch(() => null);
    if (!capabilities) return;
    await handle.bindBackend({
      bindingId: asStableId(`binding:${event.backendId}:${event.sessionId}`), backendId: event.backendId, provider: backend.provider, model,
      remoteSessionId: event.sessionId, generation: 1, status: 'active',
      capabilities: Object.freeze({ maxInputTokens: capabilities.maxInputTokens, nativeCompaction: capabilities.nativeCompaction, parallelToolCalls: capabilities.parallelToolCalls, codeMode: capabilities.codeMode, providerUsage: capabilities.providerUsage, providerCache: capabilities.providerCache }),
      lastConfirmedOpId: snapshot.ops.at(-1)?.id ?? null,
    });
  }

  private async captureSessionContextFrame(event: AgentBackendEvent): Promise<void> {
    const key = turnKey(event.sessionId, event.turnId);
    if (this.capturedContextTurns.has(key)) return;
    const frames = this.options.runtime.modelContexts?.frames;
    if (!frames) return;
    const snapshot = await this.options.runtime.sessions.replay(event.sessionId);
    const binding = [...snapshot.session.backendBindings].reverse().find((item) => item.backendId === event.backendId && item.status === 'active');
    if (!binding) return;
    try {
      await frames.capture({
        sessionId: event.sessionId,
        turnId: event.turnId,
        backendBindingId: binding.bindingId,
        projectRevision: this.options.projectContext?.()?.revision ?? null,
        reservedOutputTokens: this.active?.config.outputTokenLimit ?? 8_192,
        reservedSafetyTokens: 4_096,
      });
      this.capturedContextTurns.add(key);
    } catch (cause) {
      await this.options.operationLog.append({
        kind: 'conversation/context-frame-unavailable',
        severity: 'warning',
        source: asStableId('studio.conversation-host'),
        correlation: { sessionId: event.sessionId, turnId: event.turnId },
        payload: { code: 'context.frame-unavailable', message: cause instanceof Error ? cause.message.slice(0, 1_000) : 'Context pressure could not be measured.' },
      }).catch(() => undefined);
    }
  }

  private async requestManualCompaction(sessionId: StableId, requestId: StableId, signal?: AbortSignal): Promise<void> {
    const existing = this.manualCompactionRequests.get(requestId);
    if (existing) { await existing; return; }
    const operation = this.resumeOrRunManualCompaction(sessionId, requestId, signal);
    this.manualCompactionRequests.set(requestId, operation);
    try { await operation; }
    catch (cause) { this.manualCompactionRequests.delete(requestId); throw cause; }
  }

  private async resumeOrRunManualCompaction(sessionId: StableId, requestId: StableId, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    const completed = await this.options.operationLog.query({ kinds: ['conversation/manual-compaction-finished'], sessionId, limit: 200, traverseCorrelation: false });
    if (completed.events.some((event) => event.payload.requestId === requestId && event.payload.status === 'completed')) return;
    await this.runManualCompaction(sessionId, requestId, signal);
  }

  private async runManualCompaction(sessionId: StableId, requestId: StableId, signal?: AbortSignal): Promise<void> {
    if (this.active?.sessionId === sessionId) throw new Error('Wait for the active Agent turn to reach a safe boundary before compacting.');
    const handle = await this.ensureDurableSession(sessionId);
    if (!isCompleteDurableSessionHandle(handle)) throw new Error('This legacy conversation has no durable Model Surface to compact.');
    const snapshot = await handle.snapshot();
    if (snapshot.recovery.openTurnIds.length || snapshot.recovery.openToolNodeIds.length || snapshot.recovery.openBatchIds.length || snapshot.recovery.unresolvedBarrierIds.length) throw new Error('Resolve the current tool, approval or question before compacting.');
    const binding = [...snapshot.session.backendBindings].reverse().find((item) => item.status === 'active');
    if (!binding) throw new Error('No model-aware Backend Session binding is available for compaction.');
    let compactor = this.manualCompactors.get(sessionId);
    if (!compactor) {
      const fallback = async (request: CompactionSummaryRequestV1): Promise<Readonly<{ summary: string }>> => Object.freeze({ summary: localCompactionSummary(request) });
      const summarizer = this.options.runtime.backendSessions.compactionSummarizer(sessionId, binding.bindingId, fallback);
      compactor = this.options.runtime.modelContexts.createCompactor(summarizer);
      this.manualCompactors.set(sessionId, compactor);
    }
    await this.options.operationLog.append({ kind: 'conversation/manual-compaction-requested', severity: 'info', source: asStableId('studio.conversation-host'), correlation: { sessionId }, payload: { requestId, surfaceGeneration: snapshot.surface.generation, surfaceDigest: snapshot.surface.digest } }, { signal });
    const task = [...this.taskRuns.values()].find((run) => run.sessionId === sessionId);
    const result = await compactor.compact(sessionId, {
      reason: 'manual', backendBindingId: binding.bindingId,
      reservedOutputTokens: task?.model.outputTokenLimit ?? 8_192, reservedSafetyTokens: 4_096,
      pinnedFacts: Object.freeze([
        ...(snapshot.session.activeGoal ? [{ kind: 'active-goal' as const, content: snapshot.session.activeGoal }] : []),
        ...(task ? task.acceptance.map((item) => ({ kind: 'acceptance' as const, content: `${item.label}: ${item.assertion} [${item.status}]`, artifactRefs: item.evidenceIds })) : []),
        ...(task?.documentRevision === null || task?.documentRevision === undefined ? [] : [{ kind: 'project-revision' as const, content: `Current project revision is r${task.documentRevision}.`, projectRevision: task.documentRevision }]),
      ]),
      signal,
    });
    this.captureGraphSnapshot(await handle.snapshot(), true);
    await this.options.operationLog.append({ kind: 'conversation/manual-compaction-finished', severity: result.status === 'failed' ? 'error' : result.status === 'deferred' ? 'warning' : 'info', source: asStableId('studio.conversation-host'), correlation: { sessionId }, payload: { requestId, status: result.status, compactionId: result.compactionId, decision: result.preview.decision, beforeRatio: result.preview.pressure.ratio, afterRatio: result.record?.after?.ratio ?? null } }, { signal });
    if (result.status !== 'completed') throw new Error(`Context compaction ${result.status}: ${result.preview.decision}.`);
  }

  private async finalizeSessionTurn(sessionId: StableId, turnId: StableId, status: 'completed' | 'cancelled' | 'failed' | 'interrupted'): Promise<void> {
    const key = turnKey(sessionId, turnId);
    if (this.finalizedSessionTurns.has(key)) return;
    const handle = await this.ensureDurableSession(sessionId);
    const textNode = this.nodes.get(this.internalNodeId('text', turnId));
    const text = typeof textNode?.content.text === 'string' ? textNode.content.text.trim() : '';
    if (text && typeof handle.appendMessage === 'function') await handle.appendMessage({ role: 'assistant', content: text, turnId, projectRevision: this.options.projectContext?.()?.revision ?? null });
    await handle.append({ kind: 'turn.completed', turnId, projectRevision: this.options.projectContext?.()?.revision ?? null, payload: { status, summary: completionSummary(status, this.active?.toolFacts ?? [], this.active?.blockers ?? []) } });
    if (typeof handle.checkpoint === 'function') await handle.checkpoint();
    this.finalizedSessionTurns.add(key);
  }

  private async requestApprovalBarrier(preparation: GameToolPreparation, approval: GameToolApproval, nodeId: StableId): Promise<void> {
    const handle = await this.ensureDurableSession(preparation.sessionId);
    await handle.append({
      kind: 'approval.requested', turnId: preparation.turnId, nodeId, projectRevision: preparation.baseRevision,
      payload: {
        approvalId: approval.approvalId, barrierKind: approval.effect === 'trusted-code' ? 'trusted-script' : approval.effect === 'runtime-start' ? 'runtime-start' : 'tool-approval',
        toolCallId: approval.toolCallId, toolId: approval.toolId, toolVersion: approval.toolVersion, effect: approval.effect, risk: approval.risk,
        documentId: approval.documentId, baseRevision: approval.baseRevision, scopeDigest: approval.argumentsDigest,
        previewDigest: approval.previewDigest, reason: approval.target.slice(0, 2_048), resumeTokenDigest: sha256(`${preparation.id}:${approval.approvalId}:${approval.argumentsDigest}`), expiresAt: null,
      },
    });
    await handle.checkpoint();
  }

  private async resolveApprovalBarrier(pending: PendingApproval, decision: GameToolApprovalResolution): Promise<void> {
    const handle = await this.ensureDurableSession(pending.sessionId);
    await handle.append({
      kind: 'approval.resolved', turnId: pending.turnId, nodeId: pending.nodeId, projectRevision: this.options.projectContext?.()?.revision ?? pending.preparation.baseRevision,
      payload: { approvalId: pending.approval.approvalId, resolution: decision, denied: decision === 'reject' || decision === 'cancel', resolvedBy: 'user' },
    });
    await handle.checkpoint();
  }

  private async requestQuestionBarrier(input: Readonly<{ sessionId: StableId; turnId: StableId; nodeId: StableId; kind: string; reason: string; scopeDigest: string }>): Promise<void> {
    const handle = await this.ensureDurableSession(input.sessionId);
    await handle.append({
      kind: 'question.requested', turnId: input.turnId, nodeId: input.nodeId, projectRevision: this.options.projectContext?.()?.revision ?? null,
      payload: { questionId: input.nodeId, barrierKind: input.kind, reason: input.reason.slice(0, 2_048), scopeDigest: input.scopeDigest, resumeTokenDigest: sha256(`${input.sessionId}:${input.turnId}:${input.nodeId}:${input.scopeDigest}`), expiresAt: null },
    });
    await handle.checkpoint();
  }

  private async resolveQuestionBarrier(pending: PendingQuestion, answer: JsonObject, resolution: 'answered' | 'cancelled'): Promise<void> {
    const handle = await this.ensureDurableSession(pending.sessionId);
    await handle.append({
      kind: 'question.resolved', turnId: pending.turnId, nodeId: pending.nodeId, projectRevision: this.options.projectContext?.()?.revision ?? null,
      payload: { questionId: pending.nodeId, resolution, answerDigest: sha256(canonicalStringify(answer)) },
    });
    await handle.checkpoint();
  }

  private async resolvePlanBarrier(sessionId: StableId, turnId: StableId, nodeId: StableId, resolution: 'answered' | 'cancelled', answer: JsonObject): Promise<void> {
    const handle = await this.ensureDurableSession(sessionId);
    await handle.append({
      kind: 'question.resolved', turnId, nodeId, projectRevision: this.options.projectContext?.()?.revision ?? null,
      payload: { questionId: nodeId, resolution, answerDigest: sha256(canonicalStringify(answer)) },
    });
    await handle.checkpoint();
  }

  private async prepareMutationWork(context: ToolExecutionContext, group: BatchTransactionGroup, signal: AbortSignal): Promise<PreparedMutationWork | HostToolBody> {
    const { event, toolCallId, toolId, provenance } = context;
    const account = this.active?.account; const startedAtMs = Date.now(); let stage: 'budget' | 'workflow' | 'prepare' | 'approval' = 'budget';
    try {
      if (!account) throw new Error('Task accounting is unavailable for this tool call.');
      if (this.active?.budgetCheckpoint) return this.cancelledToolBody(context, Object.freeze({ code: 'budget.turn-stopping', message: 'This turn is already stopping at a safe budget checkpoint. Retry in the continuation turn.', retryable: true }), Date.now() - startedAtMs);
      const preflight = account.preflightTool(toolCallId);
      if (!preflight.allowed && preflight.status === 'hard-exceeded') {
        const summary = toolArgumentSummary(toolId, context.args);
        if (this.active) { this.active.budgetCheckpoint = Object.freeze({ toolId, summary }); this.active.decisions.push(`Budget checkpoint reached before ${toolId}; the pending Scene transaction was not committed.`); }
        return this.cancelledToolBody(context, Object.freeze({ code: 'budget.continuation-required', message: 'Studio reached a safe budget checkpoint before this transaction member. Completed project changes remain committed.', retryable: true }), Date.now() - startedAtMs);
      }
      if (preflight.status === 'soft-exceeded') this.project(this.nextNodeId('diagnostic'), 'diagnostic', 'completed', provenance, Object.freeze({ code: 'budget.soft-warning', message: preflight.warning ?? 'Soft task budget is exceeded; execution is continuing.', severity: 'warning', retryable: false }));
      assertBudgetAllowed(preflight); assertBudgetAllowed(account.commitTool(toolCallId));
      const definition = this.options.tools.definitions().find((item) => item.id === toolId);
      if (!definition || definition.effect !== 'reversible-edit') throw new Error(`Tool ${toolId} is not eligible for a Scene transaction.`);
      if (!this.approvedPlanTurns.has(turnKey(event.sessionId, event.turnId))) throw new PlanProtocolError('plan.approval-required', 'Submit studio.plan.propose and wait for user confirmation before mutating the project.');
      stage = 'workflow';
      if (this.active) this.beforeProductTool(this.active.taskId, toolId, context.args, event.turnId, toolCallId);
      stage = 'prepare';
      const preparation = await this.options.tools.prepare({ schemaVersion: 1, id: toolCallId, sessionId: event.sessionId, turnId: event.turnId, ...(this.active?.taskId ? { taskId: this.active.taskId } : {}), toolId, toolVersion: context.node.toolVersion, arguments: context.args }, signal);
      stage = 'approval'; if (preparation.approvalId && await this.awaitApproval(preparation, provenance, signal) === 'suspended') {
        await this.options.tools.cancel(context.toolCallId).catch(() => undefined);
        return this.suspendedToolBody(context, 'tool-approval', Date.now() - startedAtMs);
      }
      return Object.freeze({ kind: 'prepared-mutation', context, preparation, startedAtMs, group });
    } catch (cause) {
      const diagnostic = Object.freeze({ code: errorCode(cause), message: errorMessage(cause) });
      await this.options.operationLog.append({ kind: 'conversation/tool-failed', severity: signal.aborted ? 'warning' : 'error', source: asStableId('studio.conversation-host'), correlation: { sessionId: event.sessionId, turnId: event.turnId, toolCallId }, payload: { toolId, stage, argumentKeys: Object.freeze(Object.keys(context.args).sort()), code: diagnostic.code, message: diagnostic.message } }).catch(() => undefined);
      const status: ToolBatchNodeStatus = signal.aborted ? 'cancelled' : 'failed';
      return this.makeToolBody(context, status, Object.freeze({ status: 'failed', error: diagnostic }), status === 'cancelled' ? 'cancelled' : 'failed', Object.freeze({ toolCallId, toolId, target: 'Current project', effect: context.node.executionClass, argumentsSummary: toolArgumentSummary(toolId, context.args) }), status === 'cancelled' ? 'cancelled' : 'failed', Object.freeze({ toolCallId, toolId, resultStatus: status, summary: diagnostic.message }), null, null, `${toolId}: ${diagnostic.code}`, false, false, Date.now() - startedAtMs);
    }
  }

  private flushTransactionGroup(batch: ActiveToolBatch, group: BatchTransactionGroup, signal?: AbortSignal): Promise<ReadonlyMap<StableId, HostToolBody>> {
    if (group.flush) return group.flush;
    group.flush = (async () => {
      const outcomes = await Promise.all(group.entries.map(async (entry) => (await entry.work).value));
      const bodies = new Map<StableId, HostToolBody>();
      const prepared = outcomes.filter(isPreparedMutationWork);
      const failed = outcomes.filter((value): value is HostToolBody => !isPreparedMutationWork(value));
      if (failed.length > 0 || prepared.length !== group.entries.length) {
        for (let index = 0; index < outcomes.length; index += 1) {
          const value = outcomes[index]!;
          if (!isPreparedMutationWork(value)) bodies.set(asStableId(group.entries[index]!.context.node.id), value);
        }
        for (const value of prepared) {
          await this.options.tools.cancel(value.context.toolCallId).catch(() => undefined);
          bodies.set(asStableId(value.context.node.id), this.cancelledToolBody(value.context, Object.freeze({ code: 'scene-transaction.prepare-failed', message: 'Another Scene transaction member failed preparation; no member was committed.', retryable: true }), Date.now() - value.startedAtMs));
        }
        return bodies;
      }
      try {
        const transaction = await this.options.tools.executeTransaction!({ sessionId: batch.sessionId, turnId: batch.turnId, batchId: batch.id, preparationIds: prepared.map((value) => value.preparation.id) }, signal);
        const byCall = new Map(transaction.results.map((result) => [result.callId, result]));
        for (const value of prepared) {
          const result = byCall.get(value.context.toolCallId);
          bodies.set(asStableId(value.context.node.id), result ? this.toolResultBody(value.context, value.preparation, result, value.startedAtMs) : this.cancelledToolBody(value.context, Object.freeze({ code: 'scene-transaction.result-missing', message: 'Scene transaction omitted a prepared member result.', retryable: false }), Date.now() - value.startedAtMs, 'failed'));
        }
        const handle = await this.ensureDurableSession(batch.sessionId);
        await handle.append({ kind: 'document.committed', turnId: batch.turnId, batchId: batch.id, projectRevision: transaction.afterRevision, artifactRefs: [transaction.receiptArtifactId], payload: { transactionId: transaction.transactionId, idempotencyKey: transaction.idempotencyKey, beforeRevision: transaction.beforeRevision, afterRevision: transaction.afterRevision, receiptDigest: transaction.receiptDigest, receiptArtifactId: transaction.receiptArtifactId, memberNodeIds: prepared.map((value) => value.context.node.id), replayed: transaction.replayed } });
        await handle.checkpoint();
      } catch (cause) {
        for (const value of prepared) bodies.set(asStableId(value.context.node.id), this.cancelledToolBody(value.context, Object.freeze({ code: errorCode(cause), message: errorMessage(cause), retryable: true }), Date.now() - value.startedAtMs, 'failed'));
      }
      return bodies;
    })();
    return group.flush;
  }

  private toolResultBody(context: ToolExecutionContext, preparation: GameToolPreparation, result: GameToolResult, startedAtMs: number): HostToolBody {
    const definition = this.options.tools.definitions().find((item) => item.id === context.toolId);
    const summary = toolResultSummary(context.toolId, result.status, result.value, preparation.preview.summary);
    const status: ToolBatchNodeStatus = result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    const backendResult = Object.freeze({ status: result.status, value: result.value, documentId: result.documentId, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, ...(result.transaction ? { transaction: result.transaction as unknown as JsonValue } : {}) });
    const fact = `${context.toolId}: ${summary} [${result.status}; r${result.beforeRevision}→r${result.afterRevision}${result.historyLabel ? `; History: ${result.historyLabel}` : ''}${result.transaction ? `; transaction: ${result.transaction.transactionId}` : ''}]`;
    return this.makeToolBody(context, status, backendResult, 'completed', Object.freeze({ toolCallId: context.toolCallId, toolId: context.toolId, target: preparation.preview.target, effect: preparation.effect, argumentsSummary: preparation.preview.summary }), status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed', Object.freeze({ toolCallId: context.toolCallId, toolId: context.toolId, resultStatus: result.status, summary, details: boundedJson(result.value), ...(result.transaction ? { transactionId: result.transaction.transactionId } : {}) }), result.value, fact, status === 'failed' ? `${context.toolId}: tool.result-failed` : null, Boolean(definition && definition.effect !== 'observe' && result.status === 'completed'), false, Date.now() - startedAtMs);
  }

  private async executeToolBody(context: ToolExecutionContext, signal: AbortSignal): Promise<HostToolBody> {
    const { event, toolCallId, toolId, provenance } = context;
    let args = context.args;
    const account = this.active?.account;
    const startedAtMs = Date.now();
    let stage: 'budget' | 'workflow' | 'prepare' | 'approval' | 'execute' = 'budget';
    try {
      if (!account) throw new Error('Task accounting is unavailable for this tool call.');
      if (this.active?.budgetCheckpoint) {
        return this.cancelledToolBody(context, Object.freeze({ code: 'budget.turn-stopping', message: 'This turn is already stopping at a safe budget checkpoint. Retry in the continuation turn.', retryable: true }), Date.now() - startedAtMs);
      }
      const preflight = account.preflightTool(toolCallId);
      if (!preflight.allowed && preflight.status === 'hard-exceeded') {
        const summary = toolArgumentSummary(toolId, args);
        if (this.active) { this.active.budgetCheckpoint = Object.freeze({ toolId, summary }); this.active.decisions.push(`Budget checkpoint reached before ${toolId}; release the live backend tool call before waiting for the user.`); }
        const value = Object.freeze({ code: 'budget.continuation-required', preserved: true, retryable: true, message: 'Studio reached a safe budget checkpoint before this tool. Completed project changes remain committed.' });
        return this.makeToolBody(context, 'cancelled', Object.freeze({ status: 'cancelled', value }), 'cancelled', Object.freeze({ toolCallId, toolId, target: 'Current project', effect: 'observe', argumentsSummary: summary }), 'cancelled', Object.freeze({ toolCallId, toolId, resultStatus: 'cancelled', summary: '已到达预算检查点；已完成修改均已保留。', details: boundedJson(value) }), value, `${toolId}: deferred at a safe budget checkpoint; prior project changes preserved.`, null, false, true, Date.now() - startedAtMs);
      }
      if (preflight.status === 'soft-exceeded') this.project(this.nextNodeId('diagnostic'), 'diagnostic', 'completed', provenance, Object.freeze({ code: 'budget.soft-warning', message: preflight.warning ?? 'Soft task budget is exceeded; execution is continuing.', severity: 'warning', retryable: false }));
      assertBudgetAllowed(preflight); assertBudgetAllowed(account.commitTool(toolCallId));
      stage = 'prepare';
      if (context.invocationError) throw new GameToolProtocolError(context.invocationError.code, context.invocationError.message);
      if (toolId === PLAN_TOOL_ID) {
        const result = await this.awaitPlan(toolCallId, event.sessionId, event.turnId, args, provenance, signal);
        if (result === 'suspended') return this.suspendedToolBody(context, 'plan-review', Date.now() - startedAtMs);
        return this.makeToolBody(context, 'completed', Object.freeze({ status: 'completed', value: result }), 'completed', Object.freeze({ toolCallId, toolId, target: 'Current project', effect: 'observe', argumentsSummary: '总体实现方案已由用户审阅。' }), 'completed', Object.freeze({ toolCallId, toolId, resultStatus: 'completed', summary: result.approvedForExecution === true ? '方案已确认，开始执行。' : '用户补充了信息，需要更新方案。' }), result, null, null, false, false, Date.now() - startedAtMs);
      }
      const definition = this.options.tools.definitions().find((item) => item.id === toolId);
      if (definition && definition.effect !== 'observe' && !this.approvedPlanTurns.has(turnKey(event.sessionId, event.turnId))) throw new PlanProtocolError('plan.approval-required', 'Submit studio.plan.propose and wait for user confirmation before mutating the project.');
      if (toolId === 'task.evaluate') {
        const task = this.active ? this.playtestTasks.get(this.active.taskId)?.task : null;
        if (!task) throw new PlaytestLoopError('task.acceptance-unapproved', 'Task evaluation requires user-approved acceptance criteria.');
        args = Object.freeze({ ...args, taskSpec: task }) as unknown as JsonObject;
      }
      stage = 'workflow';
      if (this.active) this.beforeProductTool(this.active.taskId, toolId, args, event.turnId, toolCallId);
      stage = 'prepare';
      const preparation = await this.options.tools.prepare({ schemaVersion: 1, id: toolCallId, sessionId: event.sessionId, turnId: event.turnId, ...(this.active?.taskId ? { taskId: this.active.taskId } : {}), toolId, toolVersion: context.node.toolVersion, arguments: args }, signal);
      stage = 'approval'; if (preparation.approvalId && await this.awaitApproval(preparation, provenance, signal) === 'suspended') {
        await this.options.tools.cancel(context.toolCallId).catch(() => undefined);
        return this.suspendedToolBody(context, 'tool-approval', Date.now() - startedAtMs);
      }
      stage = 'execute';
      const result = await this.options.tools.execute(preparation.id, signal);
      return this.toolResultBody(context, preparation, result, startedAtMs);
    } catch (cause) {
      const diagnostic = Object.freeze({ code: errorCode(cause), message: errorMessage(cause) });
      await this.options.operationLog.append({ kind: 'conversation/tool-failed', severity: signal.aborted ? 'warning' : 'error', source: asStableId('studio.conversation-host'), correlation: { sessionId: event.sessionId, turnId: event.turnId, toolCallId }, payload: { toolId, stage, argumentKeys: Object.freeze(Object.keys(args).sort()), code: diagnostic.code, message: diagnostic.message } }).catch(() => undefined);
      const status: ToolBatchNodeStatus = signal.aborted ? 'cancelled' : 'failed';
      return this.makeToolBody(context, status, Object.freeze({ status: 'failed', error: diagnostic }), status === 'cancelled' ? 'cancelled' : 'failed', Object.freeze({ toolCallId, toolId, target: 'Current project', effect: context.node.executionClass, argumentsSummary: toolArgumentSummary(toolId, args) }), status === 'cancelled' ? 'cancelled' : 'failed', Object.freeze({ toolCallId, toolId, resultStatus: status, summary: diagnostic.message }), null, null, `${toolId}: ${diagnostic.code}`, false, false, Date.now() - startedAtMs);
    }
  }

  private async commitToolBody(batch: ActiveToolBatch, context: ToolExecutionContext, original: HostToolBody, signal: AbortSignal): Promise<HostToolBody> {
    let body = context.node.outputProjection === 'full' ? original : Object.freeze({ ...original, backendResult: projectToolModelResult(original.backendResult, context.node.outputProjection) });
    const transaction = transactionResultIdentity(original.backendResult);
    const nextBytes = Buffer.byteLength(canonicalStringify(body.backendResult));
    if (batch.outputBytes + nextBytes > 1024 * 1024 && body.status === 'completed') body = this.cancelledToolBody(context, Object.freeze({ code: 'tool-batch.result-limit', message: 'Batch model-facing result limit exceeded.', retryable: false }), body.latencyMs, 'failed');
    batch.outputBytes += Buffer.byteLength(canonicalStringify(body.backendResult));
    if (this.active && body.mutation && Number.isSafeInteger(original.backendResult.afterRevision)) {
      this.updateTaskRun(this.active.taskId, { documentRevision: original.backendResult.afterRevision as number });
    }
    if (this.active && body.resultValue) await this.captureProductToolResult(this.active.taskId, context.toolId, body.resultValue, context.event.turnId, context.toolCallId);
    if (this.active && body.fact) this.active.toolFacts.push(body.fact);
    if (this.active && body.blocker) this.active.blockers.push(body.blocker);
    if (body.mutation && this.active?.sessionId === context.event.sessionId && this.active.turnId === context.event.turnId && this.active.approvedPlan) this.active.approvedPlan.mutationCount += 1;
    const submissionSignal = signal.aborted ? undefined : signal;
    let deliveryFailure: unknown = null;
    await context.backend.submitToolResult(context.toolCallId, body.backendResult, submissionSignal).catch(async (cause) => {
      deliveryFailure = cause;
      await this.appendToolSessionOp(batch, context, 'tool.outcome-unknown', Object.freeze({ toolCallId: context.toolCallId, toolId: context.toolId, code: errorCode(cause), message: errorMessage(cause), ...(transaction ?? {}) }));
      await this.options.runtime.turns.cancel(context.event.backendId, context.event.sessionId, context.event.turnId).catch(() => undefined);
    });
    if (deliveryFailure) {
      const diagnostic = Object.freeze({ code: 'tool.outcome-unknown', message: `Tool body finished but Backend result delivery was not confirmed: ${errorMessage(deliveryFailure)}`, retryable: true });
      body = Object.freeze({ ...body, status: 'failed' as const, resultStatus: 'failed' as const, resultContent: Object.freeze({ toolCallId: context.toolCallId, toolId: context.toolId, resultStatus: 'failed', summary: diagnostic.message }), blocker: `${context.toolId}: ${diagnostic.code}` });
      if (this.active) this.active.blockers.push(body.blocker!);
      this.project(context.toolNodeId, 'tool-call', body.toolCallStatus, context.provenance, this.executionContent(context, original, body.toolCallContent));
      this.project(this.nextNodeId('tool-result'), 'tool-result', 'failed', context.provenance, this.executionContent(context, original, body.resultContent));
      this.changed(); return body;
    }
    this.project(context.toolNodeId, 'tool-call', body.toolCallStatus, context.provenance, this.executionContent(context, original, body.toolCallContent));
    this.project(this.nextNodeId('tool-result'), 'tool-result', body.resultStatus, context.provenance, this.executionContent(context, original, body.resultContent));
    await this.options.runtime.turns.recordToolResult(context.event.turnId, context.toolCallId, body.backendResult);
    const account = this.active?.account;
    if (account) await this.recordTaskAccounting(account, context.event.sessionId, context.event.turnId);
    const usageRecord = this.options.runtime.usage?.get(context.event.turnId)?.snapshot().record;
    const costRecord = account && typeof account.latestCostRecord === 'function' ? account.latestCostRecord(context.event.turnId) : account && typeof account.costRecords === 'function' ? account.costRecords().at(-1) : undefined;
    await this.appendToolSessionOp(batch, context, 'tool.completed', Object.freeze({ toolCallId: context.toolCallId, toolId: context.toolId, status: body.status, latencyMs: body.latencyMs, outputBytes: Buffer.byteLength(canonicalStringify(body.backendResult)), resultDigest: sha256(canonicalStringify(body.backendResult)), ...(transaction ?? {}), ...(usageRecord ? { usageRecordId: usageRecord.id } : {}), ...(costRecord ? { costRecordId: costRecord.id, costAttribution: 'turn-shared' } : { costAttribution: 'unavailable' }) }));
    if (body.cancelTurnAfterCommit) await this.options.runtime.turns.cancel(context.event.backendId, context.event.sessionId, context.event.turnId).catch(() => undefined);
    this.changed();
    return body;
  }

  private makeToolBody(_context: ToolExecutionContext, status: ToolBatchNodeStatus, backendResult: JsonObject, toolCallStatus: HostToolBody['toolCallStatus'], toolCallContent: JsonObject, resultStatus: HostToolBody['resultStatus'], resultContent: JsonObject, resultValue: JsonObject | null, fact: string | null, blocker: string | null, mutation: boolean, cancelTurnAfterCommit: boolean, latencyMs: number): HostToolBody {
    return Object.freeze({ status, backendResult, toolCallStatus, toolCallContent, resultStatus, resultContent, resultValue, fact, blocker, mutation, cancelTurnAfterCommit, latencyMs: Math.max(0, Math.floor(latencyMs)), finishedAt: new Date().toISOString() });
  }

  private cancelledToolBody(context: ToolExecutionContext | undefined, diagnostic: ToolBatchDiagnostic, latencyMs = 0, status: ToolBatchNodeStatus = 'cancelled'): HostToolBody {
    const toolCallId = context?.toolCallId ?? asStableId('tool-call:unknown'); const toolId = context?.toolId ?? asStableId('tool:unknown');
    const backendResult = Object.freeze({ status: status === 'failed' ? 'failed' : 'cancelled', error: Object.freeze({ code: diagnostic.code, message: diagnostic.message, retryable: diagnostic.retryable }) });
    return Object.freeze({ status, backendResult, toolCallStatus: status === 'failed' ? 'failed' : 'cancelled', toolCallContent: Object.freeze({ toolCallId, toolId, target: 'Current project', effect: context?.node.executionClass ?? 'unknown-exclusive', argumentsSummary: context ? toolArgumentSummary(toolId, context.args) : '工具调用未执行。' }), resultStatus: status === 'failed' ? 'failed' : 'cancelled', resultContent: Object.freeze({ toolCallId, toolId, resultStatus: status, summary: diagnostic.message }), resultValue: null, fact: null, blocker: `${toolId}: ${diagnostic.code}`, mutation: false, cancelTurnAfterCommit: false, latencyMs: Math.max(0, Math.floor(latencyMs)), finishedAt: new Date().toISOString() });
  }

  private suspendedToolBody(context: ToolExecutionContext, barrierKind: string, latencyMs: number): HostToolBody {
    const value = Object.freeze({ code: 'barrier.waiting-user', barrierKind, preserved: true, retryable: true, message: 'Studio persisted the user barrier and released the Backend turn. Continue from the durable checkpoint after resolution.' });
    return this.makeToolBody(context, 'cancelled', Object.freeze({ status: 'cancelled', value }), 'cancelled', Object.freeze({ toolCallId: context.toolCallId, toolId: context.toolId, target: 'Current project', effect: context.node.executionClass, argumentsSummary: toolArgumentSummary(context.toolId, context.args) }), 'cancelled', Object.freeze({ toolCallId: context.toolCallId, toolId: context.toolId, resultStatus: 'cancelled', summary: '等待用户确认；Backend 调用已释放，已完成产物保持不变。' }), value, `${context.toolId}: durable ${barrierKind} checkpoint created.`, null, false, true, latencyMs);
  }

  private async awaitBudgetContinuation(decision: BudgetDecision, provenance: ConversationNodeReadModel['provenance'], signal: AbortSignal): Promise<boolean | BarrierWaitResult> {
    const nodeId = this.nextNodeId('budget-question');
    const continueOptionId = asStableId(`option:budget-continue:${this.nodeSequence}`);
    const stopOptionId = asStableId(`option:budget-stop:${this.nodeSequence}`);
    const violations = decision.violations.length
      ? decision.violations.map((item) => `${budgetMetricLabel(item.metric)} ${item.projected}/${item.limit}`).join('，')
      : '任务预算已达到当前上限';
    const content = Object.freeze({
      prompt: `当前任务已达到预算检查点（${violations}）。继续将增加一个与初始任务相同的预算额度，并从当前步骤继续；停止不会回滚已经完成的场景、资源或脚本修改，当前脚本提案也会保留。`,
      options: Object.freeze([
        Object.freeze({ id: continueOptionId, label: '继续处理', description: '批准一个有界的额外预算额度，并从当前工具调用继续。' }),
        Object.freeze({ id: stopOptionId, label: '停止并保留结果', description: '结束当前任务，保留所有已完成修改和当前提案。' }),
      ]),
      allowFreeform: false,
      multiple: false,
    });
    await this.requestQuestionBarrier({
      sessionId: provenance.sessionId, turnId: provenance.turnId, nodeId, kind: 'budget-continuation', reason: violations,
      scopeDigest: sha256(canonicalStringify({ taskId: this.active?.taskId ?? null, violations: decision.violations })),
    });
    const active = this.active;
    void this.options.operationLog.append({
      kind: 'agent/budget-continuation-requested', severity: 'warning', source: asStableId('studio.conversation-host'), correlation: { sessionId: provenance.sessionId, turnId: provenance.turnId, ...(provenance.stepId ? { toolCallId: provenance.stepId } : {}) },
      payload: { taskId: active?.taskId ?? null, violations: decision.violations.map((item) => ({ metric: item.metric, current: item.current, projected: item.projected, limit: item.limit })) },
    }).catch(() => undefined);
    if (this.durableBarrierMode()) {
      this.project(nodeId, 'question', 'pending', provenance, content);
      if (active) {
        active.suspendedBarrierId = nodeId;
        this.updateTaskRun(active.taskId, { status: 'waiting-user', resumable: true, terminalDiagnostic: decision.warning }, { phase: this.taskRuns.get(active.taskId)?.phase ?? 'planning', status: 'warning', title: '预算检查点', detail: `${violations}；Backend 调用已释放。`, turnId: provenance.turnId, toolCallId: provenance.stepId ?? null });
      }
      return 'suspended';
    }
    const releaseHumanWait = active?.sessionId && active.turnId ? this.pauseForHumanInteraction(active.sessionId, active.turnId) : () => {};
    return await new Promise<boolean>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.questions.get(nodeId);
        this.questions.delete(nodeId); releaseHumanWait(); this.finishNode(nodeId, 'cancelled');
        if (pending) void this.resolveQuestionBarrier(pending, Object.freeze({}), 'cancelled').catch(() => undefined);
        reject(signal.reason ?? new Error('Budget continuation cancelled.'));
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.questions.set(nodeId, Object.freeze({
        kind: 'budget', nodeId, sessionId: provenance.sessionId, turnId: provenance.turnId, continueOptionId, stopOptionId, releaseHumanWait,
        detachAbort: () => signal.removeEventListener('abort', abort), resolve, reject,
      }));
      this.project(nodeId, 'question', 'pending', provenance, content);
      if (active) this.updateTaskRun(active.taskId, { status: 'waiting-user', resumable: true, terminalDiagnostic: decision.warning }, { phase: this.taskRuns.get(active.taskId)?.phase ?? 'planning', status: 'warning', title: '预算检查点', detail: violations, turnId: provenance.turnId, toolCallId: provenance.stepId ?? null });
    });
  }

  private async awaitPlan(toolCallId: StableId, sessionId: StableId, turnId: StableId, args: JsonObject, provenance: ConversationNodeReadModel['provenance'], signal: AbortSignal): Promise<JsonObject | BarrierWaitResult> {
    const proposal = validatePlanProposal(args);
    const nodeId = this.nextNodeId('plan');
    const items = Object.freeze(proposal.items.map((item, index) => Object.freeze({
      id: asStableId(`plan-item:${this.nodeSequence}:${index + 1}`), label: item.label, ...(item.details ? { details: item.details } : {}),
    })));
    const content = Object.freeze({
      title: proposal.title, summary: proposal.summary, toolCallId,
      items: Object.freeze(items.map((item) => Object.freeze({ ...item, status: 'pending' }))),
      acceptance: Object.freeze(proposal.acceptance.map((item) => Object.freeze({ ...item }))),
    });
    await this.requestQuestionBarrier({ sessionId, turnId, nodeId, kind: 'plan-review', reason: proposal.summary, scopeDigest: sha256(canonicalStringify(args)) });
    if (this.durableBarrierMode()) {
      this.project(nodeId, 'plan', 'pending', provenance, content);
      if (this.active) {
        const acceptance = proposal.acceptance.map((item, index) => acceptanceReadModel(item, asStableId(`acceptance:${this.active!.taskId}:${index + 1}`)));
        this.active.suspendedBarrierId = nodeId;
        this.updateTaskRun(this.active.taskId, { status: 'waiting-user', phase: 'planning', acceptance: Object.freeze(acceptance), resumable: true }, { phase: 'planning', status: 'warning', title: '等待方案与验收标准审批', detail: `${items.length} 个步骤，${acceptance.length} 项可验证标准。Backend 调用已释放。`, turnId, toolCallId });
      }
      return 'suspended';
    }
    const releaseHumanWait = this.pauseForHumanInteraction(sessionId, turnId);
    return await new Promise<JsonObject>((resolve, reject) => {
      const abort = (): void => {
        this.plans.delete(nodeId); releaseHumanWait();
        void this.resolvePlanBarrier(sessionId, turnId, nodeId, 'cancelled', Object.freeze({})).catch(() => undefined);
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
      this.project(nodeId, 'plan', 'pending', provenance, content);
      if (this.active) {
        const acceptance = proposal.acceptance.map((item, index) => acceptanceReadModel(item, asStableId(`acceptance:${this.active!.taskId}:${index + 1}`)));
        this.updateTaskRun(this.active.taskId, { status: 'waiting-user', phase: 'planning', acceptance: Object.freeze(acceptance), resumable: true }, { phase: 'planning', status: 'warning', title: '等待方案与验收标准审批', detail: `${items.length} 个步骤，${acceptance.length} 项可验证标准。`, turnId, toolCallId });
      }
    });
  }

  private async resolvePlan(nodeId: StableId, acceptedItemIds: readonly StableId[], note: string | undefined, mode: 'approve' | 'revise'): Promise<void> {
    const pending = this.plans.get(nodeId);
    if (!pending) throw new Error('Plan is stale or already resolved.');
    const accepted = new Set(acceptedItemIds);
    if (acceptedItemIds.some((id) => !pending.items.some((item) => item.id === id))) throw new Error('Plan selection contains an unknown item.');
    if (mode === 'approve' && accepted.size === 0) throw new Error('Approve at least one plan item or request a revision.');
    if (mode === 'revise' && !note?.trim()) throw new Error('Add guidance before requesting a revised plan.');
    await this.resolvePlanBarrier(pending.sessionId, pending.turnId, pending.nodeId, mode === 'approve' ? 'answered' : 'answered', Object.freeze({ mode, acceptedItemIds: Object.freeze([...accepted]), ...(note?.trim() ? { note: note.trim().slice(0, 2_048) } : {}) }));
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
      title: pending.title, summary: pending.summary, toolCallId: pending.toolCallId,
      items: Object.freeze(pending.items.map((item) => Object.freeze({ ...item, status: mode === 'approve' && accepted.has(item.id) ? 'accepted' : 'rejected' }))),
      acceptance: Object.freeze(pending.acceptance.map((item) => Object.freeze({ ...item }))),
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

  private async resolveRecoveredApproval(approvalId: StableId, decision: 'allow-once' | 'allow-always' | 'reject'): Promise<void> {
    const node = [...this.nodes.values()].find((candidate) => candidate.kind === 'approval' && candidate.status === 'pending' && candidate.content.approvalId === approvalId);
    if (!node) throw new Error('Approval is stale or already resolved.');
    const handle = await this.ensureDurableSession(node.provenance.sessionId);
    const snapshot = await handle.snapshot();
    if (!snapshot.recovery.unresolvedBarrierIds.includes(approvalId)) throw new Error('Approval is stale or already resolved.');
    await handle.append({ kind: 'approval.resolved', turnId: node.provenance.turnId, nodeId: node.id, projectRevision: this.options.projectContext?.()?.revision ?? null, payload: { approvalId, resolution: decision, denied: decision === 'reject', resolvedBy: 'user-after-restart', recovered: true } });
    await handle.checkpoint();
    this.project(node.id, 'approval', 'completed', node.provenance, Object.freeze({ ...node.content, decision }));
    const run = this.taskRunFor(node.provenance.sessionId, node.provenance.turnId);
    if (run) this.updateTaskRun(run.taskId, decision === 'reject' ? { status: 'cancelled', phase: 'cancelled', resumable: false, terminalDiagnostic: 'approval.rejected-after-restart' } : { status: 'running', resumable: true, terminalDiagnostic: null }, { phase: decision === 'reject' ? 'cancelled' : run.phase, status: decision === 'reject' ? 'warning' : 'complete', title: decision === 'reject' ? '恢复后的授权已拒绝' : '恢复后的授权已确认', detail: decision === 'reject' ? '未提交工作已停止，已有产物保持不变。' : 'Studio 将从持久检查点重新校验并恢复。', turnId: node.provenance.turnId });
    if (decision !== 'reject') this.scheduleRecoveredContinuation(node, `The user approved ${String(node.content.toolId ?? 'the pending Studio tool')} after its durable barrier. Re-inspect the authoritative project revision, retry only that pending operation with the same arguments, and continue the already approved plan without repeating completed edits.`, this.recoveredApprovedPlan(node.provenance), false);
  }

  private async resolveRecoveredQuestion(nodeId: StableId, answer: JsonObject): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node || node.kind !== 'question' || node.status !== 'pending') throw new Error('Question is stale or already answered.');
    const handle = await this.ensureDurableSession(node.provenance.sessionId); const snapshot = await handle.snapshot();
    if (!snapshot.recovery.unresolvedBarrierIds.includes(nodeId)) throw new Error('Question is stale or already answered.');
    const answerText = canonicalStringify(answer).slice(0, 8_192);
    await handle.appendMessage({ role: 'user', content: `Recovered barrier answer: ${answerText}`, turnId: node.provenance.turnId, projectRevision: this.options.projectContext?.()?.revision ?? null });
    await handle.append({ kind: 'question.resolved', turnId: node.provenance.turnId, nodeId, projectRevision: this.options.projectContext?.()?.revision ?? null, payload: { questionId: nodeId, resolution: 'answered', answerDigest: sha256(answerText), resolvedBy: 'user-after-restart', recovered: true } });
    await handle.checkpoint(); this.finishNode(nodeId, 'completed');
    const optionIds = Array.isArray(answer.optionIds) ? answer.optionIds : [];
    const stop = optionIds.some((id) => typeof id === 'string' && id.includes('budget-stop'));
    const run = this.taskRunFor(node.provenance.sessionId, node.provenance.turnId);
    if (run) this.updateTaskRun(run.taskId, stop ? { status: 'cancelled', phase: 'cancelled', resumable: false, terminalDiagnostic: 'budget.stopped-after-restart' } : { status: 'running', resumable: true, terminalDiagnostic: null }, { phase: stop ? 'cancelled' : run.phase, status: stop ? 'warning' : 'complete', title: stop ? '已停止并保留结果' : '恢复后的问题已回答', detail: stop ? '所有已提交 transaction、产物和证据均已保留。' : 'Studio 将从持久检查点恢复。', turnId: node.provenance.turnId });
    if (!stop) this.scheduleRecoveredContinuation(node, `The user answered the durable ${String(node.content.prompt ?? 'Studio question')}: ${answerText}. Continue from the authoritative project and Session checkpoint without repeating completed edits.`, this.recoveredApprovedPlan(node.provenance), Array.isArray(node.content.options) && node.content.options.some((option) => isRecord(option) && typeof option.id === 'string' && option.id.includes('budget-continue')));
  }

  private async resolveRecoveredPlan(nodeId: StableId, acceptedItemIds: readonly StableId[], note: string | undefined, mode: 'approve' | 'revise'): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node || node.kind !== 'plan' || node.status !== 'pending' || !Array.isArray(node.content.items)) throw new Error('Plan is stale or already resolved.');
    const items = node.content.items.filter(isRecord); const accepted = new Set(acceptedItemIds);
    if (acceptedItemIds.some((id) => !items.some((item) => item.id === id))) throw new Error('Plan selection contains an unknown item.');
    if (mode === 'approve' && accepted.size === 0) throw new Error('Approve at least one plan item or request a revision.');
    if (mode === 'revise' && !note?.trim()) throw new Error('Add guidance before requesting a revised plan.');
    const handle = await this.ensureDurableSession(node.provenance.sessionId); const snapshot = await handle.snapshot();
    if (!snapshot.recovery.unresolvedBarrierIds.includes(nodeId)) throw new Error('Plan is stale or already resolved.');
    const resolution = Object.freeze({ mode, acceptedItemIds: Object.freeze([...accepted]), ...(note?.trim() ? { note: note.trim().slice(0, 2_048) } : {}) });
    await handle.appendMessage({ role: 'user', content: `Recovered plan decision: ${canonicalStringify(resolution)}`, turnId: node.provenance.turnId, projectRevision: this.options.projectContext?.()?.revision ?? null });
    await handle.append({ kind: 'question.resolved', turnId: node.provenance.turnId, nodeId, projectRevision: this.options.projectContext?.()?.revision ?? null, payload: { questionId: nodeId, resolution: 'answered', answerDigest: sha256(canonicalStringify(resolution)), resolvedBy: 'user-after-restart', recovered: true } });
    await handle.checkpoint();
    this.project(node.id, 'plan', 'completed', node.provenance, Object.freeze({ ...node.content, items: Object.freeze(items.map((item) => Object.freeze({ ...item, status: mode === 'approve' && typeof item.id === 'string' && accepted.has(asStableId(item.id)) ? 'accepted' : 'rejected' }))), decision: mode === 'approve' ? 'approved' : 'revision-requested', ...(note?.trim() ? { note: note.trim().slice(0, 2_048) } : {}) }));
    const run = this.taskRunFor(node.provenance.sessionId, node.provenance.turnId); if (run) this.updateTaskRun(run.taskId, { status: 'running', phase: mode === 'approve' ? 'editing' : 'planning', resumable: true, terminalDiagnostic: null }, { phase: mode === 'approve' ? 'editing' : 'planning', status: 'complete', title: mode === 'approve' ? '恢复后的方案已批准' : '恢复后的方案要求修订', detail: 'Studio 将从持久检查点继续。', turnId: node.provenance.turnId });
    const plan = mode === 'approve' ? this.recoveredApprovedPlan(node.provenance) : null;
    this.scheduleRecoveredContinuation(node, mode === 'approve' ? `The user approved the persisted plan${note?.trim() ? ` with this note: ${note.trim().slice(0, 1_024)}` : ''}. Execute only the accepted steps, do not request the same plan again, and revalidate the current project revision before mutation.` : `The user requested a revised plan: ${note!.trim().slice(0, 1_024)}. Re-plan from the current authoritative project without executing the rejected proposal.`, plan, false);
  }

  private taskRunFor(sessionId: StableId, turnId: StableId): ConversationTaskRunReadModel | undefined { return [...this.taskRuns.values()].find((run) => run.sessionId === sessionId && run.turnId === turnId); }

  private scheduleRecoveredResume(provenance: ConversationNodeReadModel['provenance']): void {
    if (this.active) return;
    this.track(this.resume(provenance.backendId, provenance.sessionId, provenance.turnId).catch((cause) => this.captureFailure(provenance.backendId, cause, provenance.sessionId, provenance.turnId)));
  }

  private scheduleRecoveredContinuation(node: ConversationNodeReadModel, instruction: string, plan: ApprovedPlanExecution | null, budgetGranted: boolean): void {
    const run = this.taskRunFor(node.provenance.sessionId, node.provenance.turnId);
    if (!run) { this.scheduleRecoveredResume(node.provenance); return; }
    this.queuedPrompts.unshift(Object.freeze({ backendId: node.provenance.backendId, prompt: instruction, recovered: Object.freeze({ taskId: run.taskId, instruction, plan, budgetGranted }) }));
    this.changed(); this.drainQueuedPrompts();
  }

  private recoveredApprovedPlan(provenance: ConversationNodeReadModel['provenance']): ApprovedPlanExecution | null {
    const plan = [...this.nodes.values()].filter((candidate) => candidate.kind === 'plan' && candidate.status === 'completed' && candidate.provenance.sessionId === provenance.sessionId && candidate.content.decision === 'approved').at(-1);
    const run = this.taskRunFor(provenance.sessionId, provenance.turnId);
    if (!plan && !run?.acceptance.length) return null;
    const items = Array.isArray(plan?.content.items) ? plan.content.items.filter(isRecord).filter((item) => item.status === 'accepted').map((item, index) => Object.freeze({ id: typeof item.id === 'string' ? asStableId(item.id) : asStableId(`plan-item:recovered:${index + 1}`), label: typeof item.label === 'string' ? item.label.slice(0, 256) : `Recovered step ${index + 1}`, ...(typeof item.details === 'string' ? { details: item.details.slice(0, 2_048) } : {}) })) : [];
    return { title: typeof plan?.content.title === 'string' ? plan.content.title : run?.title ?? 'Recovered approved plan', summary: typeof plan?.content.summary === 'string' ? plan.content.summary : 'Restored from the durable approved plan and acceptance checkpoint.', items: Object.freeze(items), ...(typeof plan?.content.note === 'string' ? { note: plan.content.note } : {}), attempts: 0, mutationCount: 0 };
  }

  private async awaitApproval(preparation: GameToolPreparation, provenance: ConversationNodeReadModel['provenance'], signal: AbortSignal): Promise<'approved' | BarrierWaitResult> {
    const approval = this.options.tools.approval(preparation.approvalId!);
    if (!approval) throw new Error('Prepared approval is unavailable.');
    const nodeId = this.nextNodeId('approval');
    await this.requestApprovalBarrier(preparation, approval, nodeId);
    const durableGrant = this.findDurableApprovalGrant(approval);
    if (durableGrant) {
      const decision = durableGrant.content.decision === 'allow-always' ? 'allow-always' : 'allow-once';
      const resolved = await this.options.tools.decide(approval.approvalId, decision);
      await this.resolveApprovalBarrier(Object.freeze({ preparation, approval, nodeId, sessionId: preparation.sessionId, turnId: preparation.turnId, resolve: () => {}, reject: () => {} }), decision);
      await this.options.operationLog.append({ kind: 'conversation/approval-grant-reused', severity: 'info', source: asStableId('studio.conversation-host'), correlation: { sessionId: preparation.sessionId, turnId: preparation.turnId, approvalId: approval.approvalId, toolCallId: preparation.callId }, payload: { sourceApprovalId: durableGrant.content.approvalId, approvalId: approval.approvalId, toolId: approval.toolId, argumentsDigest: approval.argumentsDigest, decision: resolved.decision } }).catch(() => undefined);
      return 'approved';
    }
    if (this.durableBarrierMode()) {
      this.project(nodeId, 'approval', 'pending', provenance, approvalContent(preparation, approval));
      if (this.active) {
        this.active.suspendedBarrierId = approval.approvalId;
        this.updateTaskRun(this.active.taskId, { status: 'waiting-user', resumable: true }, { phase: this.taskRuns.get(this.active.taskId)?.phase ?? 'editing', status: 'warning', title: '等待工具授权', detail: `${approval.toolId} · ${approval.effect} · ${approval.target}；Backend 调用已释放。`, turnId: provenance.turnId, toolCallId: preparation.id });
      }
      return 'suspended';
    }
    const releaseHumanWait = this.pauseForHumanInteraction(preparation.sessionId, preparation.turnId);
    return await new Promise<'approved'>((resolve, reject) => {
      let settled = false;
      const abort = (): void => {
        if (settled) return;
        settled = true; releaseHumanWait(); this.approvals.delete(approval.approvalId);
        void this.options.tools.decide(approval.approvalId, 'cancel').catch(() => undefined);
        void this.resolveApprovalBarrier(Object.freeze({ preparation, approval, nodeId, sessionId: preparation.sessionId, turnId: preparation.turnId, resolve: () => {}, reject: () => {} }), 'cancel').catch(() => undefined);
        const current = this.nodes.get(nodeId);
        if (current && current.status === 'pending') this.project(nodeId, 'approval', 'cancelled', current.provenance, Object.freeze({ ...current.content, decision: 'cancel' }));
        reject(signal.reason ?? new Error('Approval cancelled.'));
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.approvals.set(approval.approvalId, Object.freeze({
        preparation, approval, nodeId, sessionId: preparation.sessionId, turnId: preparation.turnId,
        resolve: () => { if (settled) return; settled = true; releaseHumanWait(); signal.removeEventListener('abort', abort); resolve('approved'); },
        reject: (cause: unknown) => { if (settled) return; settled = true; releaseHumanWait(); signal.removeEventListener('abort', abort); reject(cause); },
      }));
      this.project(nodeId, 'approval', 'pending', provenance, approvalContent(preparation, approval));
      if (this.active) this.updateTaskRun(this.active.taskId, { status: 'waiting-user', resumable: true }, { phase: this.taskRuns.get(this.active.taskId)?.phase ?? 'editing', status: 'warning', title: '等待工具授权', detail: `${approval.toolId} · ${approval.effect} · ${approval.target}`, turnId: provenance.turnId, toolCallId: preparation.id });
    });
  }

  private findDurableApprovalGrant(approval: GameToolApproval): ConversationNodeReadModel | null {
    const matches = [...this.nodes.values()].filter((node) => node.kind === 'approval' && node.status === 'completed'
      && node.provenance.sessionId === approval.sessionId
      && (node.content.decision === 'allow-once' || node.content.decision === 'allow-always')
      && node.content.toolId === approval.toolId && node.content.toolVersion === approval.toolVersion
      && node.content.target === approval.target && node.content.argsDigest === presentationDigest(approval.argumentsDigest));
    return matches.at(-1) ?? null;
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
      await this.resolveApprovalBarrier(pending, decision);
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
    if (this.disposed) return;
    const rawContent = Object.freeze({ ...this.pendingRecordContents.get(id), ...redactObject(content).value });
    if (this.options.recordProjectId && (status === 'pending' || status === 'streaming')) this.pendingRecordContents.set(id, rawContent);
    else this.pendingRecordContents.delete(id);
    const { parameters: _parameters, result: _result, ...displayContent } = rawContent;
    content = displayContent;
    const previous = this.nodes.get(id);
    const node = Object.freeze({ schemaVersion: 1 as const, id, kind, knownKind: null, status, createdAt: previous?.createdAt ?? new Date().toISOString(), provenance, content, payloadTruncated: false });
    this.nodes.set(id, node);
    this.eventSequence += 1;
    this.events.push(Object.freeze({ schemaVersion: 1, sequence: this.eventSequence, source: 'live', node }));
    if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
    this.persistProjection(node, rawContent);
    this.changed();
  }

  private hasPendingHumanBarrier(): boolean { return this.approvals.size > 0 || this.questions.size > 0 || this.plans.size > 0 || [...this.nodes.values()].some((node) => (node.kind === 'approval' || node.kind === 'question' || node.kind === 'plan') && node.status === 'pending'); }

  private durableBarrierMode(): boolean { return Boolean(this.options.sessionRecovery && this.options.runtime.sessions && this.projectionPersistenceAvailable()); }

  private drainQueuedPrompts(): void {
    if (this.disposed || this.stopping || this.active || this.queuedPromptDrainActive || this.queuedPrompts.length === 0) return;
    const next = this.queuedPrompts.shift()!;
    this.queuedPromptDrainActive = true;
    this.changed();
    const work = next.recovered ? this.startRecoveredContinuation(next.backendId, next.recovered) : this.start(next.backendId, next.prompt);
    this.track(work.catch((cause) => this.captureFailure(next.backendId, cause)).finally(() => {
      this.queuedPromptDrainActive = false;
      this.changed();
      this.drainQueuedPrompts();
    }));
  }

  private async startRecoveredContinuation(backendId: StableId, seed: RecoveredContinuationSeed): Promise<void> {
    const run = this.taskRuns.get(seed.taskId);
    if (!run) throw new Error(`Recovered task ${seed.taskId} is unavailable.`);
    const config = this.turnConfig(backendId, seed.taskId);
    const budget = Object.freeze({ ...this.budgetTemplate, id: config.taskBudgetId, limits: Object.freeze({ ...this.budgetTemplate.limits }) });
    const account = this.options.runtime.accounting.get(seed.taskId) ?? this.options.runtime.accounting.open({ taskId: seed.taskId, budget, pricingCatalog: M12_DEFAULT_PRICING_CATALOG });
    if (seed.budgetGranted && account.snapshot().budgetDecision.status === 'hard-exceeded') assertBudgetAllowed(account.authorizeContinuation());
    if (run.acceptance.length > 0 && !this.playtestTasks.has(run.taskId)) {
      const playtest = new BoundedPlaytestTask(taskSpecFromRun(run), run.repairLimit);
      playtest.advance('editing'); this.playtestTasks.set(run.taskId, playtest);
    }
    await this.continueTask(backendId, seed.plan, run.taskId, config, account, conversationKeyFor(this.options.projectContext?.() ?? null), run.requestSummary, seed.instruction);
  }

  private persistProjection(node: ConversationNodeReadModel, rawContent: JsonObject = node.content): void {
    if (!this.projectionPersistenceAvailable()) return;
    const projectedAt = new Date().toISOString();
    const write = async (): Promise<void> => {
      let executionDataArtifactId: StableId | undefined;
      if (this.options.recordProjectId) {
        const data = await this.options.operationLog.putArtifact(rawContent, { schemaVersion: 'agent-execution-data/1', backendId: node.provenance.backendId });
        executionDataArtifactId = data.id;
        const finishedAt = typeof node.content.executionFinishedAt === 'string' ? node.content.executionFinishedAt : node.status === 'pending' || node.status === 'streaming' ? null : projectedAt;
        const durationMs = typeof node.content.durationMs === 'number' ? node.content.durationMs : finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(node.createdAt)) : null;
        const startedAt = typeof node.content.executionStartedAt === 'string' ? node.content.executionStartedAt : node.createdAt;
        await this.options.operationLog.append({ kind: 'agent/execution-record', severity: node.status === 'failed' ? 'error' : 'info', source: asStableId('studio.conversation-host'),
          correlation: { projectId: this.options.recordProjectId, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId },
          payload: { record: { schemaVersion: 1, id: node.id, projectId: this.options.recordProjectId, kind: node.kind, status: node.status, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId, toolId: typeof node.content.toolId === 'string' ? node.content.toolId : null, startedAt, finishedAt, durationMs, dataArtifactId: data.id } }, artifactRefs: [data.id] });
      }
      const artifact = await this.options.operationLog.putArtifact(node as unknown as JsonObject, { schemaVersion: 'conversation-node/1', backendId: node.provenance.backendId });
      await this.options.operationLog.append({
        kind: 'conversation/node-projected', severity: node.status === 'failed' ? 'error' : node.status === 'cancelled' ? 'warning' : 'info', source: asStableId('studio.conversation-host'),
        correlation: {
          sessionId: node.provenance.sessionId, turnId: node.provenance.turnId, stepId: node.provenance.stepId,
          ...(typeof node.content.toolCallId === 'string' ? { toolCallId: asStableId(node.content.toolCallId) } : {}),
          ...(typeof node.content.approvalId === 'string' ? { approvalId: asStableId(node.content.approvalId) } : {}),
        },
        payload: { nodeId: node.id, nodeKind: node.kind, nodeStatus: node.status, artifactId: artifact.id, artifactDigest: artifact.digest, ...(executionDataArtifactId ? { executionDataArtifactId } : {}) },
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
        try {
          const node = normalizeConversationNode((await this.options.operationLog.readArtifact(artifactId)).value);
          if (this.options.recordProjectId && (node.status === 'pending' || node.status === 'streaming') && typeof event.payload.executionDataArtifactId === 'string') {
            const data = (await this.options.operationLog.readArtifact(asStableId(event.payload.executionDataArtifactId))).value;
            if (isRecord(data)) this.pendingRecordContents.set(node.id, data as JsonObject);
          } else this.pendingRecordContents.delete(node.id);
          restored.push(node);
        }
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
      if (await this.recoverableBarrierNode(node)) continue;
      const content = node.kind === 'approval' ? Object.freeze({ ...node.content, decision: 'stale' }) : node.content;
      this.project(node.id, node.kind, 'cancelled', node.provenance, content);
    }
    if (restored.length) this.stateRevision += 1;
  }

  private projectionPersistenceAvailable(): boolean {
    const value = this.options.operationLog as unknown as Record<string, unknown>;
    return typeof value.putArtifact === 'function' && typeof value.query === 'function' && typeof value.readArtifact === 'function' && typeof value.status === 'function';
  }

  private async recoverableBarrierNode(node: ConversationNodeReadModel): Promise<boolean> {
    const barrierId = node.kind === 'approval' && typeof node.content.approvalId === 'string' ? asStableId(node.content.approvalId) : node.kind === 'question' || node.kind === 'plan' ? node.id : null;
    const sessions = this.options.runtime.sessions;
    if (!barrierId || !sessions) return false;
    try {
      let pending = this.durableSessions.get(node.provenance.sessionId);
      if (!pending) {
        pending = sessions.open(node.provenance.sessionId, { repairOpenOperations: false }).then(async (handle) => { await this.options.sessionRecovery?.recover(handle); return isCompleteDurableSessionHandle(handle) ? this.observeDurableSession(handle) : handle; });
        this.durableSessions.set(node.provenance.sessionId, pending);
      }
      const handle = await pending; const snapshot = await handle.snapshot();
      if (!snapshot.recovery.unresolvedBarrierIds.includes(barrierId)) return false;
      await this.options.operationLog.append({ kind: 'conversation/barrier-recovered', severity: 'warning', source: asStableId('studio.conversation-host'), correlation: { sessionId: node.provenance.sessionId, turnId: node.provenance.turnId }, payload: { nodeId: node.id, barrierId, barrierKind: node.kind, expiresAt: null } });
      return true;
    } catch { return false; }
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
    const events = await queryRetainedOperationEvents(this.options.operationLog, ['conversation/task-projected'], 5_000);
    for (const event of events) {
      const id = event.artifactRefs[0]; if (!id) continue;
      try {
        const run = normalizeTaskRun((await this.options.operationLog.readArtifact(id)).value); const prior = this.taskRuns.get(run.taskId);
        if (run.sessionId && run.updatedAt > (this.restoredGraphSessions.get(run.sessionId) ?? '')) this.restoredGraphSessions.set(run.sessionId, run.updatedAt);
        if (!prior || run.revision > prior.revision) this.taskRuns.set(run.taskId, run);
      } catch { /* corrupt/future projections stay hidden */ }
    }
    this.latestTaskId = [...this.taskRuns.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.taskId.localeCompare(right.taskId)).at(-1)?.taskId ?? null;
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

  private taskAccountingReadModel(): ConversationTaskAccountingReadModel | null {
    if (!this.latestTaskId) return null;
    const snapshot = this.options.runtime.accounting.get(this.latestTaskId)?.reconcile();
    if (!snapshot) return this.restoredTaskAccounting.get(this.latestTaskId) ?? null;
    const readModel = taskAccountingProjection(snapshot);
    this.restoredTaskAccounting.set(snapshot.taskId, readModel);
    return readModel;
  }

  private async recordTaskAccounting(account: TaskAccount, sessionId: StableId, turnId: StableId): Promise<void> {
    const snapshot = account.reconcile();
    const readModel = taskAccountingProjection(snapshot);
    this.restoredTaskAccounting.set(snapshot.taskId, readModel);
    let artifactId: StableId | null = null;
    if (this.projectionPersistenceAvailable()) artifactId = (await this.options.operationLog.putArtifact(readModel as unknown as JsonObject, { schemaVersion: 'conversation-task-accounting/1' })).id;
    await this.options.operationLog.append({ kind: 'agent/task-accounting', severity: snapshot.budgetDecision.status === 'hard-exceeded' ? 'error' : snapshot.budgetDecision.status === 'soft-exceeded' ? 'warning' : 'info', source: asStableId('studio.conversation-host'), correlation: { sessionId, turnId }, payload: {
      taskId: snapshot.taskId, budgetId: snapshot.budget.id, budgetStatus: snapshot.budgetDecision.status, costRecordIds: snapshot.cost.recordIds, pricingCatalogId: snapshot.cost.pricingCatalogId, pricingCatalogVersion: snapshot.cost.pricingCatalogVersion, pricingEffectiveAt: snapshot.cost.effectiveAt, costStatus: snapshot.cost.status, amountMicros: snapshot.cost.amountMicros, currency: snapshot.cost.currency, cacheSavingMicros: snapshot.cost.cacheSavingMicros, costFinal: snapshot.cost.final,
      inputTokens: snapshot.usage.inputTokens, cachedInputTokens: snapshot.usage.cachedInputTokens, outputTokens: snapshot.usage.outputTokens, reasoningTokens: snapshot.usage.reasoningTokens, toolInputBytes: snapshot.usage.toolInputBytes, toolOutputBytes: snapshot.usage.toolOutputBytes, ...(snapshot.usage.contextCache ? { contextCache: snapshot.usage.contextCache } : {}),
      ...(artifactId ? { artifactId } : {}),
    }, ...(artifactId ? { artifactRefs: [artifactId] } : {}) }).catch(() => undefined);
  }

  private async restoreTaskAccounting(): Promise<void> {
    if (!this.projectionPersistenceAvailable()) return;
    const events = await queryRetainedOperationEvents(this.options.operationLog, ['agent/task-accounting'], 5_000);
    for (const event of events) {
      const artifactId = event.artifactRefs[0]; if (!artifactId) continue;
      try {
        const readModel = normalizeTaskAccounting((await this.options.operationLog.readArtifact(artifactId)).value);
        if (readModel) this.restoredTaskAccounting.set(readModel.taskId, readModel);
      } catch { /* Missing/corrupt accounting remains unknown instead of being fabricated. */ }
    }
  }

  private modelTools(request: string): readonly Readonly<{ id: StableId; description: string; inputSchema: JsonObject }>[] {
    const definitions = this.options.tools.selectDefinitions?.(request).definitions ?? this.options.tools.definitions();
    const tools: Readonly<{ id: StableId; description: string; inputSchema: JsonObject }>[] = [PLAN_TOOL_DEFINITION, ...definitions].map((definition) => Object.freeze({
      id: definition.id,
      description: `${definition.description} Effect: ${definition.effect}. Risk: ${definition.risk}.${definition.id === 'project.snapshot' ? ' Inspect this before planning or using a document revision.' : ''}`,
      inputSchema: definition.inputSchema,
    }));
    if (definitions.some((definition) => definition.id === 'tool.search')) tools.push(MODEL_TOOL_INVOKE_DEFINITION);
    return Object.freeze(tools);
  }

  private async prepareKnowledge(project: ContextProjectSnapshot | null, signal: AbortSignal): Promise<void> {
    if (!this.options.prepareKnowledge) return;
    const timeoutMs = this.options.knowledgeRefreshTimeoutMs ?? 1_500;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new TypeError('Knowledge refresh timeout must be 1-10000 milliseconds.');
    const refreshController = new AbortController();
    const forwardAbort = () => refreshController.abort(signal.reason);
    signal.addEventListener('abort', forwardAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(new Error(`Knowledge refresh exceeded ${timeoutMs} ms; exact context will be used.`), { code: 'knowledge.refresh-timeout' });
        refreshController.abort(error); reject(error);
      }, timeoutMs);
    });
    try { await Promise.race([this.options.prepareKnowledge(project, refreshController.signal), deadline]); }
    catch (cause) {
      await this.options.operationLog.append({
        kind: 'knowledge/refresh-degraded', severity: 'warning', source: asStableId('studio.conversation-host'), correlation: {},
        payload: { code: errorCode(cause), message: errorMessage(cause), fallback: 'exact-context' },
      }, { signal }).catch(() => undefined);
    }
    finally {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener('abort', forwardAbort);
      if (!refreshController.signal.aborted) refreshController.abort(new Error('Knowledge refresh scope completed.'));
    }
  }

  private async commitContext(event: AgentBackendEvent, status: 'completed' | 'cancelled' | 'failed' | 'interrupted'): Promise<void> {
    const active = this.active;
    if (!active || active.contextCommitted || active.sessionId !== event.sessionId || active.turnId !== event.turnId) return;
    active.contextCommitted = true;
    await this.options.runtime.context.commit({
      conversationKey: active.conversationKey, backendId: active.backendId, taskId: active.taskId, sessionId: event.sessionId, turnId: event.turnId,
      projectId: active.projectId, goals: [active.goal], decisions: active.decisions, toolFacts: active.toolFacts,
      ...(active.providerStarted && active.tools ? { tools: active.tools } : {}),
      blockers: status === 'completed' ? active.blockers : [...active.blockers, `Turn ended with ${status}.`],
    });
  }

  private internalNodeId(kind: string, turnId: StableId): StableId { return asStableId(`node:${kind}:${sha256(turnId).slice(7, 23)}`); }
  private nextNodeId(kind: string): StableId { this.nodeSequence += 1; return this.localId(`node:${kind}:${this.nodeSequence}`); }
  private localId(value: string): StableId { return asStableId(this.options.idPrefix ? `${this.options.idPrefix}:${value}` : value); }
  private track(work: Promise<unknown>): void {
    this.pendingWork.add(work);
    void work.finally(() => this.pendingWork.delete(work)).catch(() => undefined);
  }
  private executionContent(context: ToolExecutionContext, body: HostToolBody, content: JsonObject): JsonObject {
    if (!this.options.recordProjectId) return content;
    return Object.freeze({ ...content, parameters: context.args, result: body.backendResult, executionStartedAt: new Date(Date.parse(body.finishedAt) - body.latencyMs).toISOString(), executionFinishedAt: body.finishedAt, durationMs: body.latencyMs });
  }
  private assertActive(): void { if (this.disposed) throw new Error('Conversation host is disposed.'); }
}
function isBackendSessionAdapter(backend: AgentBackend): backend is AgentBackend & BackendSessionAdapter {
  const candidate = backend as unknown as Record<string, unknown>;
  return typeof candidate.backendId === 'string'
    && typeof candidate.provider === 'string'
    && typeof candidate.capabilities === 'function'
    && typeof candidate.open === 'function'
    && typeof candidate.inspect === 'function'
    && typeof candidate.confirmBoundary === 'function'
    && typeof candidate.compact === 'function'
    && typeof candidate.detach === 'function';
}
function stablePayloadId(value: unknown, label: string): StableId { if (typeof value !== 'string') throw new TypeError(`${label} is invalid.`); return asStableId(value, label); }
function conversationKeyFor(project: ContextProjectSnapshot | null): StableId { return project ? asStableId(`conversation:${project.projectId}`) : asStableId('conversation:workspace-empty'); }
function turnKey(sessionId: StableId, turnId: StableId): string { return `${sessionId}\u0000${turnId}`; }
function isCompleteDurableSessionHandle(value: DurableSessionHandle): boolean {
  const candidate = value as unknown as Record<string, unknown>;
  return ['snapshot', 'append', 'appendMessage', 'replaceSurface', 'bindBackend', 'checkpoint', 'fork', 'flush', 'dispose'].every((key) => typeof candidate[key] === 'function');
}
function isPreparedMutationWork(value: HostToolWork): value is PreparedMutationWork { return isRecord(value) && value.kind === 'prepared-mutation'; }
function transactionResultIdentity(value: JsonObject): JsonObject | null {
  const transaction = value.transaction;
  if (!isRecord(transaction) || typeof transaction.transactionId !== 'string' || typeof transaction.idempotencyKey !== 'string' || typeof transaction.receiptDigest !== 'string' || typeof transaction.receiptArtifactId !== 'string') return null;
  return Object.freeze({ transactionId: transaction.transactionId, idempotencyKey: transaction.idempotencyKey, receiptDigest: transaction.receiptDigest, receiptArtifactId: transaction.receiptArtifactId, memberCount: Number.isSafeInteger(transaction.memberCount) ? transaction.memberCount : 1 });
}
