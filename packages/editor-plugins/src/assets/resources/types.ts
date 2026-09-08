import type { BehaviorSourceBindingV1, EditorLocationV1, JsonObject, JsonValue, ResourceCatalogEntryV1, ResourceReferenceV1 } from '@haiyue/ai-studio-contracts';
import type { ProjectWorkspace } from '../../history/workspace.js';
import type { ControlledAssetManifestEntry } from '../catalog.js';

export type ResourceAction = ResourceCatalogEntryV1['intents'][number];
export type AssetAssignmentUsage = Parameters<import('../catalog.js').ControlledAssetCatalog['assignment']>[1];

/** Private query binding, not a second persisted resource envelope. */
export interface ResourceCatalogBinding {
  readonly projectId: string;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly registryVersion: string;
  readonly registryDigest: string;
  readonly digest: `sha256:${string}`;
}
export interface ResourceUsageLocation {
  readonly ref: Extract<ResourceReferenceV1, { kind: 'instance' }>;
  readonly label: string;
  readonly componentType: string;
  readonly field: string;
}
export interface ResourceCatalogItem {
  readonly entry: ResourceCatalogEntryV1;
  readonly health: 'registered' | 'verified' | 'missing' | 'invalid' | 'unavailable';
  readonly diagnostics: readonly string[];
  /** Proven locations remain visible even when the complete usage set is unknown. */
  readonly locations: readonly ResourceUsageLocation[];
  readonly asset: ControlledAssetManifestEntry | null;
  readonly configuration: JsonValue | null;
  readonly target: 'none' | 'entity';
  readonly assignments: readonly AssetAssignmentUsage[];
}
export interface ResourceCatalogPage {
  readonly binding: ResourceCatalogBinding | null;
  readonly items: readonly ResourceCatalogItem[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly categories: readonly string[];
  readonly diagnostics: readonly string[];
}
export interface ResourceCatalogQuery {
  readonly text?: string;
  readonly category?: string;
  readonly kind?: ResourceCatalogEntryV1['kind'];
  readonly status?: ResourceCatalogEntryV1['status'];
  readonly unused?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ResourceActionInput {
  readonly binding: ResourceCatalogBinding;
  readonly entry: ResourceCatalogEntryV1;
  readonly action: ResourceAction;
  readonly targetEntityId?: string;
  readonly usage?: AssetAssignmentUsage;
}
export interface ResourceCatalogPorts {
  readonly workspace: Pick<ProjectWorkspace, 'snapshot' | 'gameSnapshot' | 'readControlledAsset' | 'componentRegistry'>;
  /** G05's authoritative source callback, using G02's frozen binding algorithm. */
  readonly binding: () => BehaviorSourceBindingV1;
  /** G02 owns frozen resource validation. Inject it without a package cycle. */
  readonly validateEntry: (value: unknown) => ResourceCatalogEntryV1;
  readonly validateLocation: (value: unknown) => EditorLocationV1;
  /** Existing asset.dependencies query; a partial or failed result stays unknown. */
  readonly dependencies: (signal?: AbortSignal) => Promise<unknown>;
  /** Existing tool/approval/History path. Never a new registry or direct writer. */
  readonly request: (toolId: string, args: JsonObject, binding: ResourceCatalogBinding, signal?: AbortSignal) => Promise<JsonValue>;
}
export type ResourceActionResult =
  | Readonly<{ kind: 'location'; location: EditorLocationV1 }>
  | Readonly<{ kind: 'inspection'; item: ResourceCatalogItem }>
  | Readonly<{ kind: 'workflow'; result: JsonValue }>;
