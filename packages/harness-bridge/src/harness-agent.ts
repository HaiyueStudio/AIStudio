import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { installModelSelection, type Agent, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
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
  readonly upstream: Readonly<{ tag: 'dsh-v0.1.0-rc.7'; commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' }>;
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
  readonly resolveApiKey: () => Promise<string | null>;
  readonly model?: string;
  readonly baseURL?: string;
}

export async function createPinnedHarnessAgentTransport(options: PinnedHarnessAgentTransportOptions): Promise<HarnessAgentTransport> {
  const context = new Context();
  const fibers = [
    context.plugin(AgentRegistry), context.plugin(SessionStore), context.plugin(LlmRuntime), context.plugin(SystemPrompt, { includeRuntimeContext: false }),
  ];
  for (const fiber of fibers) await fiber;
  await context.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 });
  const selectedModel = options.model ?? 'deepseek-v4-flash';
  const resolved = resolveAdapterOptions({
    apiKeyEnv: 'HAIYUE_STUDIO_DEEPSEEK_SECRET', baseURL: options.baseURL, thinking: 'enabled', reasoningEffort: 'high',
    maxTokens: 384_000,
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
  });
  context.llm.registerAdapter(['deepseek-official'], adapter);
  await context.plugin(AgentLoop, { maxParallelToolCalls: 1, agents: [] });
  return new PinnedHarnessTransport(context, selectedModel, resolved.models, options.resolveApiKey);
}

class PinnedHarnessTransport implements HarnessAgentTransport {
  readonly upstream = Object.freeze({ tag: 'dsh-v0.1.0-rc.7' as const, commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' as const });
  private readonly handles = new Map<string, AgentHandle>();
  private readonly selections = new Map<string, ModelSelectionRef>();
  private readonly sessionModels = new Map<string, string>();
  private readonly sessionBoundaries = new Map<string, string>();
  private readonly sessionToolSignatures = new Map<string, string>();
  private readonly streams = new Map<string, AsyncEventQueue<HarnessBridgeEvent>>();
  private readonly results = new Map<string, Deferred<Readonly<Record<string, unknown>>>>();
  private disposed = false;
  constructor(private readonly context: Context, private readonly model: string, private readonly models: readonly Readonly<{ id: string; name?: string; description?: string; maxTokens?: number }>[], private readonly resolveApiKey: () => Promise<string | null>) {
    context.on('session/event', (session, event) => this.onSessionEvent(String(session.id), event));
  }
  modelCatalog(): readonly Readonly<{ id: string; name: string; description: string; maxTokens: number }>[] {
    return Object.freeze(this.models.map((entry) => Object.freeze({ id: entry.id, name: entry.name ?? entry.id, description: entry.description ?? entry.name ?? entry.id, maxTokens: entry.maxTokens ?? 384_000 })));
  }
  async configured(): Promise<boolean> { return Boolean(await this.resolveApiKey()); }
  sessionCapabilities(model: string): HarnessBridgeSessionCapabilities {
    const catalog = this.modelCatalog().find((entry) => entry.id === model);
    if (!catalog) throw new Error(`Harness model ${model} is not in the pinned catalog.`);
    return Object.freeze({
      maxInputTokens: null,
      nativeCompaction: false,
      parallelToolCalls: false,
      codeMode: false,
      providerUsage: 'reported',
      providerCache: 'reported',
      nativeCompactionTransport: 'unavailable',
      nativeCompactionMirror: 'fallback-required',
      diagnostic: Object.freeze({ code: 'harness.compaction-driver-unavailable', message: 'Pinned Harness exposes an output-token cap but no authoritative input Context Window or public compaction driver; model capacity remains unknown and Studio compaction is required.' }),
    });
  }
  async openSession(input: HarnessBridgeSessionOpenInput, signal?: AbortSignal): Promise<Readonly<{ sessionId: string; capabilities: HarnessBridgeSessionCapabilities }>> {
    this.assertActive();
    const sessionId = input.sessionId ?? `harness-session-${randomUUID()}`;
    await this.ensureHandle(sessionId, input, signal);
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
    return Object.freeze({ status: 'unavailable', diagnostic: Object.freeze({ code: 'harness.compaction-driver-unavailable', message: 'Pinned Harness has no public compaction driver; use Studio compaction.' }) });
  }
  async closeSession(sessionId: string): Promise<void> {
    this.assertActive();
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    handle.agent.cancel({ kind: 'disposed' });
    await handle.dispose();
    this.handles.delete(sessionId); this.selections.delete(sessionId); this.sessionModels.delete(sessionId); this.sessionBoundaries.delete(sessionId); this.sessionToolSignatures.delete(sessionId);
  }
  async *start(input: HarnessBridgeTurnInput, signal?: AbortSignal): AsyncIterable<HarnessBridgeEvent> {
    this.assertActive();
    if (typeof input.prompt !== 'string' || input.prompt.length === 0 || input.prompt.length > 200_000) throw new TypeError('Harness prompt is invalid.');
    const sessionId = input.sessionId ?? `harness-session-${randomUUID()}`;
    const handle = await this.ensureHandle(sessionId, input, signal);
    if (this.streams.has(sessionId)) throw new Error(`Harness session ${sessionId} already has an active turn.`);
    const selection = this.selections.get(sessionId); if (selection) selection.current = { provider: 'deepseek-official', model: input.model, reasoningEffort: ReasoningEffortId(input.reasoningEffort) };
    handle.agent.options.maxTokens = input.maxTokens;
    const queue = new AsyncEventQueue<HarnessBridgeEvent>(); this.streams.set(sessionId, queue);
    const abort = (): void => handle!.agent.cancel({ kind: 'user' });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: input.prompt }], source: { kind: 'user' } }));
    try { yield* queue; }
    finally { signal?.removeEventListener('abort', abort); if (this.streams.get(sessionId) === queue) this.streams.delete(sessionId); }
  }
  async submitToolResult(toolCallId: string, result: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason; const pending = this.results.get(toolCallId); if (!pending) throw new Error(`Harness tool call ${toolCallId} is not pending.`); this.results.delete(toolCallId); pending.resolve(Object.freeze({ ...result }));
  }
  async cancel(sessionId: string): Promise<void> { this.handles.get(sessionId)?.agent.cancel({ kind: 'user' }); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; for (const pending of this.results.values()) pending.reject(new Error('Harness transport disposed.')); this.results.clear(); this.streams.forEach((queue) => queue.fail(new Error('Harness transport disposed.'))); this.streams.clear(); await this.context.fiber.dispose(); this.handles.clear(); this.selections.clear(); this.sessionModels.clear(); this.sessionBoundaries.clear(); this.sessionToolSignatures.clear(); }
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
        input.tools.forEach((tool, index) => agentContext.tools.register(this.toolDefinition(tool, index)));
      },
    });
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
    else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') queue.push(Object.freeze({ type: 'text-delta', sessionId, turnId: turnId(sessionId, event.data.turn), text: event.data.chunk.text }));
    else if (event.type === 'assistant/message' && event.data.usage) queue.push(Object.freeze({ type: 'usage', sessionId, turnId: turnId(sessionId, event.data.turn), ...event.data.usage }));
    else if (event.type === 'turn/end') {
      const reason = event.data.reason; const status = reason.kind === 'completed' || reason.kind === 'max-tokens' ? 'completed' : reason.kind === 'aborted' ? 'cancelled' : reason.kind === 'interrupted' ? 'interrupted' : 'failed';
      const diagnostic = reason.kind === 'error' ? Object.freeze({ code: reason.error.code, message: reason.error.message }) : undefined;
      const finishReason = reason.kind === 'completed' ? 'stop' : reason.kind === 'max-tokens' ? 'length' : reason.kind === 'aborted' ? 'cancelled' : reason.kind === 'error' ? 'error' : 'unknown';
      queue.push(Object.freeze({ type: 'turn-end', sessionId, turnId: turnId(sessionId, event.data.turn), status, finishReason, ...(diagnostic ? { diagnostic } : {}) })); queue.close();
    }
  }
  private assertActive(): void { if (this.disposed) throw new Error('Harness transport is disposed.'); }
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
function latestTurn(agent: Agent | undefined): number { const events = agent?.session.events ?? []; for (let i = events.length - 1; i >= 0; i -= 1) { const event = events[i]!; if (event.type === 'turn/start') return event.data.turn; } return 1; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function harnessToolSetSignature(tools: readonly HarnessBridgeTool[]): string { return createHash('sha256').update(stableJson(tools.map((tool) => ({ id: tool.id, description: tool.description, inputSchema: tool.inputSchema })))).digest('hex'); }
function stableJson(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'; if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`; }
