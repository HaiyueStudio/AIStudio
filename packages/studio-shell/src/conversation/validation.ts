import { asStableId, type JsonObject, type JsonValue, type M12ReasoningEffort, type StableId, type TaskBudgetV2 } from '@haiyue/ai-studio-contracts';
import {
  CONVERSATION_NODE_KINDS,
  type ApprovalCardReadModel,
  type ConversationBackendReadModel,
  type ConversationIntent,
  type ConversationNodeKind,
  type ConversationNodeReadModel,
  type ConversationNodeStatus,
  type ConversationProvenance,
  type PlanItemReadModel,
  type QuestionCardReadModel,
  type SafeLogSummary,
  isJsonValue,
} from './types.js';

export const MAX_CONVERSATION_CONTENT_BYTES = 16 * 1024;
export const MAX_PRESENTATION_TEXT = 4_096;
const statuses = new Set<ConversationNodeStatus>(['pending', 'streaming', 'completed', 'failed', 'cancelled']);
const knownKinds = new Set<string>(CONVERSATION_NODE_KINDS);
const secretKey = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|password|credential|private[-_]?key|secret)/i;
const bearerLike = /\b(?:bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})\b/gi;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export class ConversationReadModelError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ConversationReadModelError'; }
}

export function normalizeConversationNode(value: unknown): ConversationNodeReadModel {
  if (!isRecord(value)) throw new ConversationReadModelError('conversation.node-invalid', 'Conversation node must be an object.');
  const id = stable(value.id, 'node id');
  const kind = boundedString(value.kind, 'node kind', 64);
  const knownKind = knownKinds.has(kind) ? kind as ConversationNodeKind : null;
  const status = statuses.has(value.status as ConversationNodeStatus) ? value.status as ConversationNodeStatus : 'failed';
  const createdAt = timestamp(value.createdAt, 'createdAt');
  const provenance = normalizeProvenance(value.provenance);
  if (!isRecord(value.content)) throw new ConversationReadModelError('conversation.content-invalid', 'Conversation content must be an object.');
  const serialized = safeStringify(value.content);
  const oversized = utf8Bytes(serialized) > MAX_CONVERSATION_CONTENT_BYTES;
  const content = !knownKind
    ? Object.freeze({ summary: 'This conversation item is not supported by this Studio version.', originalKind: safeText(kind, 64) })
    : oversized
      ? Object.freeze({ summary: `Payload omitted because it exceeds ${MAX_CONVERSATION_CONTENT_BYTES} bytes.` })
      : normalizeContent(knownKind, value.content);
  return Object.freeze({ schemaVersion: 1, id, kind, knownKind, status, createdAt, provenance, content, payloadTruncated: oversized });
}

export function normalizeBackend(value: unknown): ConversationBackendReadModel {
  if (!isRecord(value)) throw new ConversationReadModelError('conversation.backend-invalid', 'Backend read model must be an object.');
  const kind = value.kind;
  const state = value.state;
  const authMode = value.authMode;
  if (kind !== 'harness-api-key' && kind !== 'codex-app-server') throw new ConversationReadModelError('conversation.backend-invalid', 'Backend kind is invalid.');
  if (!['ready', 'auth-required', 'authenticating', 'unavailable', 'error'].includes(String(state))) throw new ConversationReadModelError('conversation.backend-invalid', 'Backend state is invalid.');
  if (!['api-key', 'chatgpt', 'none'].includes(String(authMode))) throw new ConversationReadModelError('conversation.backend-invalid', 'Backend auth mode is invalid.');
  const rateLimits = Array.isArray(value.rateLimits) ? value.rateLimits.slice(0, 8).map(normalizeRateLimit) : [];
  const diagnostic = isRecord(value.diagnostic) && typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string'
    ? Object.freeze({ code: safeText(value.diagnostic.code, 96), message: safeText(value.diagnostic.message, 512) }) : undefined;
  const models = Array.isArray(value.models) ? value.models.slice(0, 64).flatMap((item) => normalizeModel(item)) : [];
  const selectedModel = typeof value.selectedModel === 'string' && models.some((item) => item.id === value.selectedModel) ? safeText(value.selectedModel, 128) : null;
  const selectedReasoningEffort = reasoningEffort(value.selectedReasoningEffort);
  const outputTokenLimit = safeInteger(value.outputTokenLimit, 1, 1_000_000);
  return Object.freeze({
    id: stable(value.id, 'backend id'), label: safeText(typeof value.label === 'string' ? value.label : String(kind), 80), kind,
    state: state as ConversationBackendReadModel['state'], authMode: authMode as ConversationBackendReadModel['authMode'],
    ...(typeof value.accountPlan === 'string' ? { accountPlan: safeText(value.accountPlan, 80) } : {}),
    rateLimits: Object.freeze(rateLimits), ...(diagnostic ? { diagnostic } : {}), models: Object.freeze(models), selectedModel, selectedReasoningEffort, outputTokenLimit,
  });
}

export function normalizeTaskAccounting(value: unknown): import('./types.js').ConversationTaskAccountingReadModel | null {
  if (!isRecord(value) || !isRecord(value.budget) || !isRecord(value.usage) || !isRecord(value.cost)) return null;
  try {
    const budget = normalizeBudget(value.budget);
    const status = ['within', 'soft-exceeded', 'hard-exceeded'].includes(String(value.budgetStatus)) ? value.budgetStatus as 'within' | 'soft-exceeded' | 'hard-exceeded' : 'within';
    const countOrNull = (item: unknown): number | null => item === null ? null : safeInteger(item, 0, 1_000_000_000);
    return Object.freeze({ taskId: stable(value.taskId, 'task id'), budget, budgetStatus: status,
      usage: Object.freeze({ inputTokens: countOrNull(value.usage.inputTokens), cachedInputTokens: countOrNull(value.usage.cachedInputTokens), outputTokens: countOrNull(value.usage.outputTokens), reasoningTokens: countOrNull(value.usage.reasoningTokens), toolInputBytes: safeInteger(value.usage.toolInputBytes, 0, 1_000_000_000) ?? 0, toolOutputBytes: safeInteger(value.usage.toolOutputBytes, 0, 1_000_000_000) ?? 0, wallTimeMs: safeInteger(value.usage.wallTimeMs, 0, 86_400_000) ?? 0 }),
      cost: Object.freeze({ status: ['actual', 'estimated', 'unknown'].includes(String(value.cost.status)) ? value.cost.status as 'actual' | 'estimated' | 'unknown' : 'unknown', amountMicros: countOrNull(value.cost.amountMicros), currency: typeof value.cost.currency === 'string' ? safeText(value.cost.currency, 3) : null, cacheSavingMicros: countOrNull(value.cost.cacheSavingMicros), explanation: safeText(typeof value.cost.explanation === 'string' ? value.cost.explanation : 'Cost is unknown.', 512), final: value.cost.final === true }),
    });
  } catch { return null; }
}

export function approvalFromNode(node: ConversationNodeReadModel): ApprovalCardReadModel | null {
  if (node.knownKind !== 'approval') return null;
  const content = node.content as Record<string, unknown>;
  if (!isApprovalContent(content)) return null;
  return content as unknown as ApprovalCardReadModel;
}

export function questionFromNode(node: ConversationNodeReadModel): QuestionCardReadModel | null {
  if (node.knownKind !== 'question') return null;
  const value = node.content as Record<string, unknown>;
  if (typeof value.prompt !== 'string' || !Array.isArray(value.options)) return null;
  return value as unknown as QuestionCardReadModel;
}

export function planFromNode(node: ConversationNodeReadModel): readonly PlanItemReadModel[] {
  if (node.knownKind !== 'plan') return [];
  const items = (node.content as Record<string, unknown>).items;
  return Array.isArray(items) ? items as unknown as readonly PlanItemReadModel[] : [];
}

export function normalizeSafeLogSummary(value: unknown): SafeLogSummary {
  if (!isRecord(value) || !Number.isInteger(value.sequence) || (value.sequence as number) < 0) throw new ConversationReadModelError('logs.summary-invalid', 'Log summary sequence is invalid.');
  if (!['debug', 'info', 'warning', 'error'].includes(String(value.severity))) throw new ConversationReadModelError('logs.summary-invalid', 'Log summary severity is invalid.');
  if (!digestPattern.test(String(value.payloadDigest))) throw new ConversationReadModelError('logs.summary-invalid', 'Log summary digest is invalid.');
  const correlation: Record<string, StableId> = {};
  if (isRecord(value.correlation)) for (const [key, item] of Object.entries(value.correlation)) {
    if (secretKey.test(key)) continue;
    try { correlation[safeText(key, 64)] = stable(item, `correlation ${key}`); } catch { /* unknown correlation values stay hidden */ }
  }
  return Object.freeze({
    sequence: value.sequence as number, eventId: stable(value.eventId, 'event id'), timestamp: timestamp(value.timestamp, 'timestamp'),
    kind: safeText(String(value.kind), 96), severity: value.severity as SafeLogSummary['severity'], source: stable(value.source, 'source'),
    correlation: Object.freeze(correlation), payloadDigest: String(value.payloadDigest),
    redactedFieldCount: Number.isInteger(value.redactedFieldCount) && (value.redactedFieldCount as number) >= 0 ? value.redactedFieldCount as number : 0,
  });
}

export function safeText(value: string, maximum = MAX_PRESENTATION_TEXT): string {
  return value.replace(bearerLike, '[REDACTED]').slice(0, maximum);
}

export function validateConversationIntent(value: unknown): ConversationIntent {
  if (!isRecord(value) || typeof value.type !== 'string') throw new ConversationReadModelError('conversation.intent-invalid', 'Conversation intent must be an object with a type.');
  const type = value.type;
  switch (type) {
    case 'conversation/send': {
      exactKeys(value, ['type', 'backendId', 'prompt']);
      const prompt = boundedString(value.prompt, 'prompt', 16 * 1024).trim();
      if (!prompt || utf8Bytes(prompt) > 16 * 1024) throw new ConversationReadModelError('conversation.intent-invalid', 'Prompt is empty or over budget.');
      return Object.freeze({ type, backendId: stable(value.backendId, 'backend id'), prompt });
    }
    case 'conversation/cancel': case 'conversation/retry':
      exactKeys(value, ['type', 'backendId', 'sessionId', 'turnId']);
      return Object.freeze({ type, backendId: stable(value.backendId, 'backend id'), sessionId: stable(value.sessionId, 'session id'), turnId: stable(value.turnId, 'turn id') });
    case 'conversation/reconnect': exactKeys(value, ['type']); return Object.freeze({ type });
    case 'conversation/answer-question':
      exactKeys(value, ['type', 'nodeId', 'answer']);
      if (!isRecord(value.answer) || !isJsonValue(value.answer)) throw new ConversationReadModelError('conversation.intent-invalid', 'Question answer is invalid.');
      return Object.freeze({ type, nodeId: stable(value.nodeId, 'node id'), answer: Object.freeze(value.answer) as JsonObject });
    case 'conversation/accept-plan': {
      exactKeys(value, ['type', 'nodeId', 'acceptedItemIds', 'mode', 'note'], ['mode', 'note']);
      if (!Array.isArray(value.acceptedItemIds) || value.acceptedItemIds.length > 50) throw new ConversationReadModelError('conversation.intent-invalid', 'Accepted plan items are invalid.');
      if (value.mode !== undefined && value.mode !== 'approve' && value.mode !== 'revise') throw new ConversationReadModelError('conversation.intent-invalid', 'Plan decision is invalid.');
      const acceptedItemIds = Object.freeze(value.acceptedItemIds.map((item) => stable(item, 'plan item id')));
      return Object.freeze({ type, nodeId: stable(value.nodeId, 'node id'), acceptedItemIds, ...(value.mode ? { mode: value.mode } : {}), ...(typeof value.note === 'string' && value.note.trim() ? { note: safeText(value.note.trim(), 2_048) } : {}) });
    }
    case 'conversation/resolve-approval':
      exactKeys(value, ['type', 'approvalId', 'decision']);
      if (value.decision !== 'allow-once' && value.decision !== 'allow-always' && value.decision !== 'reject') throw new ConversationReadModelError('conversation.intent-invalid', 'Approval decision is invalid.');
      return Object.freeze({ type, approvalId: stable(value.approvalId, 'approval id'), decision: value.decision });
    case 'backend/select': case 'backend/authenticate': case 'backend/logout':
      exactKeys(value, ['type', 'backendId']); return Object.freeze({ type, backendId: stable(value.backendId, 'backend id') });
    case 'agent/configure': {
      exactKeys(value, ['type', 'backendId', 'model', 'reasoningEffort', 'outputTokenLimit', 'budget']);
      const effort = reasoningEffort(value.reasoningEffort); if (!effort) throw new ConversationReadModelError('conversation.intent-invalid', 'Reasoning effort is invalid.');
      const outputTokenLimit = safeInteger(value.outputTokenLimit, 1, 1_000_000); if (outputTokenLimit === null) throw new ConversationReadModelError('conversation.intent-invalid', 'Output token limit is invalid.');
      return Object.freeze({ type, backendId: stable(value.backendId, 'backend id'), model: boundedString(value.model, 'model', 128), reasoningEffort: effort, outputTokenLimit, budget: normalizeBudget(value.budget) });
    }
    case 'logs/export-bug-bundle':
      exactKeys(value, ['type', 'query']);
      return Object.freeze({ type, query: validateLogQuery(value.query) });
    default: throw new ConversationReadModelError('conversation.intent-invalid', `Unknown conversation intent ${safeText(type, 96)}.`);
  }
}

function validateLogQuery(value: unknown): import('./types.js').LogQueryIntent {
  if (!isRecord(value)) throw new ConversationReadModelError('conversation.intent-invalid', 'Log query must be an object.');
  exactKeys(value, ['severity', 'kinds', 'sessionId', 'turnId', 'toolCallId', 'entityId', 'pluginId', 'afterSequence', 'beforeSequence', 'limit', 'traverseCorrelation', 'cursor'], ['severity', 'kinds', 'sessionId', 'turnId', 'toolCallId', 'entityId', 'pluginId', 'afterSequence', 'beforeSequence', 'cursor']);
  if (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 200 || typeof value.traverseCorrelation !== 'boolean') throw new ConversationReadModelError('conversation.intent-invalid', 'Log query budget is invalid.');
  const severity = value.severity === undefined ? undefined : arrayOfEnum(value.severity, ['debug', 'info', 'warning', 'error'], 4);
  const kinds = value.kinds === undefined ? undefined : arrayOfStrings(value.kinds, 32, 96).filter((item) => /^[a-z][a-z0-9./-]{2,95}$/.test(item));
  return Object.freeze({
    ...(severity?.length ? { severity } : {}), ...(kinds?.length ? { kinds } : {}),
    ...intentOptionalId('sessionId', value.sessionId), ...intentOptionalId('turnId', value.turnId), ...intentOptionalId('toolCallId', value.toolCallId),
    ...intentOptionalId('entityId', value.entityId), ...intentOptionalId('pluginId', value.pluginId),
    ...sequenceField('afterSequence', value.afterSequence), ...sequenceField('beforeSequence', value.beforeSequence),
    limit: value.limit as number, traverseCorrelation: value.traverseCorrelation,
    ...(typeof value.cursor === 'string' && value.cursor.length <= 2_048 ? { cursor: value.cursor } : {}),
  });
}

function normalizeContent(kind: ConversationNodeKind, value: Record<string, unknown>): JsonObject {
  switch (kind) {
    case 'text': return compact({ text: text(value.text ?? value.delta, MAX_PRESENTATION_TEXT), role: enumValue(value.role, ['user', 'assistant', 'system']) });
    case 'progress': return compact({ label: text(value.label, 160), message: text(value.message, 1_024), current: finite(value.current), total: finite(value.total) });
    case 'question': return normalizeQuestion(value);
    case 'plan': return normalizePlan(value);
    case 'tool-call': return compact({ toolCallId: stableOptional(value.toolCallId), toolId: text(value.toolId, 128), target: text(value.target, 256), effect: enumValue(value.effect, ['observe', 'reversible-edit', 'trusted-code', 'runtime-start']), argumentsSummary: text(value.argumentsSummary, 2_048) });
    case 'tool-result': return compact({ toolCallId: stableOptional(value.toolCallId), toolId: text(value.toolId, 128), summary: text(value.summary, 2_048), details: text(value.details, 4_096), resultStatus: enumValue(value.resultStatus ?? value.status, ['completed', 'failed', 'cancelled']) });
    case 'approval': return normalizeApproval(value);
    case 'diagnostic': return compact({ code: text(value.code, 96), message: text(value.message, 2_048), severity: enumValue(value.severity, ['info', 'warning', 'error']), retryable: typeof value.retryable === 'boolean' ? value.retryable : undefined });
    case 'completion': return compact({ summary: text(value.summary, 2_048), terminalStatus: enumValue(value.terminalStatus ?? value.status, ['completed', 'failed', 'cancelled', 'interrupted']) });
  }
}

function normalizeQuestion(value: Record<string, unknown>): JsonObject {
  const options = Array.isArray(value.options) ? value.options.slice(0, 20).flatMap((item) => {
    if (!isRecord(item)) return [];
    try { return [Object.freeze({ id: stable(item.id, 'question option id'), label: text(item.label, 160) ?? 'Option', ...(typeof item.description === 'string' ? { description: safeText(item.description, 512) } : {}) })]; }
    catch { return []; }
  }) : [];
  return Object.freeze({ prompt: text(value.prompt, 2_048) ?? 'The Agent needs more information.', options: Object.freeze(options), allowFreeform: value.allowFreeform === true, multiple: value.multiple === true });
}

function normalizePlan(value: Record<string, unknown>): JsonObject {
  const items = Array.isArray(value.items) ? value.items.slice(0, 50).flatMap((item) => {
    if (!isRecord(item)) return [];
    try { return [Object.freeze({ id: stable(item.id, 'plan item id'), label: text(item.label, 240) ?? 'Plan item', ...(typeof item.details === 'string' ? { details: safeText(item.details, 1_024) } : {}), status: enumValue(item.status, ['pending', 'accepted', 'rejected', 'completed']) ?? 'pending' })]; }
    catch { return []; }
  }) : [];
  return compact({
    title: text(value.title, 240) ?? 'Proposed plan',
    summary: text(value.summary, 2_048),
    decision: enumValue(value.decision, ['approved', 'revision-requested']),
    note: text(value.note, 2_048),
    items: Object.freeze(items) as unknown as JsonValue,
  });
}

function normalizeApproval(value: Record<string, unknown>): JsonObject {
  const effect = enumValue(value.effect, ['reversible-edit', 'trusted-code', 'runtime-start']);
  const risk = enumValue(value.risk, ['medium', 'high']);
  const decision = enumValue(value.decision, ['pending', 'allow-once', 'allow-always', 'reject', 'cancel', 'expired', 'stale', 'unavailable']);
  if (!effect || !risk || !decision) return Object.freeze({ summary: 'Invalid approval payload; actions are disabled.', decision: 'unavailable' });
  try {
    const argsDigest = digest(value.argsDigest);
    const previewDigest = digest(value.previewDigest);
    return Object.freeze({
      approvalId: stable(value.approvalId, 'approval id'), toolCallId: stable(value.toolCallId, 'tool call id'),
      toolId: text(value.toolId, 128) ?? 'unknown', toolVersion: text(value.toolVersion, 32) ?? 'unknown',
      target: text(value.target, 256) ?? 'Unknown target', effect, risk,
      argumentsSummary: text(value.argumentsSummary, 2_048) ?? 'No argument summary provided.', previewDiff: text(value.previewDiff, 4_096) ?? 'No preview diff provided.',
      baseRevision: Number.isInteger(value.baseRevision) && (value.baseRevision as number) >= 0 ? value.baseRevision as number : 0,
      argsDigest, previewDigest, decision,
    });
  } catch { return Object.freeze({ summary: 'Invalid approval payload; actions are disabled.', decision: 'unavailable' }); }
}

function normalizeProvenance(value: unknown): ConversationProvenance {
  if (!isRecord(value)) throw new ConversationReadModelError('conversation.provenance-invalid', 'Conversation provenance is missing.');
  return Object.freeze({ backendId: stable(value.backendId, 'backend id'), sessionId: stable(value.sessionId, 'session id'), turnId: stable(value.turnId, 'turn id'), ...(value.stepId === undefined ? {} : { stepId: stable(value.stepId, 'step id') }) });
}

function normalizeRateLimit(value: unknown): Readonly<{ name: string; usedPercent?: number; resetsAt?: string }> {
  if (!isRecord(value)) return Object.freeze({ name: 'unknown' });
  const usedPercent = typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent) ? Math.max(0, Math.min(100, value.usedPercent)) : undefined;
  return Object.freeze({ name: safeText(typeof value.name === 'string' ? value.name : 'unknown', 80), ...(usedPercent === undefined ? {} : { usedPercent }), ...(typeof value.resetsAt === 'string' ? { resetsAt: safeText(value.resetsAt, 80) } : {}) });
}

function normalizeModel(value: unknown): readonly ConversationBackendReadModel['models'][number][] {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string' || !Array.isArray(value.reasoningEfforts)) return [];
  const efforts = Object.freeze(value.reasoningEfforts.flatMap((item) => { const effort = reasoningEffort(item); return effort ? [effort] : []; }).slice(0, 8));
  const defaultEffort = reasoningEffort(value.defaultReasoningEffort);
  const maximum = safeInteger(value.maxOutputTokens, 1, 1_000_000);
  if (!efforts.length || !defaultEffort || !efforts.includes(defaultEffort) || maximum === null) return [];
  return [Object.freeze({ id: safeText(value.id, 128), label: safeText(value.label, 128), reasoningEfforts: efforts, defaultReasoningEffort: defaultEffort, maxOutputTokens: maximum, isDefault: value.isDefault === true })];
}

function normalizeBudget(value: unknown): TaskBudgetV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.limits) || !['observe', 'soft', 'hard'].includes(String(value.enforcement))) throw new ConversationReadModelError('conversation.budget-invalid', 'Task budget is invalid.');
  const limits = value.limits;
  const nullable = (key: string): number | null => { const item = limits[key]; if (item === null) return null; const result = safeInteger(item, key === 'repairIterations' ? 0 : 1, 1_000_000_000); if (result === null) throw new ConversationReadModelError('conversation.budget-invalid', `Budget ${key} is invalid.`); return result; };
  const required = (key: string): number => { const result = nullable(key); if (result === null) throw new ConversationReadModelError('conversation.budget-invalid', `Budget ${key} cannot be null.`); return result; };
  return Object.freeze({ schemaVersion: 2, id: stable(value.id, 'budget id'), enforcement: value.enforcement as TaskBudgetV2['enforcement'], limits: Object.freeze({
    inputTokens: nullable('inputTokens'), outputTokens: nullable('outputTokens'), estimatedCostMicros: nullable('estimatedCostMicros'), wallTimeMs: required('wallTimeMs'), turns: required('turns'), toolCalls: required('toolCalls'), repairIterations: required('repairIterations'), observationBytes: required('observationBytes'),
  }) });
}

function reasoningEffort(value: unknown): M12ReasoningEffort | null { return ['backend-default', 'off', 'low', 'medium', 'high', 'xhigh'].includes(String(value)) ? value as M12ReasoningEffort : null; }
function safeInteger(value: unknown, minimum: number, maximum: number): number | null { return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum ? value as number : null; }

function isApprovalContent(value: Record<string, unknown>): boolean {
  return typeof value.approvalId === 'string' && typeof value.toolCallId === 'string' && typeof value.toolId === 'string'
    && value.decision !== 'unavailable' && typeof value.argsDigest === 'string';
}

function stable(value: unknown, label: string): StableId {
  if (typeof value !== 'string') throw new ConversationReadModelError('conversation.id-invalid', `${label} is invalid.`);
  try { return asStableId(value, label); } catch { throw new ConversationReadModelError('conversation.id-invalid', `${label} is invalid.`); }
}
function stableOptional(value: unknown): StableId | undefined { try { return value === undefined ? undefined : stable(value, 'id'); } catch { return undefined; } }
function timestamp(value: unknown, label: string): string { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ConversationReadModelError('conversation.timestamp-invalid', `${label} is invalid.`); return value; }
function boundedString(value: unknown, label: string, maximum: number): string { if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new ConversationReadModelError('conversation.string-invalid', `${label} is invalid.`); return safeText(value, maximum); }
function text(value: unknown, maximum: number): string | undefined { return typeof value === 'string' ? safeText(value, maximum) : undefined; }
function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function digest(value: unknown): string { if (typeof value !== 'string' || !digestPattern.test(value)) throw new ConversationReadModelError('conversation.digest-invalid', 'Digest is invalid.'); return value; }
function enumValue<const T extends string>(value: unknown, allowed: readonly T[]): T | undefined { return typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined; }
function compact(value: Record<string, JsonValue | undefined>): JsonObject { return Object.freeze(Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as Record<string, JsonValue>); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function safeStringify(value: unknown): string { try { return JSON.stringify(value); } catch { return ''; } }
function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || allowed.some((key) => !optional.includes(key) && !(key in value))) throw new ConversationReadModelError('conversation.intent-invalid', 'Intent contains missing or unknown fields.');
}
function arrayOfEnum<const T extends string>(value: unknown, allowed: readonly T[], maximum: number): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string' || !allowed.includes(item as T))) throw new ConversationReadModelError('conversation.intent-invalid', 'Intent enum list is invalid.');
  return Object.freeze([...new Set(value as T[])]);
}
function arrayOfStrings(value: unknown, maximum: number, length: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string' || item.length > length)) throw new ConversationReadModelError('conversation.intent-invalid', 'Intent string list is invalid.');
  return Object.freeze([...new Set(value.map((item) => safeText(item, length)))]);
}
function intentOptionalId<K extends 'sessionId' | 'turnId' | 'toolCallId' | 'entityId' | 'pluginId'>(key: K, value: unknown): Partial<Record<K, StableId>> { return value === undefined ? {} : { [key]: stable(value, key) } as Record<K, StableId>; }
function sequenceField<K extends 'afterSequence' | 'beforeSequence'>(key: K, value: unknown): Partial<Record<K, number>> { if (value === undefined) return {}; if (!Number.isInteger(value) || (value as number) < 0) throw new ConversationReadModelError('conversation.intent-invalid', `${key} is invalid.`); return { [key]: value as number } as Record<K, number>; }
