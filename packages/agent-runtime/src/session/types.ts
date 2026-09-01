import type {
  AgentSessionV1,
  BackendSessionBindingV1,
  JsonObject,
  M13StableId,
  ModelSurfaceV1,
  SessionOpKindV1,
  SessionOpV1,
} from '@haiyue/ai-studio-contracts';

export interface CreateSessionInput {
  readonly id?: M13StableId;
  readonly projectId: M13StableId | null;
  readonly documentId: M13StableId | null;
  readonly activeGoal: string | null;
  readonly taskBudgetId: M13StableId | null;
}

export interface AppendSessionOpInput {
  readonly id?: M13StableId;
  readonly timestamp?: string;
  readonly kind: SessionOpKindV1;
  readonly turnId?: M13StableId | null;
  readonly stepId?: M13StableId | null;
  readonly batchId?: M13StableId | null;
  readonly nodeId?: M13StableId | null;
  readonly parentOpId?: M13StableId | null;
  readonly dependsOn?: readonly M13StableId[];
  readonly projectRevision?: number | null;
  readonly artifactRefs?: readonly M13StableId[];
  readonly payload?: JsonObject;
}

export interface AppendSessionMessageInput {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly turnId?: M13StableId | null;
  readonly stepId?: M13StableId | null;
  readonly projectRevision?: number | null;
}

export interface ReplaceModelSurfaceInput {
  readonly startNodeId: M13StableId;
  readonly endNodeId: M13StableId;
  readonly summary: string;
  readonly reason: 'compaction' | 'tool-result-prune';
  readonly turnId?: M13StableId | null;
  readonly projectRevision?: number | null;
}

export interface ForkSessionInput {
  readonly id?: M13StableId;
  readonly throughSequence?: number;
  readonly activeGoal?: string | null;
}

export interface OpenSessionOptions {
  readonly repairOpenOperations?: boolean;
}

export interface SessionRuntimeOptions {
  readonly clock?: () => Date;
  readonly idFactory?: (kind: 'session' | 'op' | 'surface-node' | 'checkpoint' | 'fork-seed', index: number) => M13StableId;
  readonly queryWindow?: number;
}

export interface TranscriptEntryV1 {
  readonly id: M13StableId;
  readonly sessionId: M13StableId;
  readonly originSessionId: M13StableId;
  readonly opId: M13StableId;
  readonly role: 'user' | 'assistant';
  readonly messageArtifactId: M13StableId;
  readonly content: string;
  readonly timestamp: string;
  readonly source: 'append-origin';
}

export interface SessionRecoverySnapshotV1 {
  readonly openTurnIds: readonly M13StableId[];
  readonly openToolNodeIds: readonly M13StableId[];
  readonly openBatchIds: readonly M13StableId[];
  readonly unresolvedBarrierIds: readonly M13StableId[];
  readonly outcomeUnknownNodeIds: readonly M13StableId[];
}

export interface SessionReplaySnapshotV1 {
  readonly schemaVersion: 1;
  readonly session: AgentSessionV1;
  readonly ops: readonly SessionOpV1[];
  readonly surface: ModelSurfaceV1;
  readonly transcript: readonly TranscriptEntryV1[];
  readonly recovery: SessionRecoverySnapshotV1;
  readonly throughLogSequence: number;
}

export interface SessionForkSeedV1 {
  readonly schemaVersion: 1;
  readonly kind: 'agent-session-fork-seed';
  readonly parentSessionId: M13StableId;
  readonly parentThroughSequence: number;
  readonly parentSurface: ModelSurfaceV1;
  readonly parentTranscript: readonly Omit<TranscriptEntryV1, 'sessionId' | 'source' | 'content'>[];
}

export interface SessionMessageArtifactV1 {
  readonly schemaVersion: 1;
  readonly kind: 'session-message' | 'surface-summary';
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface DurableSessionHandle {
  readonly id: M13StableId;
  snapshot(): Promise<SessionReplaySnapshotV1>;
  append(input: AppendSessionOpInput): Promise<SessionReplaySnapshotV1>;
  appendMessage(input: AppendSessionMessageInput): Promise<SessionReplaySnapshotV1>;
  replaceSurface(input: ReplaceModelSurfaceInput): Promise<SessionReplaySnapshotV1>;
  bindBackend(binding: BackendSessionBindingV1): Promise<SessionReplaySnapshotV1>;
  checkpoint(): Promise<SessionReplaySnapshotV1>;
  fork(input?: ForkSessionInput): Promise<DurableSessionHandle>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}
