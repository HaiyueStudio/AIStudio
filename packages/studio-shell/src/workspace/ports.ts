import type { BehaviorManifestV1, BehaviorSourceBindingV1, BehaviorSourceV1, EditorLocationV1, ResourceCatalogEntryV1 } from '@haiyue/ai-studio-contracts';

/** Presentation inputs, supplied by the existing project owner after boundary validation. */
export interface WorkspaceEntityOption {
  readonly id: string;
  readonly name: string;
  readonly sources: readonly BehaviorSourceV1['kind'][];
}
export interface WorkspacePanelSnapshot {
  readonly documentId: string | null;
  readonly documentRevision: number;
  readonly entities: readonly WorkspaceEntityOption[];
  readonly selectedEntityId: string | null;
  /** G05 supplies these together; an absent binding never authorizes a stale projection. */
  readonly sourceBinding: BehaviorSourceBindingV1 | null;
  readonly behavior: BehaviorManifestV1 | null;
  readonly catalog: readonly ResourceCatalogEntryV1[] | null;
}
export type WorkspacePanelIntent =
  | Readonly<{ type: 'workspace/select-entity'; entityId: string | null }>
  | Readonly<{ type: 'workspace/locate'; location: EditorLocationV1 }>
  | Readonly<{ type: 'workspace/resource'; entry: ResourceCatalogEntryV1; intent: ResourceCatalogEntryV1['intents'][number] }>;
export interface WorkspacePanelPort {
  /** Effects and location authority remain in the injected owner, never in a panel. */
  dispatch(intent: WorkspacePanelIntent): void | Promise<void>;
}
export interface WorkspacePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
