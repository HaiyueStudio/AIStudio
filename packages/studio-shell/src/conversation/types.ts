import type { JsonObject, JsonValue, M12ReasoningEffort, StableId, StudioDisposable, TaskBudgetV2 } from '@haiyue/ai-studio-contracts';

export const CONVERSATION_NODE_KINDS = Object.freeze([
  'text', 'progress', 'question', 'plan', 'tool-call', 'tool-result', 'approval', 'diagnostic', 'completion',
] as const);

export type ConversationNodeKind = typeof CONVERSATION_NODE_KINDS[number];
export type ConversationNodeStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface ConversationProvenance {
  readonly backendId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly stepId?: StableId;
}

export interface ConversationNodeReadModel {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly kind: string;
  readonly knownKind: ConversationNodeKind | null;
  readonly status: ConversationNodeStatus;
  readonly createdAt: string;
  readonly provenance: ConversationProvenance;
  readonly content: JsonObject;
  readonly payloadTruncated: boolean;
}

export interface ConversationProjectionEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly source: 'live' | 'replay';
  readonly node: unknown;
}

export interface PendingConversationInteraction {
  readonly nodeId: StableId;
  readonly kind: 'question' | 'plan' | 'approval';
}

export interface ConversationBackendReadModel {
  readonly id: StableId;
  readonly label: string;
  readonly kind: 'harness-api-key' | 'codex-app-server';
  readonly state: 'ready' | 'auth-required' | 'authenticating' | 'unavailable' | 'error';
  readonly authMode: 'api-key' | 'chatgpt' | 'none';
  readonly accountPlan?: string;
  readonly rateLimits: readonly Readonly<{ name: string; usedPercent?: number; resetsAt?: string }>[];
  readonly diagnostic?: Readonly<{ code: string; message: string }>;
  readonly models: readonly Readonly<{ id: string; label: string; reasoningEfforts: readonly M12ReasoningEffort[]; defaultReasoningEffort: M12ReasoningEffort; maxOutputTokens: number; isDefault: boolean }>[];
  readonly selectedModel: string | null;
  readonly selectedReasoningEffort: M12ReasoningEffort | null;
  readonly outputTokenLimit: number | null;
}

export interface ConversationTaskAccountingReadModel {
  readonly taskId: StableId;
  readonly budget: TaskBudgetV2;
  readonly budgetStatus: 'within' | 'soft-exceeded' | 'hard-exceeded';
  readonly usage: Readonly<{ inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; toolInputBytes: number; toolOutputBytes: number; wallTimeMs: number; contextCache?: Readonly<{ localArtifactHits: number; localArtifactMisses: number; deltaReuseBytes: number; providerCacheEligibleBytes: number; providerReportedHitTokens: number | null }> }>;
  readonly cost: Readonly<{ status: 'actual' | 'estimated' | 'unknown'; amountMicros: number | null; currency: string | null; cacheSavingMicros: number | null; explanation: string; final: boolean }>;
}

export interface ConversationReadModel {
  readonly revision: number;
  readonly lastSequence: number;
  readonly connection: 'connected' | 'reconnecting' | 'disconnected';
  readonly busy: boolean;
  readonly backendId: StableId | null;
  readonly backends: readonly ConversationBackendReadModel[];
  readonly taskAccounting: ConversationTaskAccountingReadModel | null;
  readonly nodes: readonly ConversationNodeReadModel[];
  readonly pendingInteraction: PendingConversationInteraction | null;
  readonly composerBlockedReason: string | null;
}

export interface ConversationReplaySnapshot {
  readonly revision: number;
  readonly connection: ConversationReadModel['connection'];
  readonly busy: boolean;
  readonly backendId: StableId | null;
  readonly backends: readonly unknown[];
  readonly taskAccounting?: unknown;
  readonly events: readonly ConversationProjectionEvent[];
}

export type ConversationIntent =
  | Readonly<{ type: 'conversation/send'; backendId: StableId; prompt: string }>
  | Readonly<{ type: 'conversation/cancel'; backendId: StableId; sessionId: StableId; turnId: StableId }>
  | Readonly<{ type: 'conversation/retry'; backendId: StableId; sessionId: StableId; turnId: StableId }>
  | Readonly<{ type: 'conversation/reconnect' }>
  | Readonly<{ type: 'conversation/answer-question'; nodeId: StableId; answer: JsonObject }>
  | Readonly<{ type: 'conversation/accept-plan'; nodeId: StableId; acceptedItemIds: readonly StableId[]; mode?: 'approve' | 'revise'; note?: string }>
  | Readonly<{ type: 'conversation/resolve-approval'; approvalId: StableId; decision: 'allow-once' | 'allow-always' | 'reject' }>
  | Readonly<{ type: 'backend/select'; backendId: StableId }>
  | Readonly<{ type: 'backend/authenticate'; backendId: StableId }>
  | Readonly<{ type: 'backend/logout'; backendId: StableId }>
  | Readonly<{ type: 'agent/configure'; backendId: StableId; model: string; reasoningEffort: M12ReasoningEffort; outputTokenLimit: number; budget: TaskBudgetV2 }>
  | Readonly<{ type: 'logs/export-bug-bundle'; query: LogQueryIntent }>;

export interface ConversationUiPort {
  replay(signal: AbortSignal): Promise<ConversationReplaySnapshot>;
  subscribe(listener: (event: ConversationUiEvent) => void): StudioDisposable;
  dispatch(intent: ConversationIntent, signal: AbortSignal): Promise<void>;
}

export type ConversationUiEvent =
  | Readonly<{ type: 'conversation/event'; event: ConversationProjectionEvent }>
  | Readonly<{ type: 'conversation/state'; revision: number; connection: ConversationReadModel['connection']; busy: boolean; backendId: StableId | null; backends: readonly unknown[]; taskAccounting?: unknown }>;

export interface LogQueryIntent {
  readonly severity?: readonly ('debug' | 'info' | 'warning' | 'error')[];
  readonly kinds?: readonly string[];
  readonly sessionId?: StableId;
  readonly turnId?: StableId;
  readonly toolCallId?: StableId;
  readonly entityId?: StableId;
  readonly pluginId?: StableId;
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly limit: number;
  readonly traverseCorrelation: boolean;
  readonly cursor?: string;
}

export interface SafeLogSummary {
  readonly sequence: number;
  readonly eventId: StableId;
  readonly timestamp: string;
  readonly kind: string;
  readonly severity: 'debug' | 'info' | 'warning' | 'error';
  readonly source: StableId;
  readonly correlation: Readonly<Record<string, StableId>>;
  readonly payloadDigest: string;
  readonly redactedFieldCount: number;
}

export interface SafeLogPage {
  readonly events: readonly unknown[];
  readonly nextCursor?: string;
  readonly status: Readonly<{ health: string; canPersist: boolean; diagnostics: readonly unknown[] }>;
}

export interface LogViewerPort {
  query(query: LogQueryIntent, signal: AbortSignal): Promise<SafeLogPage>;
  copyText(text: string, signal: AbortSignal): Promise<void>;
  dispatch(intent: Extract<ConversationIntent, { type: 'logs/export-bug-bundle' }>, signal: AbortSignal): Promise<void>;
}

export interface PlanItemReadModel {
  readonly id: StableId;
  readonly label: string;
  readonly details?: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'completed';
}

export interface ApprovalCardReadModel {
  readonly approvalId: StableId;
  readonly toolCallId: StableId;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly target: string;
  readonly effect: 'reversible-edit' | 'trusted-code' | 'runtime-start';
  readonly risk: 'medium' | 'high';
  readonly argumentsSummary: string;
  readonly previewDiff: string;
  readonly baseRevision: number;
  readonly argsDigest: string;
  readonly previewDigest: string;
  readonly expiresAt?: string;
  readonly scope: 'operation' | 'project-session';
  readonly decision: 'pending' | 'allow-once' | 'allow-always' | 'reject' | 'cancel' | 'expired' | 'stale' | 'unavailable';
}

export interface QuestionCardReadModel {
  readonly prompt: string;
  readonly options: readonly Readonly<{ id: StableId; label: string; description?: string }>[];
  readonly allowFreeform: boolean;
  readonly multiple: boolean;
}

export interface ChatCardAction {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly intent?: ConversationIntent;
}

export interface ChatCardReadModel {
  readonly id: StableId;
  readonly kind: string;
  readonly status: ConversationNodeStatus;
  readonly title: string;
  readonly body: string;
  readonly details?: Readonly<{ summary: string; body: string }>;
  readonly tone: 'neutral' | 'progress' | 'success' | 'warning' | 'danger';
  readonly provenance: ConversationProvenance;
  readonly metadata: readonly Readonly<{ label: string; value: string }>[];
  readonly actions: readonly ChatCardAction[];
  readonly planItems?: readonly PlanItemReadModel[];
  readonly question?: QuestionCardReadModel;
  readonly approval?: ApprovalCardReadModel;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value) && typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue);
}
