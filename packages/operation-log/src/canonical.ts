import { createHash } from 'node:crypto';
import type { JsonValue } from '@haiyue/ai-studio-contracts';

export function canonicalStringify(value: JsonValue | Readonly<Record<string, unknown>>): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Operation Log accepts only finite JSON numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Operation Log accepts only plain JSON objects and arrays.');
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value as object).sort()) {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined) throw new TypeError(`Operation Log cannot persist undefined at ${key}.`);
    result[key] = sortValue(member);
  }
  return result;
}
