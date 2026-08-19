import type { JsonObject, JsonValue, StableId } from '@haiyue/ai-studio-contracts';

export type OperationSeverity = 'debug' | 'info' | 'warning' | 'error';
export type OperationLogHealth = 'healthy' | 'recovered' | 'degraded' | 'backpressure' | 'closed';

export interface OperationCorrelation {
  readonly sessionId?: StableId;
  readonly projectId?: StableId;
  readonly turnId?: StableId;
  readonly stepId?: StableId;
  readonly toolCallId?: StableId;
  readonly approvalId?: StableId;
  readonly pluginId?: StableId;
  readonly commandId?: StableId;
  readonly transactionId?: StableId;
  readonly documentId?: StableId;
  readonly revisionId?: StableId;
  readonly entityId?: StableId;
  readonly scriptId?: StableId;
  readonly previewId?: StableId;
}

export interface OperationProvenance {
  readonly appVersion: string;
  readonly schemaVersion: string;
  readonly pluginVersion?: string;
  readonly backendId?: StableId;
  readonly upstream?: Readonly<Record<string, string>>;
}

export interface RedactionPolicy {
  readonly fields?: readonly string[];
  readonly taintedFields?: readonly string[];
}

export interface OperationEventInput {
  readonly eventId?: StableId;
  readonly timestamp?: string;
  readonly kind: string;
  readonly severity: OperationSeverity;
  readonly source: StableId;
  readonly correlation?: OperationCorrelation;
  readonly payload: JsonObject;
  readonly provenance?: Partial<OperationProvenance>;
  readonly redaction?: RedactionPolicy;
  readonly artifactRefs?: readonly StableId[];
}

export interface DurableOperationEvent {
  readonly schemaVersion: 1;
  readonly eventId: StableId;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly severity: OperationSeverity;
  readonly source: StableId;
  readonly correlation: OperationCorrelation;
  readonly payload: JsonObject;
  readonly payloadDigest: string;
  readonly redactedFields: readonly string[];
  readonly provenance: OperationProvenance;
  readonly artifactRefs: readonly StableId[];
}

export interface OperationLogDiagnostic {
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly sequence?: number;
  readonly segment?: string;
  readonly quarantineFile?: string;
}

export interface OperationLogStatus {
  readonly health: OperationLogHealth;
  readonly canPersist: boolean;
  readonly allowsMutation: boolean;
  readonly allowsTrustedCode: boolean;
  readonly allowsRuntimeStart: boolean;
  readonly nextSequence: number;
  readonly eventCount: number;
  readonly bytes: number;
  readonly segmentCount: number;
  readonly retainedFileHandles: number;
  readonly diagnostics: readonly OperationLogDiagnostic[];
}

export interface OperationLogQuery {
  readonly sessionId?: StableId;
  readonly projectId?: StableId;
  readonly turnId?: StableId;
  readonly stepId?: StableId;
  readonly toolCallId?: StableId;
  readonly approvalId?: StableId;
  readonly commandId?: StableId;
  readonly transactionId?: StableId;
  readonly documentId?: StableId;
  readonly entityId?: StableId;
  readonly pluginId?: StableId;
  readonly scriptId?: StableId;
  readonly previewId?: StableId;
  readonly severity?: readonly OperationSeverity[];
  readonly kinds?: readonly string[];
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly afterTime?: string;
  readonly beforeTime?: string;
  readonly limit: number;
  readonly traverseCorrelation: boolean;
  readonly cursor?: string;
}

export interface OperationLogQueryPage {
  readonly events: readonly DurableOperationEvent[];
  readonly nextCursor?: string;
  readonly scanned: number;
}

export interface SafeOperationSummary {
  readonly sequence: number;
  readonly eventId: StableId;
  readonly timestamp: string;
  readonly kind: string;
  readonly severity: OperationSeverity;
  readonly source: StableId;
  readonly correlation: OperationCorrelation;
  readonly payloadDigest: string;
  readonly redactedFieldCount: number;
}

export interface LogViewerReadModel {
  readonly events: readonly SafeOperationSummary[];
  readonly counts: Readonly<Record<OperationSeverity, number>>;
  readonly nextCursor?: string;
  readonly status: OperationLogStatus;
}

export interface ArtifactReference {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly digest: string;
  readonly mediaType: 'application/json';
  readonly bytes: number;
  readonly createdAt: string;
  readonly provenance: OperationProvenance;
  readonly redactedFields: readonly string[];
}

export interface ArtifactRecord extends ArtifactReference {
  readonly value: JsonValue;
}

export interface BugBundleOptions {
  readonly destinationRoot: string;
  readonly query: OperationLogQuery;
  readonly artifactIds?: readonly StableId[];
  readonly versions: Readonly<{
    app: string;
    schema: string;
    upstream: Readonly<Record<string, string>>;
  }>;
}

export interface BugBundleResult {
  readonly directory: string;
  readonly eventCount: number;
  readonly artifactCount: number;
  readonly contentDigest: string;
  readonly files: readonly Readonly<{ path: string; bytes: number; sha256: string }>[];
}

export interface OperationLogOptions {
  readonly rootDirectory: string;
  readonly appVersion: string;
  readonly clock?: () => Date;
  readonly eventId?: (sequence: number) => StableId;
  readonly flushPolicy?: 'always' | 'manual';
  readonly maxPayloadBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly maxSegmentBytes?: number;
  readonly maxTotalBytes?: number;
  readonly retentionSegments?: number;
  readonly maxQueryScan?: number;
  readonly faultInjector?: (point: 'before-journal-write' | 'before-index-write' | 'before-artifact-write', bytes: number) => void | Promise<void>;
}

export interface AppendOptions {
  readonly signal?: AbortSignal;
}

export interface DiagnosticsQueryService {
  query(query: OperationLogQuery): Promise<OperationLogQueryPage>;
  safeSummaries(query: OperationLogQuery): Promise<readonly SafeOperationSummary[]>;
  readApprovedArtifact(id: StableId): Promise<ArtifactRecord>;
}
