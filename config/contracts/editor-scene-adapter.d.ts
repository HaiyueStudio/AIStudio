import type { JsonValue, StableId } from './studio-contracts.js';

/** AIStudio-owned Scene product port. This is not an export of the private M03 Scene Editor product. */

export const SCENE_ADAPTER_API_VERSION: '1';

export type SceneVector3 = readonly [number, number, number];

export interface PublicSceneTransform {
  readonly position: SceneVector3;
  readonly rotationDegrees: SceneVector3;
  readonly scale: SceneVector3;
}

export interface PublicSceneEntity {
  readonly id: StableId;
  readonly name: string;
  readonly primitive: 'empty' | 'cube' | 'other';
  readonly parentId: StableId | null;
  readonly transform: PublicSceneTransform;
  readonly scriptId: StableId | null;
}

export interface PublicSceneSnapshot {
  readonly apiVersion: typeof SCENE_ADAPTER_API_VERSION;
  readonly documentId: StableId;
  readonly revision: number;
  readonly coordinateSystem: 'right-handed-y-up';
  readonly entities: readonly PublicSceneEntity[];
}

export type PublicSceneMutation =
  | Readonly<{
      kind: 'entity.create';
      entityId: StableId;
      name: string;
      primitive: 'empty' | 'cube';
      parentId: StableId | null;
      transform: PublicSceneTransform;
    }>
  | Readonly<{ kind: 'transform.set'; entityId: StableId; transform: PublicSceneTransform }>
  | Readonly<{ kind: 'script.attach'; entityId: StableId; scriptId: StableId | null }>;

export interface SceneMutationContext {
  readonly documentId: StableId;
  readonly baseRevision: number;
  readonly commandId: StableId;
  readonly signal?: AbortSignal;
}

export interface PreparedSceneMutation {
  readonly token: StableId;
  readonly documentId: StableId;
  readonly baseRevision: number;
  readonly mutationDigest: string;
  readonly preview: Readonly<Record<string, JsonValue>>;
  readonly previewDigest: string;
}

export interface SceneCommitResult {
  readonly documentId: StableId;
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly StableId[];
  readonly historyEntryId: string;
}

export interface SceneAdapterDiagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly documentId?: StableId;
  readonly entityId?: StableId;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface PublicSceneAdapter {
  readonly apiVersion: typeof SCENE_ADAPTER_API_VERSION;
  readonly documentId: StableId;
  snapshot(): PublicSceneSnapshot;
  prepare(mutation: PublicSceneMutation, context: SceneMutationContext): Promise<PreparedSceneMutation>;
  commit(prepared: PreparedSceneMutation, context: SceneMutationContext & { readonly historyLabel: string }): SceneCommitResult;
  rollback(prepared: PreparedSceneMutation, reason: 'cancelled' | 'rejected' | 'stale' | 'failed'): void | Promise<void>;
  subscribe(listener: (snapshot: PublicSceneSnapshot) => void): { dispose(): void };
  subscribeDiagnostics(listener: (diagnostic: SceneAdapterDiagnostic) => void): { dispose(): void };
  pick(normalizedX: number, normalizedY: number, signal?: AbortSignal): Promise<StableId | null>;
  dispose(): void | Promise<void>;
}

export function defineSceneAdapter(adapter: PublicSceneAdapter): PublicSceneAdapter;

export interface SceneAdapterConformanceResult {
  readonly passed: true;
  readonly checks: readonly string[];
}

export function runSceneAdapterConformance(factory: () => PublicSceneAdapter): Promise<SceneAdapterConformanceResult>;
