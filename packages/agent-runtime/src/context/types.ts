import type {
  CompactionRecordV1,
  ContextFrameV1,
  ContextPressureV1,
  M13Digest,
  M13StableId,
} from '@haiyue/ai-studio-contracts';

export interface TokenEstimator {
  estimate(text: string, model: string): number;
}

export interface ContextMeasurementInput {
  readonly backendBindingId: M13StableId;
  readonly reservedOutputTokens: number;
  readonly reservedSafetyTokens: number;
  readonly additionalInputTokens?: number;
  readonly providerUsedInputTokens?: number | null;
}

export interface ContextFrameInputDraft {
  readonly kind: Exclude<ContextFrameV1['inputs'][number]['kind'], 'surface'>;
  readonly artifactId: M13StableId;
  readonly digest: M13Digest;
  readonly sourceRevision: number | null;
  readonly estimatedTokens: number;
  readonly required: boolean;
}

export interface CaptureContextFrameInput extends ContextMeasurementInput {
  readonly id?: M13StableId;
  readonly sessionId: M13StableId;
  readonly turnId: M13StableId;
  readonly projectRevision: number | null;
  readonly inputs?: readonly ContextFrameInputDraft[];
  readonly signal?: AbortSignal;
}

export interface CapturedContextFrameV1 {
  readonly frame: ContextFrameV1;
  readonly artifactId: M13StableId;
  readonly surfaceArtifactId: M13StableId;
}

export interface ContextPressureOptions {
  readonly warningRatio?: number;
  readonly preparingRatio?: number;
  readonly compactRatio?: number;
  readonly emergencyRatio?: number;
}

export interface ContextMeasurementResult {
  readonly pressure: ContextPressureV1;
  readonly usableInputTokens: number | null;
}

export interface ContextFrameRuntimeOptions {
  readonly clock?: () => Date;
  readonly idFactory?: (kind: 'context-frame', index: number) => M13StableId;
}

export type LatestCompactionRecord = CompactionRecordV1 | null;
