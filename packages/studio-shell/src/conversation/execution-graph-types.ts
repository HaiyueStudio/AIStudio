import type {
  CompactionRecordV1,
  ContextPressureV1,
  ExecutionGraphEdgeKindV1,
  ExecutionGraphNodeKindV1,
  ExecutionGraphNodeStatusV1,
  M13Digest,
  M13StableId,
  SessionOpV1,
} from '@haiyue/ai-studio-contracts';

export type ExecutionGraphProductNodeKind = ExecutionGraphNodeKindV1 | 'unknown';
export type ExecutionGraphProductNodeStatus = ExecutionGraphNodeStatusV1 | 'outcome-unknown';
export type ExecutionGraphProductEdgeKind = ExecutionGraphEdgeKindV1 | 'contains' | 'parallel-with' | 'resumed-from';

export interface ExecutionGraphTranscriptInput {
  readonly id: M13StableId;
  readonly opId: M13StableId;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly timestamp: string;
  readonly originSessionId?: M13StableId;
}

export interface ExecutionGraphProjectionInput {
  readonly sessionId: M13StableId;
  readonly activeGoal?: string | null;
  readonly status?: string;
  readonly ops: readonly SessionOpV1[];
  readonly transcript?: readonly ExecutionGraphTranscriptInput[];
}

export interface ExecutionGraphNodeReadModel {
  readonly id: M13StableId;
  readonly kind: ExecutionGraphProductNodeKind;
  readonly status: ExecutionGraphProductNodeStatus;
  readonly title: string;
  readonly summary: string;
  readonly turnId: M13StableId | null;
  readonly batchId: M13StableId | null;
  readonly sourceNodeId: M13StableId | null;
  readonly sourceOpIds: readonly M13StableId[];
  readonly artifactRefs: readonly M13StableId[];
  readonly projectRevisionBefore: number | null;
  readonly projectRevisionAfter: number | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly detail: Readonly<{
    readonly toolId: string | null;
    readonly toolVersion: string | null;
    readonly executionClass: string | null;
    readonly barrierKind: string | null;
    readonly transactionId: M13StableId | null;
    readonly usageRecordIds: readonly M13StableId[];
    readonly costRecordIds: readonly M13StableId[];
    readonly diagnostic: string | null;
    readonly validation: string | null;
  }>;
}

export interface ExecutionGraphEdgeReadModel {
  readonly id: M13StableId;
  readonly kind: ExecutionGraphProductEdgeKind;
  readonly from: M13StableId;
  readonly to: M13StableId;
  readonly sourceOpIds: readonly M13StableId[];
}

export interface ExecutionTranscriptItemReadModel {
  readonly id: M13StableId;
  readonly kind: 'message' | 'barrier' | 'compaction' | 'recovery' | 'result' | 'system';
  readonly role: 'user' | 'assistant' | 'system';
  readonly timestamp: string;
  readonly title: string;
  readonly body: string;
  readonly status: ExecutionGraphProductNodeStatus;
  readonly sourceOpIds: readonly M13StableId[];
  readonly graphNodeIds: readonly M13StableId[];
  readonly artifactRefs: readonly M13StableId[];
}

export interface ExecutionGraphDiagnosticReadModel {
  readonly code: 'graph.sequence-gap' | 'graph.reference-missing' | 'graph.op-unsupported' | 'graph.coordinate-missing';
  readonly message: string;
  readonly sourceOpId: M13StableId | null;
}

export interface ExecutionGraphContextReadModel {
  readonly pressure: ContextPressureV1 | null;
  readonly latestCompaction: CompactionRecordV1 | null;
  readonly compactionAvailable: boolean;
  readonly compactionBlockedReason: string | null;
}

export interface ExecutionGraphReadModel {
  readonly schemaVersion: 1;
  readonly sessionId: M13StableId;
  readonly revision: number;
  readonly title: string;
  readonly status: ExecutionGraphProductNodeStatus;
  readonly nodes: readonly ExecutionGraphNodeReadModel[];
  readonly edges: readonly ExecutionGraphEdgeReadModel[];
  readonly criticalPathNodeIds: readonly M13StableId[];
  readonly currentNodeIds: readonly M13StableId[];
  readonly transcript: readonly ExecutionTranscriptItemReadModel[];
  readonly context: ExecutionGraphContextReadModel;
  readonly diagnostics: readonly ExecutionGraphDiagnosticReadModel[];
  readonly throughSequence: number;
  readonly digest: M13Digest;
}

export interface ExecutionGraphLayoutNodeReadModel {
  readonly id: M13StableId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly layer: number;
  readonly order: number;
  readonly hidden: boolean;
}

export interface ExecutionGraphLayoutReadModel {
  readonly nodes: readonly ExecutionGraphLayoutNodeReadModel[];
  readonly width: number;
  readonly height: number;
  readonly visibleNodeIds: readonly M13StableId[];
}
