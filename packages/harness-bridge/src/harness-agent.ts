import { createHash, randomUUID } from 'node:crypto';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { StudioKernelHost, StudioPluginActivationContext } from '@haiyue/ai-studio-contracts';
import { harnessOwnerContext } from './ownership.js';
import AgentRegistry, { installModelSelection, type Agent, type AgentHandle, type AssistantStreamFrame, type ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, DEFAULT_MAX_TOKENS, PUBLIC_BASE_URL, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools';

export interface HarnessBridgeTool { readonly id: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>>; }
export type HarnessReasoningEffort = 'off' | 'low' | 'high' | 'max';
export interface HarnessBridgeTurnInput {
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
  readonly parallelToolCalls: false;
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
  | Readonly<{ type: 'turn-start'; sessionId: string; turnId: string }>
  | Readonly<{ type: 'text-delta'; sessionId: string; turnId: string; text: string }>
  | Readonly<{ type: 'tool-request'; sessionId: string; turnId: string; toolCallId: string; toolId: string; arguments: Readonly<Record<string, unknown>> }>
  | Readonly<{ type: 'usage'; sessionId: string; turnId: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }>
  | Readonly<{ type: 'turn-end'; sessionId: string; turnId: string; status: 'completed' | 'cancelled' | 'failed' | 'interrupted'; finishReason: 'stop' | 'length' | 'cancelled' | 'error' | 'unknown'; diagnostic?: Readonly<{ code: string; message: string }> }>;

export interface HarnessAgentTransport {
  readonly upstream: Readonly<{ tag: 'dsh-v0.1.5-rc.2'; commit: 'fb2c4b9e698e30edb738bca4cf0618587db7d203' }>;
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
  readonly resolveApiKey: () => Promise<string | null>;
  readonly model?: string;
  readonly baseURL?: string;
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
    await context.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 });
    const selectedModel = options.model ?? 'deepseek-v4-flash';
    const resolved = resolveAdapterOptions({
      apiKeyEnv: 'HAIYUE_STUDIO_DEEPSEEK_SECRET', baseURL: options.baseURL, thinking: 'enabled', reasoningEffort: 'high',
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    const adapter = new DeepSeekAdapter({
      options: () => resolved,
      resolveApiKey: async () => {
        const value = await options.resolveApiKey();
        if (!value) throw Object.assign(new Error('DeepSeek API key is not configured.'), { code: 'MISSING_CREDENTIAL', status: 401 });
        if (/\r|\n/u.test(value)) throw Object.assign(new Error('DeepSeek API key is invalid.'), { code: 'INVALID_CREDENTIAL' });
        return value;
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
    await context.plugin(AgentLoop, { maxParallelToolCalls: 1, agents: [] });
    let transport: PinnedHarnessTransport | undefined;
    await context.plugin({
      name: 'studio:harness-agent-client', inject: ['agents', 'sessions', 'llm', 'systemPrompt', 'tools', 'agentLoop'],
      apply(ctx) { transport = new PinnedHarnessTransport(ctx, selectedModel, resolved.models, resolved.baseURL === PUBLIC_BASE_URL, options.resolveApiKey, () => disposeHarnessScope(scope)); },
    });
    harnessOwnerContext(options.owner);
    if (!transport) throw new Error('Harness transport did not activate.');
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
  readonly upstream = Object.freeze({ tag: 'dsh-v0.1.5-rc.2' as const, commit: 'fb2c4b9e698e30edb738bca4cf0618587db7d203' as const });
  private readonly handles = new Map<string, AgentHandle>();
  private readonly selections = new Map<string, ModelSelectionRef>();
  private readonly sessionModels = new Map<string, string>();
  private readonly sessionBoundaries = new Map<string, string>();
  private readonly sessionToolSignatures = new Map<string, string>();
  private readonly streams = new Map<string, AsyncEventQueue<HarnessBridgeEvent>>();
  private readonly results = new Map<string, Deferred<Readonly<Record<string, unknown>>>>();
  private disposed = false;
  private disposal?: Promise<void>;
  private readonly assistantAttempts = new Map<string, Readonly<{ attemptId: string; revision: number; turn: number }>>();
  constructor(private readonly context: Context, private readonly model: string, private readonly models: readonly Readonly<{ id: string; name?: string; description?: string; maxTokens?: number; contextWindow?: number }>[], private readonly officialEndpoint: boolean, private readonly resolveApiKey: () => Promise<string | null>, private readonly disposeScope: () => Promise<void>) {
    if (!models.some((entry) => entry.id === model)) throw new Error(`Harness default model ${model} is not in the pinned catalog.`);
    context.effect(() => () => this.release(), 'studio.harness-transport.dispose');
    context.on('session/event', (session, event) => this.onSessionEvent(String(session.id), event));
    context.on('agent/assistant-stream', ({ agent, frame }) => this.onAssistantStream(String(agent.id), frame));
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
      maxInputTokens: this.officialEndpoint ? catalog.contextWindow ?? null : null,
      nativeCompaction: false,
      parallelToolCalls: false,
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
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    handle.agent.cancel({ kind: 'disposed' });
    await handle.dispose();
    this.assistantAttempts.delete(sessionId);
    this.handles.delete(sessionId); this.selections.delete(sessionId); this.sessionModels.delete(sessionId); this.sessionBoundaries.delete(sessionId); this.sessionToolSignatures.delete(sessionId);
  }
  async *start(input: HarnessBridgeTurnInput, signal?: AbortSignal): AsyncIterable<HarnessBridgeEvent> {
    this.assertActive();
    if (typeof input.prompt !== 'string' || input.prompt.length === 0 || input.prompt.length > 200_000) throw new TypeError('Harness prompt is invalid.');
    const sessionId = input.sessionId ?? `harness-session-${randomUUID()}`;
    const handle = await this.ensureHandle(sessionId, input, signal);
    this.assertActive();
    if (this.streams.has(sessionId)) throw new Error(`Harness session ${sessionId} already has an active turn.`);
    const selection = this.selections.get(sessionId); if (selection) selection.current = { provider: 'deepseek-official', model: input.model, reasoningEffort: ReasoningEffortId(input.reasoningEffort) };
    handle.agent.options.maxTokens = input.maxTokens;
    const queue = new AsyncEventQueue<HarnessBridgeEvent>(); this.streams.set(sessionId, queue);
    const abort = (): void => handle!.agent.cancel({ kind: 'user' });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: input.prompt }], source: { kind: 'user' } }));
    try { yield* queue; }
    finally { signal?.removeEventListener('abort', abort); if (this.streams.get(sessionId) === queue) { this.streams.delete(sessionId); this.assistantAttempts.delete(sessionId); } }
  }
  async submitToolResult(toolCallId: string, result: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason; const pending = this.results.get(toolCallId); if (!pending) throw new Error(`Harness tool call ${toolCallId} is not pending.`); this.results.delete(toolCallId); pending.resolve(Object.freeze({ ...result }));
  }
  async cancel(sessionId: string): Promise<void> { this.handles.get(sessionId)?.agent.cancel({ kind: 'user' }); }
  dispose(): Promise<void> {
    this.release();
    return this.disposal ??= this.disposeScope();
  }
  private release(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.results.values()) pending.reject(new Error('Harness transport disposed.'));
    this.results.clear();
    this.streams.forEach((queue) => queue.fail(new Error('Harness transport disposed.')));
    this.streams.clear(); this.handles.clear(); this.selections.clear(); this.sessionModels.clear(); this.sessionBoundaries.clear(); this.sessionToolSignatures.clear();
    this.assistantAttempts.clear();
  }
  private async ensureHandle(sessionId: string, input: Pick<HarnessBridgeSessionOpenInput, 'model' | 'reasoningEffort' | 'maxTokens' | 'tools'>, signal?: AbortSignal): Promise<AgentHandle> {
    let handle = this.handles.get(sessionId);
    if (handle) {
      if (this.sessionModels.get(sessionId) !== input.model) throw new Error(`Harness Session ${sessionId} cannot change models without rebinding.`);
      if (this.sessionToolSignatures.get(sessionId) !== harnessToolSetSignature(input.tools)) throw new Error(`Harness Session ${sessionId} cannot change its Studio tool allowlist without rebinding.`);
      return handle;
    }
    const selection: ModelSelectionRef = { current: { provider: 'deepseek-official', model: input.model, reasoningEffort: ReasoningEffortId(input.reasoningEffort) }, assembled: undefined };
    handle = await this.context.agents.create({
      sessionId: SessionId(sessionId), agentOptions: { provider: 'deepseek-official', model: input.model, maxTokens: input.maxTokens }, signal,
      setup: (agentContext) => {
        installModelSelection(agentContext, selection);
        const failedAttempts = new Map<string, number>();
        agentContext.on('agent/request-error', async (payload, next) => {
          const key = `${payload.turn}:${payload.step}`;
          const attempt = failedAttempts.get(key) ?? 0;
          const delayMs = harnessRequestRetryDelayMs(payload.failure, payload.retryPolicy, attempt);
          if (delayMs === null) return next();
          failedAttempts.set(key, attempt + 1);
          await abortableDelay(delayMs, payload.signal);
          return Object.freeze({ kind: 'retry' as const });
        });
        input.tools.forEach((tool, index) => agentContext.tools.register(this.toolDefinition(tool, index)));
      },
    });
    try { this.assertActive(); }
    catch (cause) { await handle.dispose(); throw cause; }
    this.handles.set(sessionId, handle); this.selections.set(sessionId, selection); this.sessionModels.set(sessionId, input.model); this.sessionToolSignatures.set(sessionId, harnessToolSetSignature(input.tools));
    return handle;
  }
  private toolDefinition(tool: HarnessBridgeTool, index: number): ToolDefinition {
    return {
      name: harnessToolName(tool.id, index), description: `${tool.description}\nStudio tool id: ${tool.id}`, parameters: tool.inputSchema as Record<string, unknown>,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, execution) => {
        const callId = String(execution.callId); const pending = deferred<Readonly<Record<string, unknown>>>(); this.results.set(callId, pending);
        const turn = latestTurn(execution.agent); const queue = execution.agent ? this.streams.get(String(execution.agent.id)) : undefined;
        queue?.push(Object.freeze({ type: 'tool-request', sessionId: String(execution.agent?.id ?? ''), turnId: turnId(String(execution.agent?.id ?? ''), turn), toolCallId: callId, toolId: tool.id, arguments: isRecord(args) ? Object.freeze({ ...args }) : Object.freeze({}) }));
        const abort = (): void => pending.reject(execution.signal.reason); execution.signal.addEventListener('abort', abort, { once: true });
        try { return await pending.promise; } finally { execution.signal.removeEventListener('abort', abort); this.results.delete(callId); }
      },
    };
  }
  private onSessionEvent(sessionId: string, event: SessionEvent): void {
    const queue = this.streams.get(sessionId); if (!queue) return;
    if (event.type === 'turn/start') queue.push(Object.freeze({ type: 'turn-start', sessionId, turnId: turnId(sessionId, event.data.turn) }));
    else if (event.type === 'assistant/message' && event.data.usage) queue.push(Object.freeze({ type: 'usage', sessionId, turnId: turnId(sessionId, event.data.turn), ...event.data.usage }));
    else if (event.type === 'turn/end') {
      const reason = event.data.reason; const status = reason.kind === 'completed' || reason.kind === 'max-tokens' ? 'completed' : reason.kind === 'aborted' ? 'cancelled' : reason.kind === 'interrupted' ? 'interrupted' : 'failed';
      const diagnostic = reason.kind === 'error' ? Object.freeze({ code: reason.error.code, message: reason.error.message }) : undefined;
      const finishReason = reason.kind === 'completed' ? 'stop' : reason.kind === 'max-tokens' ? 'length' : reason.kind === 'aborted' ? 'cancelled' : reason.kind === 'error' ? 'error' : 'unknown';
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
function latestTurn(agent: Agent | undefined): number { const events = agent?.session.snapshotEvents() ?? []; for (let i = events.length - 1; i >= 0; i -= 1) { const event = events[i]!; if (event.type === 'turn/start') return event.data.turn; } return 1; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function harnessToolSetSignature(tools: readonly HarnessBridgeTool[]): string { return createHash('sha256').update(stableJson(tools.map((tool) => ({ id: tool.id, description: tool.description, inputSchema: tool.inputSchema })))).digest('hex'); }
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
