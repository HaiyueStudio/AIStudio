import type { JsonValue } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, redactJson, sha256 } from '@haiyue/ai-studio-operation-log';

export class ResourceCatalogError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ResourceCatalogError'; }
}
export function fail(code: string): never { throw new ResourceCatalogError(`resource.${code}`); }
export const digest = (value: unknown): `sha256:${string}` => `sha256:${sha256(canonicalStringify(value as JsonValue))}`;
export const equal = (a: unknown, b: unknown): boolean => canonicalStringify(a as JsonValue) === canonicalStringify(b as JsonValue);
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}
export function checked(value: unknown, maxBytes = 256 * 1024): JsonValue {
  let remaining = 50_000;
  const visit = (input: unknown, depth: number): JsonValue => {
    if (--remaining < 0 || depth > 48) fail('input-budget');
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object') return fail('input-invalid');
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) fail('input-invalid');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.values(descriptors).some(item => !('value' in item))) fail('input-invalid');
    if (Array.isArray(input)) {
      if (input.length > 50_000 || Object.keys(input).length !== input.length) fail('input-budget');
      return input.map(item => visit(item, depth + 1));
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('input-invalid');
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('input-budget');
  return result;
}
export const record = (value: unknown): value is Record<string, JsonValue> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, JsonValue> {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return fail('input-invalid');
  return value;
}
export function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return fail('input-invalid');
  return value;
}
export function id(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(result)) fail('input-invalid');
  return result;
}
export function publicValue<T extends JsonValue>(value: T): T { return freeze(redactJson(value).value as T); }
export function publicText(value: string): string { return String(publicValue(value)).slice(0, 256); }
