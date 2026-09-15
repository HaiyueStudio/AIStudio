import { requiresSerialOrder } from './classify.js';
import type { ToolBatchNodeV1 } from '@haiyue/ai-studio-contracts';
import { ToolBatchProtocolError, type RollingToolBatchOptions, type RollingToolWorkResult, type ToolBatchDiagnostic } from './types.js';

interface RollingEntry<T> {
  readonly node: ToolBatchNodeV1;
  readonly run: (signal: AbortSignal) => Promise<RollingToolWorkResult<T>>;
  readonly resolve: (result: RollingToolWorkResult<T>) => void;
  state: 'pending' | 'running' | 'done';
  result: RollingToolWorkResult<T> | null;
}

/** Incremental counterpart used while a provider is still streaming tool calls. */
export class RollingToolBatchScheduler<T> {
  private readonly entries: RollingEntry<T>[] = [];
  private readonly controller = new AbortController();
  private readonly maxNodes: number;
  private readonly maxConcurrency: number;
  private readonly maxWallTimeMs: number;
  private readonly cancelled: RollingToolBatchOptions<T>['cancelled'];
  private active = 0;
  private stopBatch = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unlink: () => void;

  constructor(options: RollingToolBatchOptions<T>) {
    this.maxNodes = bounded(options.maxNodes ?? 64, 1, 64, 'maxNodes');
    this.maxConcurrency = bounded(options.maxConcurrency ?? 4, 1, 16, 'maxConcurrency');
    this.maxWallTimeMs = bounded(options.maxWallTimeMs ?? 60_000, 1, 24 * 60 * 60 * 1000, 'maxWallTimeMs');
    this.cancelled = options.cancelled;
    this.unlink = fuseAbort(options.signal, this.controller);
  }

  enqueue(node: ToolBatchNodeV1, run: (signal: AbortSignal) => Promise<RollingToolWorkResult<T>>): Promise<RollingToolWorkResult<T>> {
    if (this.entries.length >= this.maxNodes) return Promise.resolve(this.cancelled(node, diagnostic('tool-batch.node-limit', `Batch exceeds maxNodes ${this.maxNodes}.`, false)));
    if (this.entries.some((entry) => entry.node.id === node.id || entry.node.toolCallId === node.toolCallId)) return Promise.resolve(this.cancelled(node, diagnostic('tool-batch.node-duplicate', 'Tool batch node and call ids must be unique.', false)));
    if (node.dependsOn.some((id) => !this.entries.some((entry) => entry.node.id === id))) return Promise.resolve(this.cancelled(node, diagnostic('tool-batch.dependency-forward', `Streaming node ${node.id} has an unavailable dependency.`, false)));
    if (!this.timer) {
      this.timer = setTimeout(() => this.controller.abort(new ToolBatchProtocolError('tool-batch.timeout', 'Tool batch wall-time limit expired.', true)), this.maxWallTimeMs);
      this.timer.unref?.();
    }
    let resolve!: (result: RollingToolWorkResult<T>) => void;
    const promise = new Promise<RollingToolWorkResult<T>>((accept) => { resolve = accept; });
    this.entries.push({ node, run, resolve, state: 'pending', result: null });
    this.pump();
    return promise;
  }

  async drain(): Promise<readonly RollingToolWorkResult<T>[]> {
    this.pump();
    while (this.entries.some((entry) => entry.state !== 'done')) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.unlink(); this.unlink = () => {};
    return Object.freeze(this.entries.map((entry) => entry.result!));
  }

  private pump(): void {
    if (this.controller.signal.aborted) {
      for (const entry of this.entries) if (entry.state === 'pending') this.finish(entry, this.cancelled(entry.node, errorDiagnostic(this.controller.signal.reason)));
    }
    for (const entry of this.entries) {
      if (entry.state !== 'pending') continue;
      const dependency = entry.node.dependsOn.map((id) => this.entries.find((candidate) => candidate.node.id === id)).find((candidate) => candidate?.state === 'done' && candidate.result?.status !== 'completed');
      if (dependency) this.finish(entry, this.cancelled(entry.node, diagnostic('tool-batch.dependency-failed', `Dependency ${dependency.node.id} did not complete.`, false)));
      else if (this.stopBatch) this.finish(entry, this.cancelled(entry.node, diagnostic('tool-batch.stopped', 'Batch stopped after a node failure.', false)));
    }
    for (let index = 0; index < this.entries.length && this.active < this.maxConcurrency && !this.controller.signal.aborted; index += 1) {
      const entry = this.entries[index]!;
      if (entry.state !== 'pending' || !entry.node.dependsOn.every((id) => this.entries.find((candidate) => candidate.node.id === id)?.result?.status === 'completed')) continue;
      if (!canDispatch(this.entries, index)) continue;
      entry.state = 'running'; this.active += 1;
      void abortable(entry.run(this.controller.signal), this.controller.signal).then((result) => {
        if (result.status === 'failed' && entry.node.onFailure === 'stop-batch') { this.stopBatch = true; this.controller.abort(new ToolBatchProtocolError('tool-batch.stopped', `Node ${entry.node.id} stopped the batch.`)); }
        this.finish(entry, result);
      }, (cause) => this.finish(entry, this.cancelled(entry.node, errorDiagnostic(cause))));
    }
  }

  private finish(entry: RollingEntry<T>, result: RollingToolWorkResult<T>): void {
    if (entry.state === 'done') return;
    if (entry.state === 'running') this.active -= 1;
    entry.state = 'done'; entry.result = result; entry.resolve(result); queueMicrotask(() => this.pump());
  }
}

function canDispatch<T>(entries: readonly RollingEntry<T>[], index: number): boolean {
  const node = entries[index]!.node;
  return !entries.some((entry, prior) => entry.state !== 'done'
    && (entry.state === 'running' || prior < index) && requiresSerialOrder(entry.node, node));
}
function diagnostic(code: string, message: string, retryable: boolean): ToolBatchDiagnostic { return Object.freeze({ code, message, retryable }); }
function errorDiagnostic(cause: unknown): ToolBatchDiagnostic { return diagnostic(cause instanceof ToolBatchProtocolError ? cause.code : 'tool-batch.cancelled', cause instanceof Error ? cause.message : String(cause), cause instanceof ToolBatchProtocolError && cause.retryable); }
function bounded(value: number, min: number, max: number, name: string): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new ToolBatchProtocolError('tool-batch.limit-invalid', `${name} is outside its allowed range.`); return value; }
function fuseAbort(parent: AbortSignal | undefined, child: AbortController): () => void { if (!parent) return () => {}; const abort = () => child.abort(parent.reason); if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true }); return () => parent.removeEventListener('abort', abort); }
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new ToolBatchProtocolError('tool-batch.cancelled', 'Tool batch was cancelled.', true));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
