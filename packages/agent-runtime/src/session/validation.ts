import type {
  BackendSessionBindingV1,
  JsonObject,
  JsonValue,
  M13StableId,
  SessionCheckpointV1,
  SessionOpKindV1,
  SessionOpV1,
  SurfaceOpV1,
} from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256, type DurableOperationEvent } from '@haiyue/ai-studio-operation-log';
import { AgentSessionError } from './error.js';

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const opKeys = new Set(['schemaVersion', 'id', 'sessionId', 'sequence', 'kind', 'timestamp', 'turnId', 'stepId', 'batchId', 'nodeId', 'parentOpId', 'dependsOn', 'projectRevision', 'artifactRefs', 'payload', 'payloadDigest']);
const sessionOpKinds = new Set<SessionOpKindV1>([
  'session.created', 'session.status-changed', 'session.checkpointed',
  'turn.started', 'turn.completed', 'user.message', 'assistant.message',
  'tool-batch.planned', 'tool-batch.started', 'tool-batch.completed',
  'tool.started', 'tool.completed', 'tool.outcome-unknown',
  'approval.requested', 'approval.resolved', 'question.requested', 'question.resolved',
  'document.committed', 'evidence.captured', 'evaluation.completed',
  'compaction.requested', 'compaction.started', 'compaction.summary-created',
  'compaction.completed', 'compaction.failed', 'backend.bound', 'backend.detached',
]);

export function parsePersistedSessionOp(event: DurableOperationEvent, expectedSessionId: M13StableId): SessionOpV1 {
  if (event.kind !== 'agent/session-op' || event.source !== 'studio.agent-session') {
    throw new AgentSessionError('session.version-unsupported', `Unknown Studio Session event ${event.kind}.`);
  }
  const raw = event.payload.sessionOp;
  const op = validateSessionOp(raw);
  if (op.sessionId !== expectedSessionId || event.correlation.sessionId !== expectedSessionId) throw new AgentSessionError('session.coordinate-mismatch', 'Session event correlation does not match its payload.');
  if (event.eventId !== op.id) throw new AgentSessionError('session.op-id-mismatch', `Operation ${op.id} does not match durable event ${event.eventId}.`);
  if (!sameStrings(event.artifactRefs, op.artifactRefs)) throw new AgentSessionError('session.artifact-reference-mismatch', `Operation ${op.id} artifact references drifted.`);
  return op;
}

export function validateSessionOp(value: unknown): SessionOpV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || Object.keys(value).some((key) => !opKeys.has(key))) throw new AgentSessionError('session.version-unsupported', 'Session operation schema/version is unsupported.');
  if (!isStableId(value.id) || !isStableId(value.sessionId) || !isNonNegativeInteger(value.sequence) || !sessionOpKinds.has(value.kind as SessionOpKindV1) || !isTimestamp(value.timestamp)) throw new AgentSessionError('session.op-invalid', 'Session operation identity, sequence, kind or timestamp is invalid.');
  for (const key of ['turnId', 'stepId', 'batchId', 'nodeId', 'parentOpId'] as const) if (value[key] !== null && !isStableId(value[key])) throw new AgentSessionError('session.op-invalid', `Session operation ${key} is invalid.`);
  if (!isUniqueStableIdArray(value.dependsOn, 256) || !isUniqueStableIdArray(value.artifactRefs, 256) || (value.projectRevision !== null && !isNonNegativeInteger(value.projectRevision)) || !isJsonObject(value.payload) || !isDigest(value.payloadDigest)) throw new AgentSessionError('session.op-invalid', 'Session operation payload or references are invalid.');
  const actualPayloadDigest = digestJson(value.payload);
  if (actualPayloadDigest !== value.payloadDigest) throw new AgentSessionError('session.op-digest-mismatch', `Session operation ${value.id} payload digest is invalid.`);
  return deepFreeze(value) as unknown as SessionOpV1;
}

export function validateSurfaceOperation(value: unknown): SurfaceOpV1 {
  if (!isRecord(value) || !isStableId(value.id) || !isUniqueStableIdArray(value.sourceOpIds, 16_384) || value.sourceOpIds.length === 0) throw new AgentSessionError('surface.operation-invalid', 'Surface operation identity or source operations are invalid.');
  if (value.op === 'append') {
    if (!hasOnlyKeys(value, ['op', 'id', 'sourceOpIds', 'messageArtifactId', 'role']) || !isStableId(value.messageArtifactId) || !['user', 'assistant', 'tool'].includes(String(value.role))) throw new AgentSessionError('surface.operation-invalid', 'Surface append operation is invalid.');
    return deepFreeze(value) as unknown as SurfaceOpV1;
  }
  if (value.op === 'replace') {
    if (!hasOnlyKeys(value, ['op', 'id', 'sourceOpIds', 'startNodeId', 'endNodeId', 'replacementArtifactId', 'reason']) || !isStableId(value.startNodeId) || !isStableId(value.endNodeId) || !isStableId(value.replacementArtifactId) || !['compaction', 'tool-result-prune'].includes(String(value.reason))) throw new AgentSessionError('surface.operation-invalid', 'Surface replace operation is invalid.');
    return deepFreeze(value) as unknown as SurfaceOpV1;
  }
  throw new AgentSessionError('surface.operation-invalid', 'Unknown Surface operation.');
}

export function validateBackendBinding(value: unknown): BackendSessionBindingV1 {
  const keys = ['bindingId', 'backendId', 'provider', 'model', 'remoteSessionId', 'generation', 'status', 'capabilities', 'lastConfirmedOpId'];
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isStableId(value.bindingId) || !isStableId(value.backendId) || typeof value.provider !== 'string' || value.provider.length === 0 || value.provider.length > 128 || typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 256 || (value.remoteSessionId !== null && !isStableId(value.remoteSessionId)) || !isNonNegativeInteger(value.generation) || !['active', 'stale', 'detached'].includes(String(value.status)) || (value.lastConfirmedOpId !== null && !isStableId(value.lastConfirmedOpId))) throw new AgentSessionError('session.backend-binding-invalid', 'Backend Session binding is invalid.');
  const capabilities = value.capabilities;
  if (!isRecord(capabilities) || !hasOnlyKeys(capabilities, ['maxInputTokens', 'nativeCompaction', 'parallelToolCalls', 'codeMode', 'providerUsage', 'providerCache']) || (capabilities.maxInputTokens !== null && (!isNonNegativeInteger(capabilities.maxInputTokens) || capabilities.maxInputTokens < 1024)) || typeof capabilities.nativeCompaction !== 'boolean' || typeof capabilities.parallelToolCalls !== 'boolean' || typeof capabilities.codeMode !== 'boolean' || !['reported', 'unavailable', 'unknown'].includes(String(capabilities.providerUsage)) || !['reported', 'unavailable', 'unknown'].includes(String(capabilities.providerCache))) throw new AgentSessionError('session.backend-binding-invalid', 'Backend Session capabilities are invalid.');
  return deepFreeze(value) as unknown as BackendSessionBindingV1;
}

export function validateCheckpoint(value: unknown, sessionId: M13StableId): SessionCheckpointV1 {
  const keys = ['id', 'sessionId', 'throughSequence', 'turnId', 'batchId', 'documentRevision', 'surfaceGeneration', 'unresolvedBarrierIds', 'digest', 'createdAt'];
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isStableId(value.id) || value.sessionId !== sessionId || !isNonNegativeInteger(value.throughSequence) || (value.turnId !== null && !isStableId(value.turnId)) || (value.batchId !== null && !isStableId(value.batchId)) || (value.documentRevision !== null && !isNonNegativeInteger(value.documentRevision)) || !isNonNegativeInteger(value.surfaceGeneration) || !isUniqueStableIdArray(value.unresolvedBarrierIds, 256) || !isDigest(value.digest) || !isTimestamp(value.createdAt)) throw new AgentSessionError('session.checkpoint-invalid', 'Session checkpoint is invalid.');
  return deepFreeze(value) as unknown as SessionCheckpointV1;
}

export function digestJson(value: JsonValue | Readonly<Record<string, unknown>>): `sha256:${string}` {
  return `sha256:${sha256(canonicalStringify(value))}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
export function isStableId(value: unknown): value is M13StableId { return typeof value === 'string' && stableIdPattern.test(value); }
export function isDigest(value: unknown): value is `sha256:${string}` { return typeof value === 'string' && digestPattern.test(value); }
export function isTimestamp(value: unknown): value is string { return typeof value === 'string' && timestampPattern.test(value) && !Number.isNaN(Date.parse(value)); }
export function isNonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
export function isJsonObject(value: unknown): value is JsonObject { return isRecord(value) && isJsonValue(value); }
export function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 16_384 && value.every(isJsonValue);
  return isRecord(value) && Object.keys(value).length <= 4096 && Object.values(value).every(isJsonValue);
}
function isUniqueStableIdArray(value: unknown, max: number): value is M13StableId[] { return Array.isArray(value) && value.length <= max && value.every(isStableId) && new Set(value).size === value.length; }
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { const set = new Set(allowed); return Object.keys(value).every((key) => set.has(key)) && allowed.every((key) => key in value); }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
