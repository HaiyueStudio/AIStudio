import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools';

export interface HarnessBridgeTool { readonly id: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>>; }
export interface HarnessBridgeTurnInput { readonly sessionId?: string; readonly prompt: string; readonly tools: readonly HarnessBridgeTool[]; }
export type HarnessBridgeEvent =
  | Readonly<{ type: 'turn-start'; sessionId: string; turnId: string }>
  | Readonly<{ type: 'text-delta'; sessionId: string; turnId: string; text: string }>
  | Readonly<{ type: 'tool-request'; sessionId: string; turnId: string; toolCallId: string; toolId: string; arguments: Readonly<Record<string, unknown>> }>
  | Readonly<{ type: 'usage'; sessionId: string; turnId: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number }>
  | Readonly<{ type: 'turn-end'; sessionId: string; turnId: string; status: 'completed' | 'cancelled' | 'failed' | 'interrupted'; diagnostic?: Readonly<{ code: string; message: string }> }>;

export interface HarnessAgentTransport {
  readonly upstream: Readonly<{ tag: 'dsh-v0.1.0-rc.7'; commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' }>;
  configured(): Promise<boolean>;
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
  const resolved = resolveAdapterOptions({
    apiKeyEnv: 'HAIYUE_STUDIO_DEEPSEEK_SECRET', baseURL: options.baseURL, thinking: 'disabled', reasoningEffort: 'off',
    maxTokens: 8_192, models: [{ id: options.model ?? 'deepseek-chat', contextWindow: 128_000, maxTokens: 8_192 }],
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
  return new PinnedHarnessTransport(context, options.model ?? 'deepseek-chat', options.resolveApiKey);
}

class PinnedHarnessTransport implements HarnessAgentTransport {
  readonly upstream = Object.freeze({ tag: 'dsh-v0.1.0-rc.7' as const, commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' as const });
  private readonly handles = new Map<string, AgentHandle>();
  private readonly streams = new Map<string, AsyncEventQueue<HarnessBridgeEvent>>();
  private readonly results = new Map<string, Deferred<Readonly<Record<string, unknown>>>>();
  private disposed = false;
  constructor(private readonly context: Context, private readonly model: string, private readonly resolveApiKey: () => Promise<string | null>) {
    context.on('session/event', (session, event) => this.onSessionEvent(String(session.id), event));
  }
  async configured(): Promise<boolean> { return Boolean(await this.resolveApiKey()); }
  async *start(input: HarnessBridgeTurnInput, signal?: AbortSignal): AsyncIterable<HarnessBridgeEvent> {
    this.assertActive();
    if (typeof input.prompt !== 'string' || input.prompt.length === 0 || input.prompt.length > 200_000) throw new TypeError('Harness prompt is invalid.');
    const sessionId = input.sessionId ?? `harness-session-${randomUUID()}`;
    let handle = this.handles.get(sessionId);
    if (!handle) {
      handle = await this.context.agents.create({
        sessionId: SessionId(sessionId), agentOptions: { provider: 'deepseek-official', model: this.model, maxTokens: 8_192 }, signal,
        setup: (agentContext) => {
          input.tools.forEach((tool, index) => agentContext.tools.register(this.toolDefinition(tool, index)));
        },
      });
      this.handles.set(sessionId, handle);
    }
    if (this.streams.has(sessionId)) throw new Error(`Harness session ${sessionId} already has an active turn.`);
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
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; for (const pending of this.results.values()) pending.reject(new Error('Harness transport disposed.')); this.results.clear(); this.streams.forEach((queue) => queue.fail(new Error('Harness transport disposed.'))); this.streams.clear(); await this.context.fiber.dispose(); this.handles.clear(); }
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
      queue.push(Object.freeze({ type: 'turn-end', sessionId, turnId: turnId(sessionId, event.data.turn), status, ...(diagnostic ? { diagnostic } : {}) })); queue.close();
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
