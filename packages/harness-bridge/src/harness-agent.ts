import type { HarnessTeamRecoveryOptions } from './team-recovery.js';
export type { HarnessTeamRecoveryOptions } from './team-recovery.js';
import { bindOfficialTools, type OfficialToolLifecycle } from './official-tools.js';
import { installExtendedTools } from './extended-tools.js';
export { createHarnessExtendedTools, type HarnessExtendedToolOptions } from './extended-tools.js';
export { createHarnessOfficialToolProvider } from './official-tools.js';
export { HARNESS_EXPERIMENTAL_ADMISSION } from './experimental-admission.js';
import { HarnessRequestContext, REQUEST_REBUILD } from './request-context.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import { isToolConcurrencyHintV1, type ToolConcurrencyHintV1, type StudioKernelHost, type StudioPluginActivationContext } from '@haiyue/ai-studio-contracts';
import { harnessOwnerContext } from './ownership.js';
import AgentRegistry, { installModelSelection, type AgentHandle, type AssistantStreamFrame, type ModelSelectionRef, type CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, DEFAULT_MAX_TOKENS, PUBLIC_BASE_URL, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools';

export interface HarnessBridgeTool { readonly id: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>>; readonly concurrency?: ToolConcurrencyHintV1; }
export type HarnessReasoningEffort = 'off' | 'low' | 'high' | 'max';
export interface HarnessBridgeTurnInput {
  readonly requestContext?: import('@haiyue/ai-studio-contracts').ModelRequestContextPortV1;
  readonly sessionId?: string; readonly prompt: string; readonly tools: readonly HarnessBridgeTool[];
  readonly model: string; readonly reasoningEffort: HarnessReasoningEffort; readonly maxTokens: number;
}
export interface HarnessBridgeSessionOpenInput {
  readonly sessionId?: string;
  readonly model: string;
  readonly reasoningEffort: HarnessReasoningEffort;
  readonly maxTokens: number;
  readonly tools: readonly HarnessBridgeTool[];
  readonly lastConfirmedOpId: string;
}
export interface HarnessBridgeSessionCapabilities {
  readonly maxInputTokens: number | null;
  readonly nativeCompaction: false;
  readonly parallelToolCalls: boolean;
  readonly codeMode: false;
  readonly providerUsage: 'reported';
  readonly providerCache: 'reported';
  readonly nativeCompactionTransport: 'unavailable';
  readonly nativeCompactionMirror: 'fallback-required';
  readonly diagnostic: Readonly<{ code: 'harness.compaction-driver-unavailable'; message: string }>;
}
export type HarnessBridgeSessionInspection =
  | Readonly<{ state: 'available'; sessionId: string; model: string; lastConfirmedOpId: string | null }>
  | Readonly<{ state: 'missing'; sessionId: string; diagnostic: Readonly<{ code: string; message: string }> }>;
export type HarnessBridgeEvent =
  | Readonly<{ type: 'batch-boundary'; sessionId: string; turnId: string; batchId: string; stepId: string; closed: boolean }>
  | Readonly<{ type: 'request-prepared'; sessionId: string; turnId: string; requestId: string }>
  | Readonly<{ type: 'request-confirmed'; sessionId: string; turnId: string; requestId: string }>
  | Readonly<{ type: 'turn-start'; sessionId: string; turnId: string }>
  | Readonly<{ type: 'text-delta'; sessionId: string; turnId: string; text: string }>
  | Readonly<{ type: 'tool-request'; sessionId: string; turnId: string; toolCallId: string; toolId: string; batchId?: string; stepId?: string; arguments: Readonly<Record<string, unknown>> }>
  | Readonly<{ type: 'usage'; sessionId: string; turnId: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }>
  | Readonly<{ type: 'turn-end'; sessionId: string; turnId: string; status: 'completed' | 'cancelled' | 'failed' | 'interrupted'; finishReason: 'stop' | 'length' | 'cancelled' | 'error' | 'unknown'; diagnostic?: Readonly<{ code: string; message: string }> }>;

export interface HarnessAgentTransport {
  readonly upstream: Readonly<{ tag: 'dsh-v0.2.0-rc.2'; commit: '639ed015397290b3745d163aafe02ffee4aa3f84' }>;
  modelCatalog(): readonly Readonly<{ id: string; name: string; description: string; maxTokens: number }>[];
  configured(): Promise<boolean>;
  sessionCapabilities(model: string): HarnessBridgeSessionCapabilities;
  openSession(input: HarnessBridgeSessionOpenInput, signal?: AbortSignal): Promise<Readonly<{ sessionId: string; capabilities: HarnessBridgeSessionCapabilities }>>;
  inspectSession(sessionId: string): Promise<HarnessBridgeSessionInspection>;
  confirmSessionBoundary(sessionId: string, lastConfirmedOpId: string): Promise<void>;
  compactSession(sessionId: string): Promise<Readonly<{ status: 'unavailable'; diagnostic: Readonly<{ code: string; message: string }> }>>;
  closeSession(sessionId: string): Promise<void>;
  start(input: HarnessBridgeTurnInput, signal?: AbortSignal): AsyncIterable<HarnessBridgeEvent>;
  submitToolResult(toolCallId: string, result: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface PinnedHarnessAgentTransportOptions {
  readonly owner: StudioKernelHost | StudioPluginActivationContext;
  /** Experimental durable Team scope. Requires explicit Studio authority; disabled when omitted. */
  readonly teamRecovery?: HarnessTeamRecoveryOptions;
  readonly resolveApiKey: () => Promise<string | null>;
  readonly model?: string;
  readonly baseURL?: string;
  /** W2 rollout: 1 restores serial dispatch; 2–4 enable bounded, registry-approved reads. */
  readonly maxParallelToolCalls?: 1 | 2 | 3 | 4;
  /** Explicit capacity for a custom endpoint; absence remains unknown. */
  readonly contextWindow?: number;
  readonly officialTools?: import('@haiyue/ai-studio-contracts').OfficialToolProviderV1;
}

interface HarnessRequestFailure { readonly code: string; readonly providerRetryAfterMs?: number; }
interface HarnessRequestRetryPolicy {
  readonly mode: 'normal' | 'always';
  readonly maxRetries?: number;
  readonly retryableCodes?: readonly string[];
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

const STUDIO_MAX_HARNESS_REQUEST_RETRIES = 2;
// A profile selects one backend; keep all Harness services in its owned scope
// and reject a second live transport before loading any plugins.
const transportRoots = new WeakSet<Context>();

/** Resolve one bounded, deterministic retry delay from the provider-owned Harness policy. */
export function harnessRequestRetryDelayMs(failure: HarnessRequestFailure, policy: HarnessRequestRetryPolicy | undefined, failedAttempts: number): number | null {
  if (!policy || !Number.isSafeInteger(failedAttempts) || failedAttempts < 0) return null;
  const policyLimit = policy.mode === 'normal' ? Math.min(policy.maxRetries ?? 0, STUDIO_MAX_HARNESS_REQUEST_RETRIES) : STUDIO_MAX_HARNESS_REQUEST_RETRIES;
  if (failedAttempts >= policyLimit || (policy.mode === 'normal' && !policy.retryableCodes?.includes(failure.code))) return null;
  const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * (2 ** failedAttempts));
  const requested = Number.isFinite(failure.providerRetryAfterMs) && (failure.providerRetryAfterMs ?? 0) >= 0 ? failure.providerRetryAfterMs! : 0;
  return Math.max(0, Math.min(policy.maxDelayMs, Math.max(exponential, requested)));
}

export async function createPinnedHarnessAgentTransport(options: PinnedHarnessAgentTransportOptions): Promise<HarnessAgentTransport> {
  const maxParallelToolCalls = options.maxParallelToolCalls ?? 4;
  if (options.contextWindow !== undefined && (!Number.isSafeInteger(options.contextWindow) || options.contextWindow < 1024 || options.contextWindow > 100_000_000)) throw new TypeError('Invalid Harness context capacity.');
  if (![1, 2, 3, 4].includes(maxParallelToolCalls)) throw new TypeError('Harness maxParallelToolCalls must be 1–4.');
  const parent = harnessOwnerContext(options.owner);
  const root = parent.root;
  if (transportRoots.has(root)) throw new Error('Studio root already has a live Harness transport.');
  const scope = parent.plugin({ name: 'studio:harness-agent-transport', apply() {} });
  transportRoots.add(root);
  const context = scope.ctx;
  try {
    await scope;
    context.effect(() => () => { transportRoots.delete(root); }, 'studio.harness-transport-owner');
    await context.plugin(AgentRegistry);
    await context.plugin(SessionStore);
    await context.plugin(SessionProjections);
    await context.plugin(LlmRuntime);
    await context.plugin(SystemPrompt, { includeRuntimeContext: false });
    await context.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: maxParallelToolCalls });
    const selectedModel = options.model ?? 'deepseek-flash';
    const resolved = resolveAdapterOptions({
      baseURL: messagesBaseURL(options.baseURL), thinking: 'enabled', reasoningEffort: 'high',
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    const adapter = new DeepSeekAdapter({
      options: () => resolved,
      resolveAuth: async () => {
        const value = await options.resolveApiKey();
        if (!value) throw Object.assign(new Error('DeepSeek API key is not configured.'), { code: 'MISSING_CREDENTIAL', status: 401 });
        if (/\r|\n/u.test(value)) throw Object.assign(new Error('DeepSeek API key is invalid.'), { code: 'INVALID_CREDENTIAL' });
        return { headers: { 'x-api-key': value, Authorization: `Bearer ${value}` } };
      },
      resolveUserId: () => randomUUID() as AnonymousUserId,
      // Studio owns its logs and credentials. No optional Harness upload or
      // plugin metadata services are mounted into this transport.
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    });
    await context.plugin({
      name: 'studio:harness-agent-adapter', inject: ['llm'],
      apply(ctx) { ctx.llm.registerAdapter(['deepseek-official'], adapter); },
    });
    await context.plugin(AgentLoop, { maxParallelToolCalls, agents: [] });
    if (options.teamRecovery) {
      const { installTeamRecovery } = await import('./team-recovery.js');
      await installTeamRecovery(context, options.teamRecovery);
    }
    let transport: PinnedHarnessTransport | undefined;
    await context.plugin({
      name: 'studio:harness-agent-client', inject: ['agents', 'sessions', 'llm', 'systemPrompt', 'tools', 'agentLoop'],
      apply(ctx) { transport = new PinnedHarnessTransport(ctx, selectedModel, resolved.models, resolved.baseURL === PUBLIC_BASE_URL, options.resolveApiKey, () => disposeHarnessScope(scope), maxParallelToolCalls, options.contextWindow); },
    });
    harnessOwnerContext(options.owner);
    if (!transport) throw new Error('Harness transport did not activate.');
    if (options.officialTools) transport.bindOfficialProvider(options.officialTools);
    if (options.officialTools) await installExtendedTools(options.officialTools, context, options.resolveApiKey);
    return transport;
  } catch (cause) {
    try { await disposeHarnessScope(scope); } finally { transportRoots.delete(root); }
    throw cause;
  }
}

async function disposeHarnessScope(scope: Fiber): Promise<void> {
  await scope.dispose();
  // Cordis' public disposer is single-shot; an ancestor may already own the drain.
  while (scope.inertia) await scope.inertia;
}

class PinnedHarnessTransport implements HarnessAgentTransport {
  readonly upstream = Object.freeze({ tag: 'dsh-v0.2.0-rc.2' as const, commit: '639ed015397290b3745d163aafe02ffee4aa3f84' as const });
  private readonly requestContexts = new Map<string, HarnessRequestContext>();
  private readonly handles = new Map<string, AgentHandle>();
  private readonly initializing = new Map<string, { readonly abort: AbortController; readonly settled: Promise<void> }>();
  private readonly selections = new Map<string, ModelSelectionRef>();
  private readonly sessionModels = new Map<string, string>();
  private readonly sessionBoundaries = new Map<string, string>();
  private readonly sessionToolSignatures = new Map<string, string>();
  private readonly stepBatches = new Map<string, Readonly<{ batchId: string; stepId: string }>>();
  private readonly streams = new Map<string, AsyncEventQueue<HarnessBridgeEvent>>();
  private readonly results = new Map<string, Deferred<Readonly<Record<string, unknown>>>>();
  private disposed = false;
  private disposal?: Promise<void>;
  private readonly assistantAttempts = new Map<string, Readonly<{ attemptId: string; revision: number; turn: number }>>();
  constructor(private readonly context: Context, private readonly model: string, private readonly models: readonly Readonly<{ id: string; name?: string; description?: string; maxTokens?: number; contextWindow?: number }>[], private readonly officialEndpoint: boolean, private readonly resolveApiKey: () => Promise<string | null>, private readonly disposeScope: () => Promise<void>, private readonly maxParallelToolCalls: number, private readonly contextWindow?: number) {
    if (!models.some((entry) => entry.id === model)) throw new Error(`Harness default model ${model} is not in the pinned catalog.`);
    context.effect(() => () => this.release(), 'studio.harness-transport.dispose');
    const contexts = this.requestContexts;
    context.on('llm/stream', async function* (request, next) {
      const guard = request.sessionId ? contexts.get(String(request.sessionId)) : undefined;
      if (guard) yield* guard.stream(request, next); else yield* next();
    });
    context.on('session/event', (session, event) => this.onSessionEvent(String(session.id), event));
    context.on('agent/assistant-stream', ({ agent, frame }) => this.onAssistantStream(String(agent.id), frame));
  }
  private officialLifecycle?: OfficialToolLifecycle;
  private readonly studioToolNames = new Map<string, ReadonlySet<string>>();
  bindOfficialProvider(port: import('@haiyue/ai-studio-contracts').OfficialToolProviderV1): void {
    const lifecycle = this.officialLifecycle = bindOfficialTools(port, this.context, id => this.handles.get(id)?.agent, id => this.studioToolNames.get(id) ?? new Set());
    this.context.effect(() => lifecycle.release, 'studio.official-tools.release');
  }
  modelCatalog(): readonly Readonly<{ id: string; name: string; description: string; maxTokens: number }>[] {
    // The backend uses the first entry as its default. Keep the Studio-selected
    // model stable when upstream adds or reorders catalog entries.
    const ordered = [...this.models.filter((entry) => entry.id === this.model), ...this.models.filter((entry) => entry.id !== this.model)];
    return Object.freeze(ordered.map((entry) => Object.freeze({ id: entry.id, name: entry.name ?? entry.id, description: entry.description ?? entry.name ?? entry.id, maxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS })));
  }
  async configured(): Promise<boolean> { return Boolean(await this.resolveApiKey()); }
  sessionCapabilities(model: string): HarnessBridgeSessionCapabilities {
    const catalog = this.models.find((entry) => entry.id === model);
    if (!catalog) throw new Error(`Harness model ${model} is not in the pinned catalog.`);
    return Object.freeze({
      maxInputTokens: this.contextWindow ?? (this.officialEndpoint ? catalog.contextWindow ?? null : null),
      nativeCompaction: false,
      parallelToolCalls: this.maxParallelToolCalls > 1,
      codeMode: false,
      providerUsage: 'reported',
      providerCache: 'reported',
      nativeCompactionTransport: 'unavailable',
      nativeCompactionMirror: 'fallback-required',
      diagnostic: Object.freeze({ code: 'harness.compaction-driver-unavailable', message: 'Harness native compaction is not mounted; use Studio compaction. Context capacity comes from the pinned official model catalog and remains unknown for custom endpoints.' }),
    });
  }
  async openSession(input: HarnessBridgeSessionOpenInput, signal?: AbortSignal): Promise<Readonly<{ sessionId: string; capabilities: HarnessBridgeSessionCapabilities }>> {
    this.assertActive();
    const sessionId = input.sessionId ?? `harness-session-${randomUUID()}`;
    await this.ensureHandle(sessionId, input, signal);
    this.assertActive();
    this.sessionBoundaries.set(sessionId, input.lastConfirmedOpId);
    return Object.freeze({ sessionId, capabilities: this.sessionCapabilities(input.model) });
  }
  async inspectSession(sessionId: string): Promise<HarnessBridgeSessionInspection> {
    this.assertActive();
    return this.handles.has(sessionId)
      ? Object.freeze({ state: 'available', sessionId, model: this.sessionModels.get(sessionId)!, lastConfirmedOpId: this.sessionBoundaries.get(sessionId) ?? null })
      : Object.freeze({ state: 'missing', sessionId, diagnostic: Object.freeze({ code: 'harness.session-missing', message: `Harness Session ${sessionId} is not live in this process.` }) });
  }
  async confirmSessionBoundary(sessionId: string, lastConfirmedOpId: string): Promise<void> {
    this.assertActive();
    if (!this.handles.has(sessionId)) throw new Error(`Harness Session ${sessionId} is not live.`);
    this.sessionBoundaries.set(sessionId, lastConfirmedOpId);
  }
  async compactSession(sessionId: string): Promise<Readonly<{ status: 'unavailable'; diagnostic: Readonly<{ code: string; message: string }> }>> {
    this.assertActive();
    if (!this.handles.has(sessionId)) throw new Error(`Harness Session ${sessionId} is not live.`);
    return Object.freeze({ status: 'unavailable', diagnostic: Object.freeze({ code: 'harness.compaction-driver-unavailable', message: 'Harness native compaction is not mounted; use Studio compaction.' }) });
  }
  async closeSession(sessionId: string): Promise<void> {
    this.assertActive();
    const pending = this.initializing.get(sessionId);
    if (pending) { pending.abort.abort(new Error('Harness session closed during initialization.')); await pending.settled; }
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    handle.agent.cancel({ kind: 'disposed' });
    await this.officialLifecycle?.cancelSession(sessionId);
    await handle.dispose();
    this.assistantAttempts.delete(sessionId);
    this.stepBatches.delete(sessionId); this.requestContexts.delete(sessionId); this.studioToolNames.delete(sessionId); this.handles.delete(sessionId); this.selections.delete(sessionId); this.sessionModels.delete(sessionId); this.sessionBoundaries.delete(sessionId); this.sessionToolSignatures.delete(sessionId);
  }
  async *start(input: HarnessBridgeTurnInput, signal?: AbortSignal): AsyncIterable<HarnessBridgeEvent> {
    this.assertActive();
    if (typeof input.prompt !== 'string' || input.prompt.length === 0 || input.prompt.length > 200_000) throw new TypeError('Harness prompt is invalid.');
    const sessionId = input.sessionId ?? `harness-session-${randomUUID()}`;
    const handle = await this.ensureHandle(sessionId, input, signal);
    this.assertActive();
    signal?.throwIfAborted();
    if (this.streams.has(sessionId)) throw new Error(`Harness session ${sessionId} already has an active turn.`);
    const selection = this.selections.get(sessionId); if (selection) selection.current = { provider: 'deepseek-official', model: input.model, reasoningEffort: ReasoningEffortId(input.reasoningEffort) };
    handle.agent.options.maxTokens = input.maxTokens;
    this.requestContexts.get(sessionId)!.port = input.requestContext;
    const queue = new AsyncEventQueue<HarnessBridgeEvent>(); this.streams.set(sessionId, queue);
    const abort = (): void => handle!.agent.cancel({ kind: 'user' });
    signal?.addEventListener('abort', abort, { once: true });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: input.prompt }], source: { kind: 'user' } }));
    try { yield* queue; }
    finally { signal?.removeEventListener('abort', abort); if (this.streams.get(sessionId) === queue) { this.streams.delete(sessionId); this.stepBatches.delete(sessionId); this.assistantAttempts.delete(sessionId); } }
  }
  async submitToolResult(toolCallId: string, result: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason; const pending = this.results.get(toolCallId); if (!pending) throw new Error(`Harness tool call ${toolCallId} is not pending.`); this.results.delete(toolCallId); pending.resolve(Object.freeze({ ...result }));
  }
  async cancel(sessionId: string): Promise<void> {
    const pending = this.initializing.get(sessionId);
    if (pending) { pending.abort.abort(new Error('Harness session initialization cancelled.')); await pending.settled; }
    this.handles.get(sessionId)?.agent.cancel({ kind: 'user' });
    await this.officialLifecycle?.cancelSession(sessionId);
  }
  dispose(): Promise<void> {
    this.release();
    return this.disposal ??= this.disposeScope();
  }
  private release(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.initializing.values()) pending.abort.abort(new Error('Harness transport disposed.'));
    for (const pending of this.results.values()) pending.reject(new Error('Harness transport disposed.'));
    this.results.clear();
    this.streams.forEach((queue) => queue.fail(new Error('Harness transport disposed.')));
    this.streams.clear(); this.stepBatches.clear(); this.requestContexts.clear(); this.handles.clear(); this.selections.clear(); this.sessionModels.clear(); this.sessionBoundaries.clear(); this.sessionToolSignatures.clear();
    this.assistantAttempts.clear();
  }
  private async ensureHandle(sessionId: string, input: Pick<HarnessBridgeSessionOpenInput, 'model' | 'reasoningEffort' | 'maxTokens' | 'tools'>, signal?: AbortSignal): Promise<AgentHandle> {
    signal?.throwIfAborted();
    this.sessionCapabilities(input.model);
    if (this.initializing.has(sessionId)) throw new Error(`Harness Session ${sessionId} is still initializing.`);
    let handle = this.handles.get(sessionId);
    if (handle) {
      if (this.sessionModels.get(sessionId) !== input.model) throw new Error(`Harness Session ${sessionId} cannot change models without rebinding.`);
      if (this.sessionToolSignatures.get(sessionId) !== harnessToolSetSignature(input.tools)) throw new Error(`Harness Session ${sessionId} cannot change its Studio tool allowlist without rebinding.`);
      return handle;
    }
    const selection: ModelSelectionRef = { current: { provider: 'deepseek-official', model: input.model, reasoningEffort: ReasoningEffortId(input.reasoningEffort) }, assembled: undefined };
    const abort = new AbortController();
    const settled = deferred<void>();
    this.initializing.set(sessionId, { abort, settled: settled.promise });
    const creationSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    try {
      const creation: CreateAgentOptions = {
        sessionId: SessionId(sessionId), agentOptions: { provider: 'deepseek-official', model: input.model, maxTokens: input.maxTokens }, signal: creationSignal,
        setup: (agentContext, agent) => {
          const requestContext = new HarnessRequestContext(agent.session, model => this.sessionCapabilities(model).maxInputTokens, (requestId, turnId, confirmed) => this.streams.get(sessionId)?.push({ type: confirmed ? 'request-confirmed' : 'request-prepared', sessionId, turnId, requestId }));
          for (const event of agent.session.snapshotEvents()) requestContext.observe(event);
          this.requestContexts.set(sessionId, requestContext);
          installModelSelection(agentContext, selection);
          const failedAttempts = new Map<string, number>();
          agentContext.on('agent/request-error', async (payload, next) => {
            if (payload.failure.code === REQUEST_REBUILD && requestContext.rebuild()) return Object.freeze({ kind: 'retry' as const });
            const key = `${payload.turn}:${payload.step}`;
            const attempt = failedAttempts.get(key) ?? 0;
            const delayMs = harnessRequestRetryDelayMs(payload.failure, payload.retryPolicy, attempt);
            if (delayMs === null) return next();
            failedAttempts.set(key, attempt + 1);
            await abortableDelay(delayMs, payload.signal);
            return Object.freeze({ kind: 'retry' as const });
          });
          this.studioToolNames.set(sessionId, new Set(input.tools.map((tool, index) => harnessToolName(tool.id, index))));
          input.tools.forEach((tool, index) => agentContext.tools.register(this.toolDefinition(tool, index)));
        },
      };
      const stored = await this.context.get('sessionPersistence')?.stat(SessionId(sessionId), { signal: creationSignal });
      handle = stored ? await this.context.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: creation.agentOptions, setup: creation.setup, signal: creationSignal }) : await this.context.agents.create(creation);
      try { this.assertActive(); creationSignal.throwIfAborted(); }
      catch (cause) { await handle.dispose(); throw cause; }
      this.handles.set(sessionId, handle); this.selections.set(sessionId, selection); this.sessionModels.set(sessionId, input.model); this.sessionToolSignatures.set(sessionId, harnessToolSetSignature(input.tools));
      return handle;
    } catch (cause) {
      this.requestContexts.delete(sessionId); this.studioToolNames.delete(sessionId);
      throw cause;
    } finally {
      this.initializing.delete(sessionId);
      settled.resolve();
    }
  }
  private toolDefinition(tool: HarnessBridgeTool, index: number): ToolDefinition {
    // Snapshot trusted metadata; neither provider arguments nor later object mutation may grant concurrency.
    const concurrency: unknown = tool.concurrency ? JSON.parse(JSON.stringify(tool.concurrency)) : undefined;
    return {
      name: harnessToolName(tool.id, index), description: `${tool.description}\nStudio tool id: ${tool.id}`, parameters: tool.inputSchema as Record<string, unknown>,
      isConcurrencySafe: args => isParallelHarnessToolCall(tool.id, concurrency, args),
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, execution) => {
        if (execution.signal.aborted) throw execution.signal.reason;
        const queue = execution.agent ? this.streams.get(String(execution.agent.id)) : undefined;
        if (!queue) throw new Error('Harness tool call has no active Studio turn.');
        const turn = this.requestContexts.get(String(execution.agent?.id))?.turn;
        if (!turn) throw new Error('Harness tool call has no current Studio turn.');
        const callId = String(execution.callId); const pending = deferred<Readonly<Record<string, unknown>>>(); this.results.set(callId, pending);
        queue?.push(Object.freeze({ type: 'tool-request', sessionId: String(execution.agent?.id ?? ''), turnId: turnId(String(execution.agent?.id ?? ''), turn), toolCallId: callId, toolId: tool.id, ...this.stepBatches.get(String(execution.agent?.id ?? '')), arguments: isRecord(args) ? Object.freeze({ ...args }) : Object.freeze({}) }));
        const abort = (): void => pending.reject(execution.signal.reason); execution.signal.addEventListener('abort', abort, { once: true });
        try { return await pending.promise; } finally { execution.signal.removeEventListener('abort', abort); this.results.delete(callId); }
      },
    };
  }
  private onSessionEvent(sessionId: string, event: SessionEvent): void {
    this.requestContexts.get(sessionId)?.observe(event);
    const queue = this.streams.get(sessionId); if (!queue) return;
    if (event.type === 'step/start' || event.type === 'step/end') {
      const stepId = `step:${createHash('sha256').update(`${sessionId}:${event.data.turn}:${event.data.step}`).digest('hex')}`;
      const batchId = `batch:${stepId.slice(5)}`;
      if (event.type === 'step/start') this.stepBatches.set(sessionId, { batchId, stepId });
      else this.stepBatches.delete(sessionId);
      queue.push({ type: 'batch-boundary', sessionId, turnId: turnId(sessionId, event.data.turn), batchId, stepId, closed: event.type === 'step/end' });
    }
    else if (event.type === 'turn/start') queue.push(Object.freeze({ type: 'turn-start', sessionId, turnId: turnId(sessionId, event.data.turn) }));
    else if (event.type === 'assistant/message' && event.data.usage) queue.push(Object.freeze({ type: 'usage', sessionId, turnId: turnId(sessionId, event.data.turn), ...event.data.usage }));
    else if (event.type === 'turn/end') {
      try { this.requestContexts.get(sessionId)?.finish(); } catch (cause) { queue.fail(cause); return; }
      const reason = event.data.reason; const status = reason.kind === 'completed' || reason.kind === 'max-tokens' ? 'completed' : reason.kind === 'aborted' ? 'cancelled' : reason.kind === 'interrupted' ? 'interrupted' : 'failed';
      const diagnostic = reason.kind === 'error' ? Object.freeze({ code: reason.error.code, message: reason.error.message }) : undefined;
      const finishReason = reason.kind === 'completed' ? 'stop' : reason.kind === 'max-tokens' ? 'length' : reason.kind === 'aborted' ? 'cancelled' : reason.kind === 'error' ? 'error' : 'unknown';
      this.stepBatches.delete(sessionId);
      this.assistantAttempts.delete(sessionId);
      queue.push(Object.freeze({ type: 'turn-end', sessionId, turnId: turnId(sessionId, event.data.turn), status, finishReason, ...(diagnostic ? { diagnostic } : {}) })); queue.close();
    }
  }
  private onAssistantStream(sessionId: string, frame: AssistantStreamFrame): void {
    const queue = this.streams.get(sessionId); if (!queue || this.disposed) return;
    if (frame.type === 'start') {
      const previous = this.assistantAttempts.get(sessionId);
      if (previous && frame.revision <= previous.revision) return;
      this.assistantAttempts.set(sessionId, { attemptId: String(frame.attemptId), revision: frame.revision, turn: frame.turn });
      return;
    }
    const attempt = this.assistantAttempts.get(sessionId);
    if (!attempt || attempt.attemptId !== String(frame.attemptId) || frame.revision <= attempt.revision) return;
    if (frame.type === 'end') this.assistantAttempts.delete(sessionId);
    else {
      this.assistantAttempts.set(sessionId, { ...attempt, revision: frame.revision });
      if (frame.chunk.type === 'text-delta') queue.push(Object.freeze({ type: 'text-delta', sessionId, turnId: turnId(sessionId, attempt.turn), text: frame.chunk.text }));
    }
  }
  private assertActive(): void { if (this.disposed || this.context.fiber.uid === null) throw new Error('Harness transport is disposed.'); }
}

export function harnessToolName(toolId: string, index: number): string {
  const normalized = toolId.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'tool';
  return `studio_${index}_${normalized}`;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = []; private waiters: Deferred<IteratorResult<T>>[] = []; private ended = false; private error: unknown;
  push(value: T): void { if (this.ended) return; const waiter = this.waiters.shift(); if (waiter) waiter.resolve({ done: false, value }); else this.values.push(value); }
  close(): void { if (this.ended) return; this.ended = true; for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined }); }
  fail(cause: unknown): void { if (this.ended) return; this.ended = true; this.error = cause; for (const waiter of this.waiters.splice(0)) waiter.reject(cause); }
  async *[Symbol.asyncIterator](): AsyncIterator<T> { while (true) { if (this.values.length) { yield this.values.shift()!; continue; } if (this.error) throw this.error; if (this.ended) return; const waiter = deferred<IteratorResult<T>>(); this.waiters.push(waiter); const next = await waiter.promise; if (next.done) return; yield next.value; } }
}
interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(cause: unknown): void; }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (cause?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function turnId(sessionId: string, turn: number): string { return `${sessionId}:turn:${turn}`; }
/** Migrate only the known official legacy roots; never guess a custom gateway's protocol. */
function messagesBaseURL(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/u, '');
  if (url.origin === 'https://api.deepseek.com' && ['', '/v1', '/chat/completions', '/v1/chat/completions', '/anthropic', '/anthropic/v1'].includes(path) && !url.search && !url.hash && !url.username && !url.password) return PUBLIC_BASE_URL;
  if (/\/chat\/completions$/u.test(path)) throw new Error('harness.endpoint-migration-required: configure a Messages API base URL for this gateway.');
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function harnessToolSetSignature(tools: readonly HarnessBridgeTool[]): string { return createHash('sha256').update(stableJson(tools.map((tool) => ({ id: tool.id, description: tool.description, inputSchema: tool.inputSchema, ...(tool.concurrency ? { concurrency: tool.concurrency } : {}) })))).digest('hex'); }
function isParallelHarnessToolCall(toolId: string, hint: unknown, args: unknown): boolean {
  if (!isToolConcurrencyHintV1(hint)) return false;
  if (toolId !== 'studio.tool.invoke') return hint.mode === 'parallel-read';
  if (hint.mode !== 'invoke' || !isRecord(args) || Object.keys(args).length !== 3
    || Object.keys(args).some(key => !['toolId', 'toolVersion', 'arguments'].includes(key))
    || !isRecord(args.arguments) || Object.keys(args.arguments).length > 256) return false;
  return hint.targets.some(target => target.toolId === args.toolId && target.toolVersion === args.toolVersion);
}
function stableJson(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'; if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`; }
function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    function done(): void { signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}
