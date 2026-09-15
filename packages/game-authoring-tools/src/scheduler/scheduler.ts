import { requiresSerialOrder } from './classify.js';
import type { JsonObject, JsonValue, ToolBatchNodeV1, ToolBatchRequestV1 } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';
import { validateToolBatchRequest } from './normalize.js';
import { ToolBatchProtocolError, type ToolBatchExecution, type ToolBatchExecutor, type ToolBatchExecutorResult, type ToolBatchNodeOutcome, type ToolBatchSchedulerOptions } from './types.js';

const DEFAULT_MAX_WALL_TIME_MS = 60_000;

export class ToolBatchScheduler {
  private readonly options: Required<Pick<ToolBatchSchedulerOptions, 'maxNodes' | 'maxConcurrency' | 'maxWallTimeMs' | 'maxOutputBytes' | 'clock'>> & Pick<ToolBatchSchedulerOptions, 'nodeTimeoutMs' | 'hooks'>;

  constructor(options: ToolBatchSchedulerOptions = {}) {
    this.options = {
      maxNodes: bounded(options.maxNodes ?? 64, 1, 64, 'maxNodes'),
      maxConcurrency: bounded(options.maxConcurrency ?? 16, 1, 16, 'maxConcurrency'),
      maxWallTimeMs: bounded(options.maxWallTimeMs ?? DEFAULT_MAX_WALL_TIME_MS, 1, 24 * 60 * 60 * 1000, 'maxWallTimeMs'),
      maxOutputBytes: bounded(options.maxOutputBytes ?? 16 * 1024 * 1024, 1, 16 * 1024 * 1024, 'maxOutputBytes'),
      clock: options.clock ?? (() => Date.now()), nodeTimeoutMs: options.nodeTimeoutMs, hooks: options.hooks,
    };
  }

  async execute(request: ToolBatchRequestV1, executor: ToolBatchExecutor, signal?: AbortSignal): Promise<ToolBatchExecution> {
    validateToolBatchRequest(request);
    if (request.nodes.length > this.options.maxNodes) throw new ToolBatchProtocolError('tool-batch.node-limit', `Batch exceeds scheduler maxNodes ${this.options.maxNodes}.`);
    const maxConcurrency = Math.min(request.maxConcurrency, this.options.maxConcurrency);
    const maxOutputBytes = Math.min(request.maxResultBytes, this.options.maxOutputBytes);
    const startedAt = this.options.clock();
    const controller = new AbortController();
    const unlink = fuseAbort(signal, controller);
    const timer = setTimeout(() => controller.abort(new ToolBatchProtocolError('tool-batch.timeout', 'Tool batch wall-time limit expired.', true)), this.options.maxWallTimeMs);
    timer.unref?.();
    const records = request.nodes.map((node) => ({ node, state: 'pending' as 'pending' | 'running' | 'done', outcome: null as ToolBatchNodeOutcome | null }));
    const byId = new Map(records.map((record) => [record.node.id, record]));
    const running = new Set<Promise<void>>();
    let active = 0; let maxActive = 0; let completionOrdinal = 0; let stopBatch = false;
    try {
      await this.options.hooks?.onBatchStarted?.(request);
      while (records.some((record) => record.state !== 'done')) {
        if (controller.signal.aborted) for (const record of records) if (record.state === 'pending') completeCancelled(record, abortDiagnostic(controller.signal));
        for (const record of records) {
          if (record.state !== 'pending') continue;
          const failedDependency = record.node.dependsOn.map((id) => byId.get(id)).find((dependency) => dependency?.state === 'done' && dependency.outcome?.status !== 'completed');
          if (failedDependency) completeCancelled(record, diagnostic('tool-batch.dependency-failed', `Dependency ${failedDependency.node.id} did not complete.`, false));
          else if (stopBatch) completeCancelled(record, diagnostic('tool-batch.stopped', 'Batch stopped after a node failure.', false));
        }
        let launched = false;
        for (let index = 0; index < records.length && active < maxConcurrency && !controller.signal.aborted; index += 1) {
          const record = records[index]!;
          if (record.state !== 'pending' || !record.node.dependsOn.every((id) => byId.get(id)?.outcome?.status === 'completed')) continue;
          if (!canDispatch(records, index)) continue;
          record.state = 'running'; active += 1; maxActive = Math.max(maxActive, active); launched = true;
          await this.options.hooks?.onNodeDispatched?.(request, record.node);
          let promise!: Promise<void>;
          promise = this.runNode(record.node, executor, controller.signal, () => ++completionOrdinal).then((outcome) => {
            record.outcome = outcome; record.state = 'done'; active -= 1;
            if (outcome.status === 'failed' && record.node.onFailure === 'stop-batch') { stopBatch = true; controller.abort(new ToolBatchProtocolError('tool-batch.stopped', `Node ${record.node.id} stopped the batch.`)); }
          }).finally(() => running.delete(promise));
          running.add(promise);
        }
        if (records.every((record) => record.state === 'done')) break;
        if (running.size > 0) await Promise.race(running);
        else if (!launched) throw new ToolBatchProtocolError('tool-batch.deadlock', 'No batch node can make progress.');
      }
      await Promise.allSettled([...running]);
      let totalBytes = 0;
      for (const record of records) {
        if (!record.outcome) completeCancelled(record, abortDiagnostic(controller.signal));
        if (totalBytes + record.outcome!.outputBytes > maxOutputBytes && record.outcome!.status === 'completed') record.outcome = failedOutcome(record.node, diagnostic('tool-batch.result-limit', 'Batch result byte limit exceeded.', false), record.outcome!.latencyMs, record.outcome!.completionOrdinal);
        totalBytes += record.outcome!.outputBytes;
      }
      const outcomes = Object.freeze(records.map((record) => record.outcome!));
      for (const outcome of outcomes) await this.options.hooks?.onNodeCommitted?.(request, outcome);
      const execution = freezeExecution(request, outcomes, maxActive, Math.max(0, this.options.clock() - startedAt));
      await this.options.hooks?.onBatchCompleted?.(execution);
      return execution;
    } finally { clearTimeout(timer); unlink(); }

    function completeCancelled(record: typeof records[number], reason: ReturnType<typeof diagnostic>): void {
      if (record.state !== 'pending') return;
      record.state = 'done'; record.outcome = cancelledOutcome(record.node, reason);
    }
  }

  private async runNode(node: ToolBatchNodeV1, executor: ToolBatchExecutor, batchSignal: AbortSignal, nextOrdinal: () => number): Promise<ToolBatchNodeOutcome> {
    const startedAt = this.options.clock();
    const controller = new AbortController(); const unlink = fuseAbort(batchSignal, controller);
    const timeoutMs = this.options.nodeTimeoutMs?.(node);
    const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(new ToolBatchProtocolError('tool-batch.node-timeout', `Node ${node.id} timed out.`, true)), timeoutMs) : null;
    try {
      const result = await abortable(executor(node, controller.signal), controller.signal);
      const latencyMs = Math.max(0, this.options.clock() - startedAt);
      const value = projectValue(result, node.outputProjection);
      const outputBytes = bytes(value);
      return Object.freeze({ node, status: result.status, value, diagnostic: result.status === 'failed' ? diagnostic('tool-batch.executor-failed', `Tool ${node.toolId} reported failure.`, false) : null, latencyMs, outputBytes, completionOrdinal: nextOrdinal(), usageRecordId: result.usageRecordId ?? null, costRecordId: result.costRecordId ?? null });
    } catch (cause) {
      const latencyMs = Math.max(0, this.options.clock() - startedAt); const aborted = controller.signal.aborted;
      return aborted ? cancelledOutcome(node, abortDiagnostic(controller.signal), latencyMs, nextOrdinal()) : failedOutcome(node, errorDiagnostic(cause), latencyMs, nextOrdinal());
    } finally { if (timer) clearTimeout(timer); unlink(); }
  }
}

function canDispatch(records: readonly { node: ToolBatchNodeV1; state: 'pending' | 'running' | 'done' }[], index: number): boolean {
  const node = records[index]!.node;
  return !records.some((entry, prior) => entry.state !== 'done'
    && (entry.state === 'running' || prior < index) && requiresSerialOrder(entry.node, node));
}

function projectValue(result: ToolBatchExecutorResult, projection: ToolBatchNodeV1['outputProjection']): JsonObject {
  if (projection === 'full') return result.value;
  const serialized = canonicalStringify(result.value);
  const digest = sha256(serialized);
  if (projection === 'digest-only') return Object.freeze({ digest, byteLength: Buffer.byteLength(serialized) });
  const keys = Object.keys(result.value).sort().slice(0, 32);
  return Object.freeze({ digest, byteLength: Buffer.byteLength(serialized), keys: Object.freeze(keys), status: result.status });
}

function freezeExecution(request: ToolBatchRequestV1, outcomes: readonly ToolBatchNodeOutcome[], maxConcurrencyObserved: number, wallTimeMs: number): ToolBatchExecution {
  const completed = outcomes.filter((item) => item.status === 'completed').length; const failed = outcomes.filter((item) => item.status === 'failed').length; const cancelled = outcomes.length - completed - failed;
  const outputBytes = outcomes.reduce((sum, item) => sum + item.outputBytes, 0);
  const stable = outcomes.map((item) => ({ nodeId: item.node.id, toolCallId: item.node.toolCallId, status: item.status, value: item.value, diagnostic: item.diagnostic?.code ?? null }));
  const summary = Object.freeze({ batchId: request.id, status: failed > 0 ? 'failed' as const : cancelled > 0 ? 'cancelled' as const : 'completed' as const, nodeCount: outcomes.length, completed, failed, cancelled, maxConcurrencyObserved, outputBytes, wallTimeMs, resultDigest: sha256(canonicalStringify(stable as unknown as JsonValue)) });
  return Object.freeze({ request, outcomes, summary });
}

function failedOutcome(node: ToolBatchNodeV1, problem: ReturnType<typeof diagnostic>, latencyMs = 0, completionOrdinal: number | null = null): ToolBatchNodeOutcome { const value = Object.freeze({ error: Object.freeze({ code: problem.code, message: problem.message, retryable: problem.retryable }) }); return Object.freeze({ node, status: 'failed', value, diagnostic: problem, latencyMs, outputBytes: bytes(value), completionOrdinal, usageRecordId: null, costRecordId: null }); }
function cancelledOutcome(node: ToolBatchNodeV1, problem: ReturnType<typeof diagnostic>, latencyMs = 0, completionOrdinal: number | null = null): ToolBatchNodeOutcome { const value = Object.freeze({ error: Object.freeze({ code: problem.code, message: problem.message, retryable: problem.retryable }) }); return Object.freeze({ node, status: 'cancelled', value, diagnostic: problem, latencyMs, outputBytes: bytes(value), completionOrdinal, usageRecordId: null, costRecordId: null }); }
function bytes(value: JsonObject): number { return Buffer.byteLength(canonicalStringify(value)); }
function diagnostic(code: string, message: string, retryable: boolean) { return Object.freeze({ code, message, retryable }); }
function errorDiagnostic(cause: unknown) { return diagnostic(cause instanceof ToolBatchProtocolError ? cause.code : 'tool-batch.executor-error', cause instanceof Error ? cause.message : String(cause), cause instanceof ToolBatchProtocolError && cause.retryable); }
function abortDiagnostic(signal: AbortSignal) { return errorDiagnostic(signal.reason ?? new ToolBatchProtocolError('tool-batch.cancelled', 'Tool batch was cancelled.', true)); }
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
