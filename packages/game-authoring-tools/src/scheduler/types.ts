import type { JsonObject, ToolBatchNodeV1, ToolBatchRequestV1 } from '@haiyue/ai-studio-contracts';

export type ToolBatchNodeStatus = 'completed' | 'failed' | 'cancelled';

export interface ToolBatchDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ToolBatchExecutorResult {
  readonly status: Exclude<ToolBatchNodeStatus, 'cancelled'> | 'cancelled';
  readonly value: JsonObject;
  readonly usageRecordId?: string;
  readonly costRecordId?: string;
}

export interface ToolBatchNodeOutcome {
  readonly node: ToolBatchNodeV1;
  readonly status: ToolBatchNodeStatus;
  readonly value: JsonObject;
  readonly diagnostic: ToolBatchDiagnostic | null;
  readonly latencyMs: number;
  readonly outputBytes: number;
  readonly completionOrdinal: number | null;
  readonly usageRecordId: string | null;
  readonly costRecordId: string | null;
}

export interface ToolBatchSummary {
  readonly batchId: string;
  readonly status: ToolBatchNodeStatus;
  readonly nodeCount: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly maxConcurrencyObserved: number;
  readonly outputBytes: number;
  readonly wallTimeMs: number;
  /** Stable digest excludes timing and real completion order. */
  readonly resultDigest: string;
}

export interface ToolBatchExecution {
  readonly request: ToolBatchRequestV1;
  /** Always follows request.nodes order, even when bodies finish out of order. */
  readonly outcomes: readonly ToolBatchNodeOutcome[];
  readonly summary: ToolBatchSummary;
}

export interface ToolBatchSchedulerHooks {
  onBatchStarted?(request: ToolBatchRequestV1): void | Promise<void>;
  onNodeDispatched?(request: ToolBatchRequestV1, node: ToolBatchNodeV1): void | Promise<void>;
  onNodeCommitted?(request: ToolBatchRequestV1, outcome: ToolBatchNodeOutcome): void | Promise<void>;
  onBatchCompleted?(execution: ToolBatchExecution): void | Promise<void>;
}

export interface ToolBatchSchedulerOptions {
  readonly maxNodes?: number;
  readonly maxConcurrency?: number;
  readonly maxWallTimeMs?: number;
  readonly maxOutputBytes?: number;
  readonly nodeTimeoutMs?: (node: ToolBatchNodeV1) => number;
  readonly clock?: () => number;
  readonly hooks?: ToolBatchSchedulerHooks;
}

export type ToolBatchExecutor = (node: ToolBatchNodeV1, signal: AbortSignal) => Promise<ToolBatchExecutorResult>;

export interface RollingToolWorkResult<T> {
  readonly status: ToolBatchNodeStatus;
  readonly value: T;
}

export interface RollingToolBatchOptions<T> {
  readonly maxNodes?: number;
  readonly maxConcurrency?: number;
  readonly maxWallTimeMs?: number;
  readonly signal?: AbortSignal;
  readonly cancelled: (node: ToolBatchNodeV1, diagnostic: ToolBatchDiagnostic) => RollingToolWorkResult<T>;
}

export class ToolBatchProtocolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'ToolBatchProtocolError';
  }
}
