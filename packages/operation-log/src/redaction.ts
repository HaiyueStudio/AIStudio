import type { JsonObject, JsonValue } from '@haiyue/ai-studio-contracts';
import type { RedactionPolicy } from './types.js';

const forbiddenKey = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|proxy[-_]?authorization|cookie|password|passwd|client[-_]?secret|credential|private[-_]?key|secret)/i;
const forbiddenContent = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|SECRET_CANARY|CODEX_TOKEN_CANARY|API_KEY_CANARY)/i;
const hiddenReasoningKey = /(?:chain[-_]?of[-_]?thought|hidden[-_]?reasoning|private[-_]?reasoning)/i;

export interface RedactionResult<T extends JsonValue = JsonValue> {
  readonly value: T;
  readonly redactedFields: readonly string[];
}

export function redactJson<T extends JsonValue>(value: T, policy: RedactionPolicy = {}): RedactionResult<T> {
  const explicit = new Set([...(policy.fields ?? []), ...(policy.taintedFields ?? [])].map(normalizePointer));
  const redacted = new Set<string>();

  const visit = (current: JsonValue, pointer: string, key?: string): JsonValue => {
    if (explicit.has(pointer) || (key !== undefined && (forbiddenKey.test(key) || hiddenReasoningKey.test(key)))) {
      redacted.add(pointer || '/');
      return '[REDACTED]';
    }
    if (typeof current === 'string' && forbiddenContent.test(current)) {
      redacted.add(pointer || '/');
      return '[REDACTED]';
    }
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${pointer}/${index}`));
    if (current && typeof current === 'object') {
      const result: Record<string, JsonValue> = {};
      for (const [memberKey, member] of Object.entries(current)) {
        const child = `${pointer}/${escapePointer(memberKey)}`;
        result[memberKey] = visit(member, child, memberKey);
      }
      return result;
    }
    return current;
  };

  return Object.freeze({
    value: visit(value, '') as T,
    redactedFields: Object.freeze([...redacted].sort()),
  });
}

export function redactObject(value: JsonObject, policy: RedactionPolicy = {}): RedactionResult<JsonObject> {
  return redactJson(value, policy);
}

export function assertNoHiddenReasoningKind(kind: string): void {
  if (/chain[-_/]?of[-_/]?thought|hidden[-_/]?reasoning/i.test(kind)) {
    throw new OperationLogPolicyError('hidden-reasoning-forbidden', 'Hidden chain-of-thought must not be persisted.');
  }
}

export class OperationLogPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OperationLogPolicyError';
  }
}

function normalizePointer(pointer: string): string {
  if (!pointer.startsWith('/') || pointer.includes('..')) {
    throw new OperationLogPolicyError('invalid-redaction-path', `Redaction field must be an absolute JSON pointer: ${pointer}`);
  }
  return pointer;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
