import type {
  BackendSessionBindingV1,
  JsonObject,
  M13StableId,
  StableId,
} from '@haiyue/ai-studio-contracts';
import type { CompactionSummaryRequestV1 } from '../compaction/index.js';

export interface BackendSessionToolV1 {
  readonly id: StableId;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface BackendSessionCapabilitySnapshotV1 {
  readonly maxInputTokens: number | null;
  readonly nativeCompaction: boolean;
  readonly parallelToolCalls: boolean;
  readonly codeMode: boolean;
  readonly providerUsage: 'reported' | 'unavailable' | 'unknown';
  readonly providerCache: 'reported' | 'unavailable' | 'unknown';
  readonly nativeCompactionTransport: 'available' | 'unavailable' | 'unknown';
  readonly nativeCompactionMirror: 'atomic-summary' | 'fallback-required';
  readonly diagnostic: Readonly<{ code: string; message: string }> | null;
}

export interface BackendSessionOpenInputV1 {
  readonly studioSessionId: M13StableId;
  readonly model: string;
  readonly tools: readonly BackendSessionToolV1[];
  readonly surfaceGeneration: number;
  readonly surfaceDigest: `sha256:${string}`;
  readonly lastConfirmedOpId: M13StableId;
}

export interface BackendSessionOpenResultV1 {
  readonly remoteSessionId: M13StableId;
  readonly capabilities: BackendSessionCapabilitySnapshotV1;
}

export type BackendRemoteSessionInspectionV1 =
  | Readonly<{
      state: 'available';
      remoteSessionId: M13StableId;
      model: string | null;
      lastConfirmedOpId: M13StableId | null;
    }>
  | Readonly<{
      state: 'missing' | 'unavailable';
      remoteSessionId: M13StableId;
      diagnostic: Readonly<{ code: string; message: string }>;
    }>;

export type BackendNativeCompactionResultV1 =
  | Readonly<{
      status: 'completed';
      summary: string;
      providerRecordId: string | null;
    }>
  | Readonly<{
      status: 'unavailable' | 'failed';
      diagnostic: Readonly<{ code: string; message: string }>;
    }>;

export interface BackendSessionAdapter {
  readonly backendId: M13StableId;
  readonly provider: string;
  capabilities(model: string, signal?: AbortSignal): Promise<BackendSessionCapabilitySnapshotV1>;
  open(input: BackendSessionOpenInputV1, signal?: AbortSignal): Promise<BackendSessionOpenResultV1>;
  inspect(remoteSessionId: M13StableId, signal?: AbortSignal): Promise<BackendRemoteSessionInspectionV1>;
  confirmBoundary(remoteSessionId: M13StableId, lastConfirmedOpId: M13StableId, signal?: AbortSignal): Promise<void>;
  compact(remoteSessionId: M13StableId, request: CompactionSummaryRequestV1, signal?: AbortSignal): Promise<BackendNativeCompactionResultV1>;
  detach(remoteSessionId: M13StableId, signal?: AbortSignal): Promise<void>;
}

export interface EnsureBackendSessionInputV1 {
  readonly backendId: M13StableId;
  readonly model: string;
  readonly tools: readonly BackendSessionToolV1[];
  readonly signal?: AbortSignal;
}

export interface EnsureBackendSessionResultV1 {
  readonly binding: BackendSessionBindingV1;
  readonly action: 'created' | 'reused' | 'rebound' | 'stale';
  readonly recovery: 'not-required' | 'checkpoint-replay-required' | 'provider-unavailable';
  readonly diagnostic: Readonly<{ code: string; message: string }> | null;
}

export interface BackendCacheEvidenceV1 {
  readonly localCas: Readonly<{
    artifactHits: number;
    artifactMisses: number;
    deltaReuseBytes: number;
    source: 'studio-cas';
  }>;
  readonly provider: Readonly<{
    status: 'reported' | 'unavailable' | 'unknown';
    hitTokens: number | null;
    writeTokens: number | null;
    eligiblePrefixBytes: number;
    source: 'provider-usage' | 'provider-capability';
  }>;
}
