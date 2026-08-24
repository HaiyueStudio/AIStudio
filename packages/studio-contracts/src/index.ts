export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export type {
  AgentTurnConfigV2,
  BackendCapabilityNegotiationV2,
  ComponentDefinitionV2,
  ContextArtifactV2,
  CostRecordV2,
  EvaluationResultV2,
  GameComponentInstanceV2,
  GameDocumentV2,
  M12CapabilityId,
  M12Digest,
  M12JsonValue,
  M12ReasoningEffort,
  M12SchemaVersion,
  M12StableId,
  ObservationArtifactV2,
  PricingCatalogV1,
  PricingEntryV1,
  TaskBudgetV2,
  TaskSpecV2,
  UsageRecordV2,
} from './m12.js';
export type StableId = string & { readonly __stableId: unique symbol };

export const STUDIO_PLUGIN_API_VERSION = '1.0' as const;
export const STUDIO_PROFILE_SCHEMA_VERSION = 1 as const;

export type StudioDiagnosticSeverity = 'info' | 'warning' | 'error';
export type StudioPluginState = 'installed' | 'loading' | 'active' | 'degraded' | 'failed' | 'disposing' | 'disposed';

export interface StudioDiagnostic {
  readonly code: string;
  readonly severity: StudioDiagnosticSeverity;
  readonly message: string;
  readonly pluginId?: StableId;
  readonly capabilityId?: StableId;
  readonly details?: JsonObject;
  readonly cause?: unknown;
}

export interface StudioDisposable {
  dispose(): void | Promise<void>;
}

export type StudioDisposer = StudioDisposable | (() => void | Promise<void>);

export interface StudioCapabilityRequirement {
  readonly id: StableId;
  readonly version: string;
}

export interface StudioCapabilityProvision {
  readonly id: StableId;
  readonly version: string;
}

export interface StudioPluginManifest {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly version: string;
  readonly apiVersion: typeof STUDIO_PLUGIN_API_VERSION;
  readonly required: readonly StudioCapabilityRequirement[];
  readonly optional: readonly StudioCapabilityRequirement[];
  readonly provides: readonly StudioCapabilityProvision[];
  readonly contributions: readonly StableId[];
  readonly activationPolicy: 'required' | 'default' | 'on-demand';
}

export interface StudioProfileBundle {
  readonly id: StableId;
  readonly rows: readonly StudioProfileRow[];
}

export interface StudioProfileRow {
  readonly id: StableId;
  readonly pluginId: StableId;
  readonly enabled: boolean;
  readonly config?: JsonObject;
}

export interface StudioProfilePatch {
  readonly pluginId: StableId;
  readonly config: JsonObject;
}

export interface StudioProfileDefinition {
  readonly schemaVersion: typeof STUDIO_PROFILE_SCHEMA_VERSION;
  readonly id: StableId;
  readonly bundles: readonly StudioProfileBundle[];
  readonly patches: readonly StudioProfilePatch[];
}

export interface StudioResolvedProfileRow {
  readonly id: StableId;
  readonly pluginId: StableId;
  readonly config: JsonObject;
  readonly sourceBundleId: StableId;
  readonly activationIndex: number;
}

export interface StudioResolvedProfile {
  readonly schemaVersion: typeof STUDIO_PROFILE_SCHEMA_VERSION;
  readonly id: StableId;
  readonly rows: readonly StudioResolvedProfileRow[];
  readonly configDump: string;
  readonly diagnostics: readonly StudioDiagnostic[];
}

export interface StudioServiceToken<T> {
  readonly id: StableId;
  readonly key: symbol;
  readonly _service?: T;
}

export interface StudioContribution<T = unknown> {
  readonly id: StableId;
  readonly kind: StableId;
  readonly value: T;
  readonly priority?: number;
}

export interface StudioServicePort {
  provide<T>(token: StudioServiceToken<T>, value: T): StudioDisposable;
  get<T>(token: StudioServiceToken<T>): T;
  optional<T>(token: StudioServiceToken<T>): T | undefined;
  has<T>(token: StudioServiceToken<T>): boolean;
}

export interface StudioContributionPort {
  register<T>(contribution: StudioContribution<T>): StudioDisposable;
  list<T = unknown>(kind: StableId): readonly StudioContribution<T>[];
}

export interface StudioEffectPort {
  own(label: string, disposer: StudioDisposer): StudioDisposable;
  acquire(label: string, effect: () => StudioDisposer | Promise<StudioDisposer>): StudioDisposable;
  readonly activeCount: number;
}

export interface StudioEventEnvelope<T extends JsonObject = JsonObject> {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly kind: StableId;
  readonly source: StableId;
  readonly timestamp: string;
  readonly payload: T;
}

export interface StudioEventPort {
  emitDurable(event: StudioEventEnvelope): void;
  emitLive(event: StudioEventEnvelope): void;
  onDurable(listener: (event: StudioEventEnvelope) => void): StudioDisposable;
  onLive(listener: (event: StudioEventEnvelope) => void): StudioDisposable;
}

export interface StudioOwnerToken {
  readonly id: StableId;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly active: boolean;
  assertActive(): void;
}

export interface StudioPluginActivationContext {
  readonly pluginId: StableId;
  readonly rowId: StableId;
  readonly owner: StudioOwnerToken;
  readonly services: StudioServicePort;
  readonly contributions: StudioContributionPort;
  readonly effects: StudioEffectPort;
  readonly events: StudioEventPort;
  readonly optionalCapabilities: Readonly<Record<string, boolean>>;
  report(diagnostic: StudioDiagnostic): void;
}

export interface StudioPluginDefinition<Config extends JsonObject = JsonObject> {
  readonly manifest: StudioPluginManifest;
  readonly validateConfig: (value: unknown) => Config;
  readonly activate: (context: StudioPluginActivationContext, config: Config) => void | StudioDisposer | Promise<void | StudioDisposer>;
}

export interface StudioPluginSnapshot {
  readonly id: StableId;
  readonly rowId: StableId;
  readonly version: string;
  readonly state: StudioPluginState;
  readonly activationIndex: number;
  readonly required: readonly StudioCapabilityRequirement[];
  readonly optional: Readonly<Record<string, boolean>>;
  readonly provides: readonly StudioCapabilityProvision[];
  readonly serviceCount: number;
  readonly contributionCount: number;
  readonly effectCount: number;
  readonly diagnostics: readonly StudioDiagnostic[];
}

export interface StudioKernelSnapshot {
  readonly profileId: StableId | null;
  readonly generation: number;
  readonly state: 'idle' | 'activating' | 'active' | 'failed' | 'disposing' | 'disposed';
  readonly plugins: readonly StudioPluginSnapshot[];
  readonly diagnostics: readonly StudioDiagnostic[];
  readonly resources: Readonly<{
    services: number;
    contributions: number;
    listeners: number;
    effects: number;
    fibers: number;
  }>;
}

export interface StudioKernelHost extends StudioDisposable {
  activate(profile: StudioProfileDefinition, catalog: readonly StudioPluginDefinition[]): Promise<void>;
  replace(profile: StudioProfileDefinition, catalog: readonly StudioPluginDefinition[]): Promise<void>;
  disable(pluginId: StableId): Promise<void>;
  snapshot(): StudioKernelSnapshot;
  dumpResolvedProfile(): string | null;
}

export function asStableId(value: string, kind = 'id'): StableId {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized)) {
    throw new TypeError(`Invalid ${kind} ${JSON.stringify(value)}.`);
  }
  return normalized as StableId;
}

export function createStudioServiceToken<T>(id: string): StudioServiceToken<T> {
  const stable = asStableId(id, 'service token');
  return Object.freeze({ id: stable, key: Symbol.for(`@haiyue/ai-studio-service/${stable}`) });
}

export function defineStudioPlugin<Config extends JsonObject>(definition: StudioPluginDefinition<Config>): StudioPluginDefinition<Config> {
  if (definition.manifest.schemaVersion !== 1) throw new TypeError('Unsupported Studio plugin schema version.');
  if (definition.manifest.apiVersion !== STUDIO_PLUGIN_API_VERSION) throw new TypeError(`Unsupported Studio plugin API ${definition.manifest.apiVersion}.`);
  asStableId(definition.manifest.id, 'plugin id');
  return Object.freeze({ ...definition, manifest: freezeManifest(definition.manifest) });
}

function freezeManifest(manifest: StudioPluginManifest): StudioPluginManifest {
  return Object.freeze({
    ...manifest,
    required: Object.freeze(manifest.required.map((entry) => Object.freeze({ ...entry }))),
    optional: Object.freeze(manifest.optional.map((entry) => Object.freeze({ ...entry }))),
    provides: Object.freeze(manifest.provides.map((entry) => Object.freeze({ ...entry }))),
    contributions: Object.freeze([...manifest.contributions]),
  });
}
