/**
 * M12 provider-neutral authoring and evaluation contracts.
 *
 * These types are intentionally data-only. Runtime owners validate the matching
 * JSON Schemas before converting external `unknown` payloads to these shapes.
 */

export type M12SchemaVersion = 2;
export type M12StableId = string;
export type M12Digest = `sha256:${string}`;
export type M12JsonValue = null | boolean | number | string | readonly M12JsonValue[] | { readonly [key: string]: M12JsonValue };

export type M12CapabilityId =
  | 'agent.model-config' | 'agent.usage' | 'agent.cache' | 'agent.context'
  | 'task.evaluate' | 'document.v2' | 'component.registry' | 'scene.transaction'
  | 'camera.2d' | 'camera.3d' | 'camera.follow'
  | 'input.keyboard' | 'input.pointer' | 'input.inject'
  | 'simulation.fixed-step' | 'simulation.replay' | 'interaction.pointer'
  | 'physics.2d' | 'physics.3d' | 'physics.raycast'
  | 'lighting' | 'shadow.directional' | 'material.pbr' | 'postprocess'
  | 'particles.2d' | 'particles.3d' | 'animation.2d' | 'animation.3d'
  | 'audio.playback' | 'asset.import' | 'prefab'
  | 'play.multi-script' | 'play.capture' | 'play.inspect' | 'diagnostics.query';

export type M12ReasoningEffort = 'backend-default' | 'off' | 'low' | 'medium' | 'high' | 'xhigh';

export interface AgentTurnConfigV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly backendId: M12StableId;
  readonly model: string;
  readonly reasoningEffort: M12ReasoningEffort;
  readonly outputTokenLimit: number;
  readonly taskBudgetId: M12StableId;
  readonly promptProfile: Readonly<{ id: M12StableId; version: string; digest: M12Digest }>;
  readonly requestedCapabilities: readonly M12CapabilityId[];
}

export interface BackendCapabilityNegotiationV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly backendId: M12StableId;
  readonly protocolVersion: string;
  readonly requested: AgentTurnConfigV2;
  readonly status: 'accepted' | 'degraded' | 'rejected';
  readonly effective: Readonly<{
    model: string;
    reasoningEffort: M12ReasoningEffort;
    outputTokenLimit: number;
    capabilities: readonly M12CapabilityId[];
  }> | null;
  readonly diagnostics: readonly Readonly<{ code: string; message: string; capability?: M12CapabilityId }>[];
}

export interface UsageRecordV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly id: M12StableId;
  readonly taskId: M12StableId;
  readonly sessionId: M12StableId;
  readonly turnId: M12StableId;
  readonly stepId?: M12StableId;
  readonly toolCallId?: M12StableId;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly toolInputBytes: number;
  readonly toolOutputBytes: number;
  readonly wallTimeMs: number;
  readonly providerRequestDigest: M12Digest | null;
  readonly contextCache?: Readonly<{
    readonly localArtifactHits: number;
    readonly localArtifactMisses: number;
    readonly deltaReuseBytes: number;
    readonly providerCacheEligibleBytes: number;
    /** Null means the provider did not report cache-read evidence. */
    readonly providerReportedHitTokens: number | null;
  }>;
  readonly final: boolean;
}

export interface CostRecordV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly id: M12StableId;
  readonly usageRecordId: M12StableId;
  readonly pricingCatalogId: M12StableId | null;
  readonly pricingCatalogVersion: string | null;
  readonly effectiveAt: string | null;
  readonly currency: string | null;
  readonly amountMicros: number | null;
  readonly status: 'actual' | 'estimated' | 'unknown';
  readonly formula: string | null;
}

export interface PricingCatalogV1 {
  readonly schemaVersion: 1;
  readonly id: M12StableId;
  readonly version: string;
  readonly effectiveAt: string;
  readonly currency: string;
  readonly sources: readonly Readonly<{ provider: string; url: string; retrievedAt: string }>[];
  readonly entries: readonly PricingEntryV1[];
}

export interface PricingEntryV1 {
  readonly provider: string;
  readonly model: string;
  readonly inputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number | null;
  readonly cacheWriteMicrosPerMillion: number | null;
  readonly outputMicrosPerMillion: number;
  readonly reasoningBilling: 'included-in-output' | 'separate-as-output';
}

export interface TaskBudgetV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly id: M12StableId;
  readonly limits: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostMicros: number | null;
    wallTimeMs: number;
    turns: number;
    toolCalls: number;
    repairIterations: number;
    observationBytes: number;
  }>;
  readonly enforcement: 'observe' | 'soft' | 'hard';
}

export interface ContextArtifactV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly id: M12StableId;
  readonly kind: 'policy' | 'capability-manifest' | 'project-manifest' | 'document-delta' | 'task-summary' | 'playbook';
  readonly digest: M12Digest;
  readonly source: M12StableId;
  readonly documentRevision: number | null;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly redacted: boolean;
  readonly createdAt: string;
}

export interface ComponentDefinitionV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly type: M12StableId;
  readonly version: string;
  readonly owner: M12StableId;
  readonly capability: M12CapabilityId;
  readonly effect: 'data' | 'runtime-owner' | 'gpu-owner' | 'audio-owner';
  readonly risk: 'low' | 'medium' | 'high';
  readonly valueSchema: Readonly<Record<string, M12JsonValue>>;
  readonly defaults: Readonly<Record<string, M12JsonValue>>;
  readonly validation: Readonly<{
    mode: 'json-schema';
    unknownProperties: 'reject';
    maxSerializedBytes: number;
  }>;
  readonly editor: Readonly<{
    label: string;
    category: string;
    inspector: M12StableId | null;
  }>;
  readonly serializable: boolean;
  readonly runtimeAdapter: M12StableId | null;
  readonly serialization: Readonly<{
    format: 'json';
    persistDisabled: boolean;
  }>;
  readonly testOwner: M12StableId;
}

export interface GameComponentInstanceV2 {
  readonly id: M12StableId;
  readonly type: M12StableId;
  readonly version: string;
  readonly enabled: boolean;
  readonly value: Readonly<Record<string, M12JsonValue>>;
}

export interface GameDocumentV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly id: M12StableId;
  readonly revision: number;
  readonly savedRevision: number;
  readonly scenes: readonly Readonly<{ id: M12StableId; name: string; rootEntityIds: readonly M12StableId[] }>[];
  readonly entities: readonly Readonly<{
    id: M12StableId;
    sceneId: M12StableId;
    name: string;
    parentId: M12StableId | null;
    order: number;
    componentIds: readonly M12StableId[];
  }>[];
  readonly components: readonly GameComponentInstanceV2[];
  readonly scripts: readonly Readonly<{
    id: M12StableId;
    entityId: M12StableId;
    name: string;
    sourcePath: string;
    source: string;
    textRevision: number;
    enabled: boolean;
    order: number;
    capabilities: readonly string[];
    digest: M12Digest;
  }>[];
  readonly assets: readonly Readonly<{ id: M12StableId; kind: string; digest: M12Digest; source: 'builtin' | 'project' | 'imported' }>[];
  readonly settings: Readonly<Record<string, M12JsonValue>>;
  readonly migration: Readonly<{ fromVersion: number | null; migratedAt: string | null; sourceDigest: M12Digest | null }>;
}

export type GameDocumentOperationV2 =
  | Readonly<{ op: 'scene.add'; scene: GameDocumentV2['scenes'][number] }>
  | Readonly<{ op: 'scene.remove'; sceneId: M12StableId }>
  | Readonly<{ op: 'entity.add'; entity: GameDocumentV2['entities'][number] }>
  | Readonly<{ op: 'entity.update'; entityId: M12StableId; patch: Readonly<{ name?: string; parentId?: M12StableId | null; order?: number }> }>
  | Readonly<{ op: 'entity.remove'; entityId: M12StableId }>
  | Readonly<{ op: 'component.add'; entityId: M12StableId; component: GameComponentInstanceV2 }>
  | Readonly<{ op: 'component.patch'; componentId: M12StableId; path: readonly string[]; value: M12JsonValue }>
  | Readonly<{ op: 'component.unset'; componentId: M12StableId; path: readonly string[] }>
  | Readonly<{ op: 'component.replace'; component: GameComponentInstanceV2 }>
  | Readonly<{ op: 'component.remove'; entityId: M12StableId; componentId: M12StableId }>
  | Readonly<{ op: 'script.upsert'; script: GameDocumentV2['scripts'][number] }>
  | Readonly<{ op: 'script.remove'; scriptId: M12StableId }>
  | Readonly<{ op: 'asset.upsert'; asset: GameDocumentV2['assets'][number] }>
  | Readonly<{ op: 'asset.remove'; assetId: M12StableId }>
  | Readonly<{ op: 'setting.set'; key: string; value: M12JsonValue }>
  | Readonly<{ op: 'setting.remove'; key: string }>;

export interface GameDocumentBatchV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly id: M12StableId;
  readonly label: string;
  readonly documentId: M12StableId;
  readonly baseRevision: number;
  readonly operations: readonly GameDocumentOperationV2[];
}

export interface GameDocumentDeltaV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly transactionId: M12StableId;
  readonly documentId: M12StableId;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly operations: readonly GameDocumentOperationV2[];
  readonly inverse: readonly GameDocumentOperationV2[];
  readonly metrics: Readonly<{ copiedBytes: number; historyBytes: number; projectionWork: number; durationMicros: number }>;
}

export interface GameDocumentQueryV2 {
  readonly sceneId?: M12StableId;
  readonly entityId?: M12StableId;
  readonly componentType?: M12StableId;
  readonly cursor?: string;
  readonly limit: number;
}

export interface GameDocumentQueryResultV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly documentId: M12StableId;
  readonly revision: number;
  readonly entities: readonly GameDocumentV2['entities'][number][];
  readonly components: readonly GameComponentInstanceV2[];
  readonly nextCursor: string | null;
  readonly scanned: number;
}

export interface ObservationArtifactV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly id: M12StableId;
  readonly type: 'state' | 'event-trace' | 'runtime-errors' | 'performance' | 'screenshot' | 'visual-analysis' | 'lifecycle';
  readonly digest: M12Digest;
  readonly taskId: M12StableId;
  readonly turnId: M12StableId;
  readonly playId: M12StableId;
  readonly documentRevision: number;
  readonly scriptDigests: readonly M12Digest[];
  readonly tick: number;
  readonly frame: number;
  readonly viewport: Readonly<{ width: number; height: number }> | null;
  readonly device: string | null;
  readonly capturedAt: string;
  readonly byteLength: number;
  readonly redacted: boolean;
  readonly producerVersion: string;
}

export interface TaskSpecV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly id: M12StableId;
  readonly request: string;
  readonly visibleConstraints: readonly string[];
  readonly budgetId: M12StableId;
  readonly requiredCapabilities: readonly M12CapabilityId[];
  readonly acceptance: readonly Readonly<{
    id: M12StableId;
    required: boolean;
    visibility: 'agent' | 'runner-only';
    category: 'functional' | 'visual' | 'performance' | 'lifecycle' | 'budget' | 'security';
    assertion: string;
  }>[];
}

export interface EvaluationResultV2 {
  readonly schemaVersion: M12SchemaVersion;
  readonly id: M12StableId;
  readonly taskId: M12StableId;
  readonly evaluatorVersion: string;
  readonly status: 'pass' | 'fail' | 'blocked';
  readonly acceptanceResults: readonly Readonly<{
    acceptanceId: M12StableId;
    status: 'pass' | 'fail' | 'blocked';
    evidenceIds: readonly M12StableId[];
    diagnostic: string | null;
  }>[];
  readonly budgetStatus: 'within' | 'soft-exceeded' | 'hard-exceeded';
  readonly usageRecordIds: readonly M12StableId[];
  readonly costRecordIds: readonly M12StableId[];
  readonly turns: readonly Readonly<{ turnId: M12StableId; usageRecordIds: readonly M12StableId[]; finishReason: 'stop' | 'length' | 'tool-calls' | 'cancelled' | 'content-filter' | 'error' | 'unknown' }>[];
  readonly tools: readonly Readonly<{ toolCallId: M12StableId; turnId: M12StableId; usageRecordIds: readonly M12StableId[] }>[];
  readonly completedAt: string;
}
