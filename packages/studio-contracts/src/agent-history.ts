import type { JsonValue, StableId } from './index.js';

/** One logical Agent item. Revisions of the item remain append-only in the project journal. */
export interface AgentHistoryRecordV1 {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly projectId: StableId;
  readonly kind: string;
  readonly status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly toolId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly dataArtifactId: StableId;
}

export interface AgentHistoryPageV1 {
  readonly schemaVersion: 1;
  readonly projectId: StableId | null;
  readonly records: readonly AgentHistoryRecordV1[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly storage: 'project' | 'unsaved' | 'none';
}

export interface AgentHistoryDetailV1 {
  readonly schemaVersion: 1;
  readonly projectId: StableId;
  readonly record: AgentHistoryRecordV1;
  readonly data: JsonValue;
}
