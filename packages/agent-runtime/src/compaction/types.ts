import type {
  CompactionRecordV1,
  ContextPressureV1,
  M13Digest,
  M13StableId,
} from '@haiyue/ai-studio-contracts';
import type { ContextMeasurementInput, TokenEstimator } from '../context/index.js';

export type PinnedContextFactKindV1 =
  | 'active-goal'
  | 'acceptance'
  | 'artifact-reference'
  | 'blocker'
  | 'latest-error'
  | 'project-revision'
  | 'scene-diff'
  | 'unresolved-barrier';

export interface PinnedContextFactInput {
  readonly kind: PinnedContextFactKindV1;
  readonly content: string;
  readonly artifactRefs?: readonly M13StableId[];
  readonly projectRevision?: number | null;
}

export interface PinnedContextFactV1 {
  readonly kind: PinnedContextFactKindV1;
  readonly content: string;
  readonly artifactRefs: readonly M13StableId[];
  readonly projectRevision: number | null;
  readonly digest: M13Digest;
}

export interface CompactionSourceMessageV1 {
  readonly nodeId: M13StableId;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly sourceOpIds: readonly M13StableId[];
  readonly estimatedTokens: number;
}

export interface CompactionSummaryRequestV1 {
  readonly schemaVersion: 1;
  readonly compactionId: M13StableId;
  readonly sessionId: M13StableId;
  readonly model: string;
  readonly messages: readonly CompactionSourceMessageV1[];
  readonly pinnedFacts: readonly PinnedContextFactV1[];
  readonly targetEnvelopeTokens: number;
  readonly estimatedEnvelopeOverheadTokens: number;
  readonly targetSummaryTokens: number;
  readonly maximumSummaryTokens: number;
}

export interface CompactionSummaryResultV1 {
  readonly summary: string;
}

export type CompactionSummarizer = (request: CompactionSummaryRequestV1, signal?: AbortSignal) => Promise<CompactionSummaryResultV1>;

export type CompactionPreviewDecision =
  | 'ready'
  | 'not-required'
  | 'deferred-open-boundary'
  | 'capacity-unavailable'
  | 'no-stable-range'
  | 'target-unreachable';

export interface CompactionRangePreviewV1 {
  readonly startNodeId: M13StableId;
  readonly endNodeId: M13StableId;
  readonly nodeIds: readonly M13StableId[];
  readonly sourceOpIds: readonly M13StableId[];
  readonly coveredStartSequence: number;
  readonly coveredEndSequence: number;
  readonly coveredTokens: number;
  readonly targetSummaryTokens: number;
  readonly minimumSummaryTokens: number;
  readonly maximumSummaryTokens: number;
}

export interface CompactionPreviewV1 {
  readonly reason: CompactionRecordV1['reason'];
  readonly decision: CompactionPreviewDecision;
  readonly pressure: ContextPressureV1;
  readonly sourceSurfaceGeneration: number;
  readonly sourceSurfaceDigest: M13Digest;
  readonly protectedNodeIds: readonly M13StableId[];
  readonly pinnedFacts: readonly PinnedContextFactV1[];
  readonly range: CompactionRangePreviewV1 | null;
}

export interface PreviewCompactionInput extends ContextMeasurementInput {
  readonly reason: CompactionRecordV1['reason'];
  readonly pinnedFacts?: readonly PinnedContextFactInput[];
  readonly protectedNodeIds?: readonly M13StableId[];
}

export interface RunCompactionInput extends PreviewCompactionInput {
  readonly signal?: AbortSignal;
}

export interface CompactionRunResultV1 {
  readonly status: 'completed' | 'failed' | 'deferred' | 'not-required';
  readonly compactionId: M13StableId | null;
  readonly preview: CompactionPreviewV1;
  readonly record: CompactionRecordV1 | null;
}

export interface CompactionRuntimeOptions {
  readonly estimator?: TokenEstimator;
  readonly clock?: () => Date;
  readonly idFactory?: (kind: 'compaction' | 'surface-node', index: number) => M13StableId;
  readonly targetRatio?: number;
  readonly targetMinimumRatio?: number;
  readonly targetMaximumRatio?: number;
  readonly maximumSummaryBytes?: number;
}

export interface CompactionHistoryEntryV1 {
  readonly record: CompactionRecordV1;
  readonly phase: 'requested' | 'started' | 'summary-created' | 'completed' | 'failed';
  readonly opId: M13StableId;
}
