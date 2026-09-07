import type { ComponentDefinitionV2, GameDocumentV2, M12Digest, M12JsonValue, ObservationArtifactV2 } from './m12.js';

/** Private, read-only projections. GameDocument/History remain the only authoring authority. */
export interface BehaviorSourceBindingV1 {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly documentDigest: M12Digest;
  readonly scripts: readonly Readonly<{ id: string; digest: M12Digest; textRevision: number; enabled: boolean }>[];
  readonly componentsDigest: M12Digest;
  readonly dependenciesDigest: M12Digest;
  readonly registry: Readonly<{ version: string; digest: M12Digest }>;
  readonly adapters: readonly BehaviorAdapterIdentityV1[];
  readonly digest: M12Digest;
}
export interface BehaviorAdapterIdentityV1 {
  readonly id: string;
  readonly version: string;
  readonly digest: M12Digest;
}
/** Offsets use UTF-16 code units, end exclusive; lines and columns are one-based. */
export interface BehaviorSourceRangeV1 {
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}
export type BehaviorSourceV1 =
  | Readonly<{ kind: 'script'; entityId: string; scriptId: string; digest: M12Digest; path: string; range: BehaviorSourceRangeV1 }>
  | Readonly<{ kind: 'declarative-component'; entityId: string; componentId: string; componentType: string; componentVersion: string; field: string }>
  | Readonly<{ kind: 'runtime-adapter'; entityId: string; componentId: string; adapter: BehaviorAdapterIdentityV1; field: string }>;
export type BehaviorNodeKindV1 = 'entry' | 'statement' | 'condition' | 'loop' | 'call' | 'await' | 'fork' | 'join' | 'return' | 'throw' | 'try' | 'catch' | 'finally' | 'trigger' | 'action' | 'driver' | 'unknown';
export type BehaviorUnknownReasonV1 = 'dynamic-call' | 'unsupported-syntax' | 'syntax-error' | 'unresolved-reference' | 'unregistered-adapter' | 'adapter-internals' | 'budget';
export interface BehaviorNodeV1 {
  readonly id: string;
  readonly kind: BehaviorNodeKindV1;
  /** Fixed semantic label, never a copy of arbitrary source text. */
  readonly label: string;
  readonly source: BehaviorSourceV1;
  readonly unknown: BehaviorUnknownReasonV1 | null;
}
export interface BehaviorEdgeV1 {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: 'sequence' | 'true' | 'false' | 'loop-body' | 'loop-back' | 'await' | 'concurrent' | 'join' | 'exception' | 'finally' | 'trigger' | 'drives';
  readonly evidence: BehaviorSourceV1;
}
export interface BehaviorTruncationV1 {
  readonly truncated: boolean;
  readonly reasons: readonly ('nodes' | 'edges' | 'ast' | 'bytes' | 'events')[];
  /** A lower bound, not an invented total for unvisited source. */
  readonly omittedAtLeast: number;
}
export interface BehaviorManifestV1 {
  readonly schemaVersion: 1;
  readonly binding: BehaviorSourceBindingV1;
  readonly analyzerVersion: string;
  readonly analysisConfigDigest: M12Digest;
  readonly nodes: readonly BehaviorNodeV1[];
  readonly edges: readonly BehaviorEdgeV1[];
  readonly triggers: readonly string[];
  readonly truncation: BehaviorTruncationV1;
  readonly digest: M12Digest;
}
export interface BehaviorExplanationV1 {
  readonly schemaVersion: 1;
  readonly manifestDigest: M12Digest;
  readonly language: string;
  readonly producerVersion: string;
  readonly producer: Readonly<{ kind: 'verified-structure'; templateVersion: string }> | Readonly<{ kind: 'agent-claim'; model: string | null; profile: string | null }>;
  readonly entries: readonly Readonly<{ nodeId: string; text: string; evidence: readonly BehaviorSourceV1[] }>[];
  readonly digest: M12Digest;
}
export interface BehaviorTraceV1 {
  readonly schemaVersion: 1;
  readonly sourceBindingDigest: M12Digest;
  readonly manifestDigest: M12Digest;
  readonly playId: string;
  readonly generation: number;
  readonly events: readonly Readonly<{
    sequence: number; entityId: string; componentId: string | null; scriptId: string | null;
    nodeId: string | null; kind: 'event' | 'node-enter' | 'node-exit' | 'state-diff' | 'error' | 'cancel';
    event: string | null; tick: number; frame: number; durationMicros: number | null;
    stateDiff: Readonly<Record<string, M12JsonValue>> | null; error: string | null;
  }>[];
  readonly truncation: BehaviorTruncationV1;
  readonly digest: M12Digest;
}
/** Associated storage pair; the existing observation digest hashes the canonical trace bytes. */
export interface BehaviorTraceArtifactV1 {
  readonly observation: ObservationArtifactV2;
  readonly trace: BehaviorTraceV1;
}
export type ResourceReferenceV1 =
  | Readonly<{ kind: 'asset'; assetId: string; digest: M12Digest; source: 'builtin' | 'project' | 'imported' }>
  | Readonly<{ kind: 'template'; templateId: string; registryVersion: string; defaultsDigest: M12Digest }>
  | Readonly<{ kind: 'preset'; presetId: string; schemaId: string; schemaVersion: string; valueDigest: M12Digest }>
  | Readonly<{ kind: 'instance'; projectId: string; entityId: string; documentRevision: number; componentId: string | null }>;
export type ResourceKnowledgeV1<T> = Readonly<{ status: 'known'; items: readonly T[] }> | Readonly<{ status: 'unknown' | 'inapplicable'; reason: string }>;
interface ResourceCatalogBaseV1 {
  readonly schemaVersion: 1;
  readonly catalogEntryId: string;
  readonly category: string;
  readonly label: string;
  readonly status: 'available' | 'unavailable';
  readonly artifactId: string | null;
  readonly dependencies: ResourceKnowledgeV1<ResourceReferenceV1>;
  readonly usage: ResourceKnowledgeV1<Extract<ResourceReferenceV1, { kind: 'instance' }>>;
}
export type ResourceCatalogEntryV1 = ResourceCatalogBaseV1 & (
  | Readonly<{ kind: 'asset'; source: 'controlled-manifest'; ref: Extract<ResourceReferenceV1, { kind: 'asset' }>; intents: readonly ('resource.locate' | 'asset.assign' | 'asset.inspect')[]; unused: 'yes' | 'no' | 'unknown' }>
  | Readonly<{ kind: 'template'; source: 'registry' | 'unsupported'; ref: Extract<ResourceReferenceV1, { kind: 'template' }>; intents: readonly ('resource.locate' | 'template.create')[]; unused: 'inapplicable' }>
  | Readonly<{ kind: 'preset'; source: 'project-record' | 'unsupported'; ref: Extract<ResourceReferenceV1, { kind: 'preset' }>; intents: readonly ('resource.locate' | 'preset.apply')[]; unused: 'inapplicable' }>
  | Readonly<{ kind: 'instance'; source: 'document'; ref: Extract<ResourceReferenceV1, { kind: 'instance' }>; intents: readonly ('resource.locate' | 'instance.inspect')[]; unused: 'inapplicable' }>
);
export interface EditorLocationV1 {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly sourceBindingDigest: M12Digest;
  readonly target:
    | Readonly<{ kind: 'entity'; entityId: string }>
    | Readonly<{ kind: 'component'; entityId: string; componentId: string; componentVersion: string; field: string }>
    | Readonly<{ kind: 'script'; source: Extract<BehaviorSourceV1, { kind: 'script' }> }>
    | Readonly<{ kind: 'resource'; ref: ResourceReferenceV1 }>
    | Readonly<{ kind: 'behavior-node'; manifestDigest: M12Digest; nodeId: string; source: BehaviorSourceV1 }>
    | Readonly<{ kind: 'evidence'; artifactId: string; digest: M12Digest }>;
}
export interface BehaviorAnalysisConfigV1 {
  readonly schemaVersion: 1;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxAstNodes: number;
  readonly maxAstDepth: number;
}
/** Input is a bounded snapshot of existing contracts, never a second Document format. */
export interface BehaviorAnalysisInputV1 {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly document: GameDocumentV2;
  readonly registry: Readonly<{ version: string; definitions: readonly ComponentDefinitionV2[] }>;
  readonly adapters: readonly BehaviorAdapterIdentityV1[];
  readonly config: BehaviorAnalysisConfigV1;
}
export interface BehaviorQueryV1 {
  readonly schemaVersion: 1;
  readonly manifestDigest: M12Digest;
  readonly sourceBindingDigest: M12Digest;
  readonly entityId?: string;
  readonly kind?: BehaviorNodeKindV1;
  readonly offset: number;
  readonly limit: number;
}
export interface BehaviorQueryResultV1 {
  readonly manifestDigest: M12Digest;
  readonly nodes: readonly BehaviorNodeV1[];
  readonly edges: readonly BehaviorEdgeV1[];
  readonly nextOffset: number | null;
}
