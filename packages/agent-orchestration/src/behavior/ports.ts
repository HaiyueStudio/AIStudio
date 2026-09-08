import type { BehaviorAnalysisInputV1, BehaviorExplanationV1, BehaviorManifestV1, BehaviorQueryResultV1, BehaviorSourceBindingV1, BehaviorTraceArtifactV1, BehaviorTraceV1, EditorLocationV1, ObservationArtifactV2 } from '@haiyue/ai-studio-contracts';
import type { ProjectBehaviorHistory } from '@haiyue/ai-studio-operation-log';

/** Injected from the existing root scope. No backend, editor or runtime implementation dependency. */
export interface BehaviorReadPort {
  analyze(input: unknown, signal?: AbortSignal): Promise<BehaviorManifestV1>;
  query(input: unknown): BehaviorQueryResultV1;
  locate(input: unknown): EditorLocationV1;
  resolveLocation(input: unknown): Readonly<{ status: 'current' | 'historical'; location: EditorLocationV1 }>;
  explain(input: unknown): BehaviorExplanationV1;
  invalidate(): void;
  dispose(): Promise<void>;
}

export interface BehaviorProjectIdentity { readonly projectId: string; readonly documentId: string; readonly revision: number; }
export interface BehaviorApprovedPlay {
  readonly id: string; readonly documentId: string; readonly documentRevision: number;
  readonly scripts: readonly Readonly<{ scriptId: string; emittedText: string }>[];
}
export interface BehaviorRuntimePort {
  prepare(source: BehaviorAnalysisInputV1, manifest: BehaviorManifestV1, selection: Readonly<{ playId: string; generation: number; scripts: BehaviorApprovedPlay['scripts'] }>): unknown;
  capture(plan: unknown, manifest: BehaviorManifestV1, input: unknown, metadata: Pick<ObservationArtifactV2, 'id' | 'taskId' | 'turnId' | 'capturedAt' | 'viewport' | 'device' | 'producerVersion'>): Readonly<{ artifact: BehaviorTraceArtifactV1; closed: boolean }>;
  assertProgress(previous: BehaviorTraceV1 | null, next: BehaviorTraceV1): void;
  associate(observation: unknown, trace: unknown, manifest: BehaviorManifestV1, play: Readonly<{ playId: string; generation: number }>): Readonly<{ status: 'current' | 'historical'; artifact: BehaviorTraceArtifactV1 }>;
}
export interface ProjectBehaviorPorts {
  current(): BehaviorProjectIdentity | null;
  readSource(signal: AbortSignal): unknown | Promise<unknown>;
  validateSource(input: unknown): BehaviorAnalysisInputV1;
  bindSource(input: unknown): BehaviorSourceBindingV1;
  validateLocation(input: unknown): EditorLocationV1;
  readonly reader: BehaviorReadPort;
  readonly history: Pick<ProjectBehaviorHistory, 'put' | 'read' | 'list' | 'related'>;
  readonly runtime?: BehaviorRuntimePort;
  readonly producerVersion?: string;
}
