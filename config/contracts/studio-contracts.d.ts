export type StableId = string & { readonly __stableId: unique symbol };
export type SchemaVersion = 1;
export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export interface PluginManifest {
  readonly schemaVersion: SchemaVersion;
  readonly id: StableId;
  readonly version: string;
  readonly apiVersion: string;
  readonly capabilities: { readonly required: readonly StableId[]; readonly optional: readonly StableId[] };
  readonly contributions: readonly StableId[];
  readonly activationPolicy: 'required' | 'default' | 'on-demand';
  readonly config: Readonly<Record<string, JsonValue>>;
}

export interface ProfileDefinition {
  readonly schemaVersion: SchemaVersion;
  readonly id: StableId;
  readonly plugins: readonly StableId[];
  readonly patches: readonly { readonly pluginId: StableId; readonly config: Readonly<Record<string, JsonValue>> }[];
}

export interface LifecycleEffectRecord {
  readonly schemaVersion: SchemaVersion;
  readonly effectId: StableId;
  readonly ownerId: StableId;
  readonly pluginId: StableId;
  readonly kind: 'registration' | 'subscription' | 'timer' | 'worker' | 'process' | 'file-handle' | 'object-url' | 'runtime' | 'gpu-owner';
  readonly state: 'active' | 'disposing' | 'disposed' | 'failed';
}

export interface CorrelationIds {
  readonly sessionId?: StableId;
  readonly turnId?: StableId;
  readonly stepId?: StableId;
  readonly toolCallId?: StableId;
  readonly approvalId?: StableId;
  readonly pluginId?: StableId;
  readonly commandId?: StableId;
  readonly transactionId?: StableId;
  readonly documentId?: StableId;
  readonly entityId?: StableId;
}

export interface DurableEventEnvelope {
  readonly schemaVersion: SchemaVersion;
  readonly eventId: StableId;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly severity: 'debug' | 'info' | 'warning' | 'error';
  readonly source: StableId;
  readonly correlation: CorrelationIds;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly redactedFields: readonly string[];
}

export type AgentBackendEventKind =
  | 'status' | 'conversation-node' | 'tool-request' | 'question' | 'approval'
  | 'usage' | 'completed' | 'diagnostic';

export interface AgentBackendEvent {
  readonly schemaVersion: SchemaVersion;
  readonly backendId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly kind: AgentBackendEventKind;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface AgentBackendCapabilities {
  readonly resume: boolean;
  readonly questions: boolean;
  readonly structuredTools: boolean;
  readonly backendApprovals: boolean;
  readonly usage: boolean;
  readonly rateLimits: boolean;
}

export interface AgentBackendDescriptor {
  readonly schemaVersion: SchemaVersion;
  readonly id: StableId;
  readonly kind: 'harness-api-key' | 'codex-app-server';
  readonly protocolVersion: string;
  readonly capabilities: AgentBackendCapabilities;
}

export interface AgentBackend {
  readonly descriptor: AgentBackendDescriptor;
  authenticate(signal?: AbortSignal): Promise<void>;
  status(signal?: AbortSignal): Promise<Readonly<Record<string, JsonValue>>>;
  logout(signal?: AbortSignal): Promise<void>;
  startTurn(input: Readonly<Record<string, JsonValue>>, signal?: AbortSignal): AsyncIterable<AgentBackendEvent>;
  resumeTurn(sessionId: StableId, turnId: StableId, signal?: AbortSignal): AsyncIterable<AgentBackendEvent>;
  submitToolResult(toolCallId: StableId, result: Readonly<Record<string, JsonValue>>): Promise<void>;
  answerQuestion(nodeId: StableId, answer: Readonly<Record<string, JsonValue>>): Promise<void>;
  resolveBackendApproval(id: StableId, decision: 'allow' | 'reject'): Promise<void>;
  cancelTurn(sessionId: StableId, turnId: StableId): Promise<void>;
  dispose(): void | Promise<void>;
}

export type ConversationNodeKind =
  | 'text' | 'progress' | 'question' | 'plan' | 'tool-call'
  | 'tool-result' | 'approval' | 'diagnostic' | 'completion';

export interface ConversationNode {
  readonly schemaVersion: SchemaVersion;
  readonly id: StableId;
  readonly kind: ConversationNodeKind;
  readonly status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  readonly createdAt: string;
  readonly provenance: { readonly backendId: StableId; readonly sessionId: StableId; readonly turnId: StableId; readonly stepId?: StableId };
  readonly content: Readonly<Record<string, JsonValue>>;
}

export type ToolEffect = 'observe' | 'reversible-edit' | 'trusted-code' | 'runtime-start';
export type ToolRisk = 'low' | 'medium' | 'high';

export interface ToolDefinition {
  readonly schemaVersion: SchemaVersion;
  readonly id: StableId;
  readonly version: string;
  readonly effect: ToolEffect;
  readonly risk: ToolRisk;
  readonly requiredCapabilities: readonly StableId[];
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly outputSchema: Readonly<Record<string, JsonValue>>;
  readonly redactedFields: readonly string[];
}

export interface ApprovalRecord {
  readonly schemaVersion: SchemaVersion;
  readonly approvalId: StableId;
  readonly toolCallId: StableId;
  readonly toolId: StableId;
  readonly toolVersion: string;
  readonly effect: Exclude<ToolEffect, 'observe'>;
  readonly argsDigest: string;
  readonly previewDigest: string;
  readonly documentId: StableId;
  readonly baseRevision: number;
  readonly expiresAt: string;
  readonly decision: 'pending' | 'allow-once' | 'allow-always' | 'reject' | 'cancel' | 'expired' | 'stale' | 'unavailable';
}

export interface ProjectCommand {
  readonly schemaVersion: SchemaVersion;
  readonly commandId: StableId;
  readonly documentId: StableId;
  readonly baseRevision: number;
  readonly label: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface TransformSnapshot {
  readonly position: readonly [number, number, number];
  readonly rotationDegrees: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

export interface SceneEntitySnapshot {
  readonly id: StableId;
  readonly name: string;
  readonly primitive: 'empty' | 'cube';
  readonly parentId: StableId | null;
  readonly transform: TransformSnapshot;
  readonly scriptId: StableId | null;
}

export interface SceneSnapshot {
  readonly schemaVersion: SchemaVersion;
  readonly documentId: StableId;
  readonly revision: number;
  readonly coordinateSystem: 'right-handed-y-up';
  readonly entities: readonly SceneEntitySnapshot[];
}

export interface ScriptResourceSnapshot {
  readonly schemaVersion: SchemaVersion;
  readonly id: StableId;
  readonly name: string;
  readonly language: 'typescript';
  readonly source: string;
  readonly digest: string;
  readonly validation: 'unknown' | 'valid' | 'invalid';
}

export interface ProjectDocumentSnapshot {
  readonly schemaVersion: SchemaVersion;
  readonly id: StableId;
  readonly revision: number;
  readonly savedRevision: number;
  readonly dirty: boolean;
  readonly scene: SceneSnapshot;
  readonly scripts: readonly ScriptResourceSnapshot[];
}

export interface OperationLogQuery {
  readonly schemaVersion: SchemaVersion;
  readonly sessionId?: StableId;
  readonly turnId?: StableId;
  readonly toolCallId?: StableId;
  readonly entityId?: StableId;
  readonly pluginId?: StableId;
  readonly severity?: readonly DurableEventEnvelope['severity'][];
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly limit: number;
  readonly traverseCorrelation: boolean;
}

export interface IpcMessage {
  readonly schemaVersion: SchemaVersion;
  readonly direction: 'request' | 'response' | 'notification';
  readonly channel: string;
  readonly id?: StableId;
  readonly correlationId: StableId;
  readonly payload: Readonly<Record<string, JsonValue>>;
}
