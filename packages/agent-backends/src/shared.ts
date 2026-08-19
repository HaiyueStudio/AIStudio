import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { AgentBackendEvent } from '@haiyue/ai-studio-agent-runtime';

export class TurnChannel {
  private readonly history: AgentBackendEvent[] = [];
  private readonly queues = new Set<AsyncQueue<AgentBackendEvent>>();
  private terminal = false;
  emit(value: AgentBackendEvent): void { if (this.terminal) return; this.history.push(value); for (const queue of this.queues) queue.push(value); if (value.kind === 'completed') this.close(); }
  stream(): AsyncIterable<AgentBackendEvent> { const queue = new AsyncQueue<AgentBackendEvent>(); for (const item of this.history) queue.push(item); if (this.terminal) queue.close(); else this.queues.add(queue); return queue.iterable(() => this.queues.delete(queue)); }
  close(): void { if (this.terminal) return; this.terminal = true; for (const queue of this.queues) queue.close(); this.queues.clear(); }
  fail(cause: unknown): void { if (this.terminal) return; this.terminal = true; for (const queue of this.queues) queue.fail(cause); this.queues.clear(); }
  terminalFailure(backendId: StableId, failure: Readonly<{ code: string; message: string; retryable: boolean }>, status: 'failed' | 'interrupted' = 'failed'): void {
    if (this.terminal) return; const last = this.history.at(-1); const suffix = String(Date.now());
    const sessionId = last?.sessionId ?? asStableId(`session:failed:${suffix}`); const turnId = last?.turnId ?? asStableId(`turn:failed:${suffix}`);
    this.emit(backendEvent(backendId, sessionId, turnId, 'diagnostic', failure)); this.emit(backendEvent(backendId, sessionId, turnId, 'completed', { status }));
  }
}
class AsyncQueue<T> {
  private values: T[] = []; private waiters: Deferred<IteratorResult<T>>[] = []; private ended = false; private error: unknown;
  push(value: T): void { const waiter = this.waiters.shift(); if (waiter) waiter.resolve({ done: false, value }); else if (!this.ended) this.values.push(value); }
  close(): void { this.ended = true; this.waiters.splice(0).forEach((item) => item.resolve({ done: true, value: undefined })); }
  fail(cause: unknown): void { this.error = cause; this.ended = true; this.waiters.splice(0).forEach((item) => item.reject(cause)); }
  iterable(cleanup: () => void): AsyncIterable<T> { const self = this; return { async *[Symbol.asyncIterator]() { try { while (true) { if (self.values.length) { yield self.values.shift()!; continue; } if (self.error) throw self.error; if (self.ended) return; const pending = deferred<IteratorResult<T>>(); self.waiters.push(pending); const next = await pending.promise; if (next.done) return; yield next.value; } } finally { cleanup(); } } }; }
}
export interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(cause: unknown): void; }
export function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (cause?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function backendEvent(backendId: StableId, sessionId: string, turnId: string, kind: AgentBackendEvent['kind'], payload: JsonObject): AgentBackendEvent { return Object.freeze({ schemaVersion: 1, backendId, sessionId: asStableId(sessionId), turnId: asStableId(turnId), kind, payload: Object.freeze(payload) }); }
export function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
