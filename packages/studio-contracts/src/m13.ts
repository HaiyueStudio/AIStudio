/**
 * M13 provider-neutral session, context and execution contracts.
 *
 * These contracts are data-only. Runtime packages own validation, projection
 * and effects; provider adapters must not leak their wire types into here.
 */

export type M13SchemaVersion = 1;
export type M13StableId = string;
export type M13Digest = `sha256:${string}`;
export type M13JsonValue = null | boolean | number | string | readonly M13JsonValue[] | M13JsonObject;
export type M13JsonObject = { readonly [key: string]: M13JsonValue };

export type M13DiagnosticCode =
  | 'session.version-unsupported'
  | 'session.sequence-gap'
  | 'session.outcome-unknown'
  | 'surface.replace-range-invalid'
  | 'surface.source-missing'
  | 'context.capacity-unavailable'
  | 'context.compaction-unsafe'
  | 'context.compaction-summary-invalid'
  | 'tool-batch.cycle'
  | 'tool-batch.limit-exceeded'
  | 'tool-batch.concurrency-unknown'
  | 'scene-diff.revision-gap'
  | 'execution-graph.orphan-edge'
  | 'knowledge.source-stale'
  | 'knowledge.source-untrusted';

export interface M13DiagnosticV1 {
  readonly code: M13DiagnosticCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly sessionId: M13StableId | null;
  readonly opId: M13StableId | null;
  readonly nodeId: M13StableId | null;
  readonly recoverable: boolean;
}

export type AgentSessionStatusV1 =
  | 'idle' | 'running' | 'waiting-user' | 'waiting-approval' | 'compacting'
  | 'interrupted' | 'completed' | 'failed' | 'cancelled';

export interface BackendSessionBindingV1 {
  readonly bindingId: M13StableId;
  readonly backendId: M13StableId;
  readonly provider: string;
  readonly model: string;
  readonly remoteSessionId: M13StableId | null;
  readonly generation: number;
  readonly status: 'active' | 'stale' | 'detached';
  readonly capabilities: Readonly<{
    maxInputTokens: number | null;
    nativeCompaction: boolean;
    parallelToolCalls: boolean;
    codeMode: boolean;
    providerUsage: 'reported' | 'unavailable' | 'unknown';
    providerCache: 'reported' | 'unavailable' | 'unknown';
  }>;
  readonly lastConfirmedOpId: M13StableId | null;
}

export interface SessionCheckpointV1 {
  readonly id: M13StableId;
  readonly sessionId: M13StableId;
  readonly throughSequence: number;
  readonly turnId: M13StableId | null;
  readonly batchId: M13StableId | null;
  readonly documentRevision: number | null;
  readonly surfaceGeneration: number;
  readonly unresolvedBarrierIds: readonly M13StableId[];
  readonly digest: M13Digest;
  readonly createdAt: string;
}

export interface AgentSessionV1 {
  readonly schemaVersion: M13SchemaVersion;
  readonly id: M13StableId;
  readonly projectId: M13StableId | null;
  readonly documentId: M13StableId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: AgentSessionStatusV1;
  readonly activeGoal: string | null;
  readonly surfaceGeneration: number;
  readonly backendBindings: readonly BackendSessionBindingV1[];
  readonly checkpoint: SessionCheckpointV1 | null;
  readonly taskBudgetId: M13StableId | null;
  readonly usageRecordIds: readonly M13StableId[];
  readonly costRecordIds: readonly M13StableId[];
}

export type SessionOpKindV1 =
  | 'session.created' | 'session.status-changed' | 'session.checkpointed'
  | 'turn.started' | 'turn.completed' | 'user.message' | 'assistant.message'
  | 'tool-batch.planned' | 'tool-batch.started' | 'tool-batch.completed'
  | 'tool.started' | 'tool.completed' | 'tool.outcome-unknown'
  | 'approval.requested' | 'approval.resolved' | 'question.requested' | 'question.resolved'
  | 'document.committed' | 'evidence.captured' | 'evaluation.completed'
  | 'compaction.requested' | 'compaction.started' | 'compaction.summary-created'
  | 'compaction.completed' | 'compaction.failed' | 'backend.bound' | 'backend.detached';

export interface SessionOpV1 {
  readonly schemaVersion: M13SchemaVersion;
  readonly id: M13StableId;
  readonly sessionId: M13StableId;
  readonly sequence: number;
  readonly kind: SessionOpKindV1;
  readonly timestamp: string;
  readonly turnId: M13StableId | null;
  readonly stepId: M13StableId | null;
  readonly batchId: M13StableId | null;
  readonly nodeId: M13StableId | null;
  readonly parentOpId: M13StableId | null;
  readonly dependsOn: readonly M13StableId[];
  readonly projectRevision: number | null;
  readonly artifactRefs: readonly M13StableId[];
  readonly payload: M13JsonObject;
  readonly payloadDigest: M13Digest;
}

export type SurfaceOpV1 =
  | Readonly<{
      op: 'append';
      id: M13StableId;
      sourceOpIds: readonly M13StableId[];
      messageArtifactId: M13StableId;
      role: 'user' | 'assistant' | 'tool';
    }>
  | Readonly<{
      op: 'replace';
      id: M13StableId;
      sourceOpIds: readonly M13StableId[];
      startNodeId: M13StableId;
      endNodeId: M13StableId;
      replacementArtifactId: M13StableId;
      reason: 'compaction' | 'tool-result-prune';
    }>;

export interface ModelSurfaceNodeV1 {
  readonly id: M13StableId;
  readonly originOpId: M13StableId;
  readonly messageArtifactId: M13StableId;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly replacedSourceOpIds: readonly M13StableId[];
}

export interface ModelSurfaceV1 {
  readonly schemaVersion: M13SchemaVersion;
  readonly sessionId: M13StableId;
  readonly generation: number;
  readonly throughSequence: number;
  readonly nodes: readonly ModelSurfaceNodeV1[];
  readonly lastOperation: SurfaceOpV1 | null;
  readonly digest: M13Digest;
}

export interface ContextPressureV1 {
  readonly maxInputTokens: number | null;
  readonly reservedOutputTokens: number;
  readonly reservedSafetyTokens: number;
  readonly usedInputTokens: number | null;
  readonly ratio: number | null;
  readonly measurement: 'provider-reported' | 'tokenizer-estimated' | 'unavailable';
  readonly state: 'normal' | 'warning' | 'preparing' | 'compact-required' | 'emergency' | 'unknown';
}

export interface CompactionRecordV1 {
  readonly id: M13StableId;
  readonly reason: 'automatic-threshold' | 'manual' | 'provider-required';
  readonly coveredStartSequence: number;
  readonly coveredEndSequence: number;
  readonly before: ContextPressureV1;
  readonly after: ContextPressureV1 | null;
  readonly sourceSurfaceGeneration: number;
  readonly targetSurfaceGeneration: number | null;
  readonly summaryArtifactId: M13StableId | null;
  readonly pinnedFactDigests: readonly M13Digest[];
  readonly validation: 'pending' | 'passed' | 'failed';
  readonly diagnostic: M13DiagnosticCode | null;
}

export interface ContextFrameV1 {
  readonly schemaVersion: M13SchemaVersion;
  readonly id: M13StableId;
  readonly sessionId: M13StableId;
  readonly turnId: M13StableId;
  readonly backendBindingId: M13StableId;
  readonly model: string;
  readonly surfaceGeneration: number;
  readonly projectRevision: number | null;
  readonly inputs: readonly Readonly<{
    kind: 'surface' | 'policy' | 'tool-catalog' | 'scene-snapshot' | 'scene-diff' | 'diagnostics-delta' | 'evidence-delta' | 'durable-memory' | 'knowledge-hit';
    artifactId: M13StableId;
    digest: M13Digest;
    sourceRevision: number | null;
    estimatedTokens: number;
    required: boolean;
  }>[];
  readonly pressure: ContextPressureV1;
  readonly cachePrefixDigest: M13Digest;
  readonly compaction: CompactionRecordV1 | null;
  readonly createdAt: string;
}

export type ToolExecutionClassV1 =
  | 'parallel-read' | 'exclusive-mutation' | 'approval-barrier'
  | 'runtime-barrier' | 'trusted-code-barrier' | 'unknown-exclusive';

export type ToolEffectV1 =
  | 'observe' | 'document-mutation' | 'runtime-control' | 'trusted-code'
  | 'approval' | 'external-side-effect' | 'unknown';

export interface ToolBatchNodeV1 {
  readonly id: M13StableId;
  readonly toolCallId: M13StableId;
  readonly toolId: M13StableId;
  readonly toolVersion: string;
  readonly arguments: M13JsonObject;
  readonly dependsOn: readonly M13StableId[];
  readonly expectedRevision: number | null;
  readonly executionClass: ToolExecutionClassV1;
  readonly effects: readonly ToolEffectV1[];
  readonly effectKeys: readonly M13StableId[];
  readonly outputProjection: 'full' | 'summary' | 'digest-only';
  readonly onFailure: 'cancel-dependents' | 'stop-batch';
}

export interface ToolBatchRequestV1 {
  readonly schemaVersion: M13SchemaVersion;
  readonly id: M13StableId;
  readonly sessionId: M13StableId;
  readonly turnId: M13StableId;
  readonly nodes: readonly ToolBatchNodeV1[];
  readonly maxConcurrency: number;
  readonly maxResultBytes: number;
  readonly createdAt: string;
}

export interface SceneDiffV1 {
  readonly schemaVersion: M13SchemaVersion;
  readonly documentId: M13StableId;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly transactionIds: readonly M13StableId[];
  readonly addedEntityIds: readonly M13StableId[];
  readonly removedEntityIds: readonly M13StableId[];
  readonly changedEntities: readonly Readonly<{ entityId: M13StableId; paths: readonly string[] }>[];
  readonly reorderedEntityIds: readonly M13StableId[];
  readonly componentPatches: readonly Readonly<{ componentId: M13StableId; entityId: M13StableId; paths: readonly string[]; digest: M13Digest }>[];
  readonly scriptChanges: readonly Readonly<{ scriptId: M13StableId; change: 'added' | 'updated' | 'removed'; digest: M13Digest | null }>[];
  readonly assetChanges: readonly Readonly<{ assetId: M13StableId; change: 'added' | 'updated' | 'removed'; digest: M13Digest | null }>[];
  readonly cameraChanges: readonly Readonly<{ cameraId: M13StableId; change: 'added' | 'updated' | 'removed'; paths: readonly string[]; digest: M13Digest | null }>[];
  readonly renderChanges: readonly Readonly<{ scopeId: M13StableId; change: 'added' | 'updated' | 'removed'; paths: readonly string[]; digest: M13Digest | null }>[];
  readonly settingsChanged: readonly string[];
  readonly tombstoneIds: readonly M13StableId[];
  readonly provenanceOpIds: readonly M13StableId[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly digest: M13Digest;
}

export type ExecutionGraphNodeKindV1 =
  | 'goal' | 'plan' | 'turn' | 'tool-batch' | 'tool' | 'transaction'
  | 'approval' | 'question' | 'compaction' | 'evidence' | 'evaluation'
  | 'repair' | 'result';
export type ExecutionGraphEdgeKindV1 =
  | 'depends-on' | 'produced' | 'modified' | 'validated-by'
  | 'blocked-by' | 'retried-from' | 'supersedes' | 'compacted-into';
export type ExecutionGraphNodeStatusV1 =
  | 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface ExecutionGraphV1 {
  readonly schemaVersion: M13SchemaVersion;
  readonly sessionId: M13StableId;
  readonly revision: number;
  readonly nodes: readonly Readonly<{
    id: M13StableId;
    kind: ExecutionGraphNodeKindV1;
    status: ExecutionGraphNodeStatusV1;
    title: string;
    sourceOpIds: readonly M13StableId[];
    artifactRefs: readonly M13StableId[];
  }>[];
  readonly edges: readonly Readonly<{ id: M13StableId; kind: ExecutionGraphEdgeKindV1; from: M13StableId; to: M13StableId }>[];
  readonly criticalPathNodeIds: readonly M13StableId[];
  readonly throughSequence: number;
  readonly digest: M13Digest;
}

export interface KnowledgeHitV1 {
  readonly schemaVersion: M13SchemaVersion;
  readonly id: M13StableId;
  readonly source: string;
  readonly sourceKind: 'engine-doc' | 'component-schema' | 'project-doc' | 'asset-metadata' | 'verified-example' | 'session-decision';
  readonly packageVersion: string | null;
  readonly projectRevision: number | null;
  readonly contentDigest: M13Digest;
  readonly chunk: Readonly<{ start: number; end: number }>;
  readonly retrieval: 'keyword' | 'embedding' | 'hybrid' | 'graph';
  readonly score: number;
  readonly reason: string;
  readonly permissionScope: M13StableId;
  readonly stale: boolean;
}
