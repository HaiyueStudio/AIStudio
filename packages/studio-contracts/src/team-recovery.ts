import type { JsonObject, StableId } from './index.js';

/** Opaque backend Session frames; vocabulary validation belongs to the backend bridge. */
export interface TeamSessionFrameV1 {
  readonly schemaVersion: 1;
  readonly sessionId: StableId;
  readonly header: JsonObject;
  readonly inheritedEventCount: number;
  readonly offset: number;
  readonly events: readonly JsonObject[];
}
export interface TeamSessionJournalPortV1 {
  read(id: StableId): Promise<readonly TeamSessionFrameV1[]>;
  append(frame: TeamSessionFrameV1): Promise<void>;
  ids(): Promise<readonly StableId[]>;
  /** Exclusive for the entire write handle, including reads, flushes and teardown. */
  acquire(id: StableId): Promise<Readonly<{ release(): Promise<void> }> | null>;
}
export interface TeamInferenceRequestV1 {
  readonly sessionId: StableId;
  readonly leadSessionId: StableId;
  readonly requestId: StableId;
  readonly model: string;
  /** Conservative request bound, never reported usage. */
  readonly inputTokenBound: number;
  readonly outputTokenLimit: number;
  readonly toolNames: readonly string[];
}
export interface TeamInferencePermitV1 {
  readonly signal: AbortSignal;
  /** Called only after the real provider stream has exited, including abort/error. */
  settle(usage: Readonly<{ inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }> | null, status: 'completed' | 'failed' | 'cancelled'): Promise<void>;
}
export interface TeamRecoveryAdmissionPortV1 {
  admit(request: TeamInferenceRequestV1, signal: AbortSignal): Promise<TeamInferencePermitV1>;
}
export function isTeamSessionFrameV1(value: unknown): value is TeamSessionFrameV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'events,header,inheritedEventCount,offset,schemaVersion,sessionId'
    && v.schemaVersion === 1 && typeof v.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(v.sessionId)
    && !!v.header && typeof v.header === 'object' && !Array.isArray(v.header)
    && Number.isSafeInteger(v.inheritedEventCount) && Number(v.inheritedEventCount) >= 0
    && Number.isSafeInteger(v.offset) && Number(v.offset) >= 0
    && Array.isArray(v.events) && v.events.length <= 2048 && v.events.every(e => !!e && typeof e === 'object' && !Array.isArray(e));
}
