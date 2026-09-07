import type { BehaviorExplanationV1, BehaviorManifestV1, BehaviorQueryResultV1, EditorLocationV1 } from '@haiyue/ai-studio-contracts';

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
