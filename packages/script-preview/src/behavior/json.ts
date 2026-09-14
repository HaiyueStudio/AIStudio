const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

export class BehaviorContractError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BehaviorContractError'; }
}
const secretKey = /^(api[-_]?key|(?:access|refresh|oauth|auth|id)[-_]?token|authorization|cookie|password|client[-_]?secret|credentials?(?:[-_]?path)?)$/i;
const secretText = /(?:\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[-_]?key|(?:access|refresh|oauth)[-_]?token|password|client[-_]?secret)\s*[:=]\s*["']?[^\s"',;]{8,}|[/\\](?:\.codex[/\\]auth\.json|\.ssh[/\\]|\.aws[/\\]credentials))/i;

/** Validate descriptors before reading values; no getters, cycles, binary or live objects. */
export function checkedJson(input: unknown, maxBytes = 8 * 1024 * 1024): unknown {
  const seen = new Set<object>();
  let bytes = 0;
  const addBytes = (size: number) => { bytes += size; if (bytes > maxBytes) throw new BehaviorContractError('behavior.byte-budget'); };
  function walk(value: unknown, depth: number): unknown {
    if (depth > 128) throw new BehaviorContractError('behavior.depth-budget');
    if (value === null || typeof value === 'boolean') { addBytes(value === false ? 5 : 4); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new BehaviorContractError('behavior.non-json');
      addBytes(utf8Bytes(JSON.stringify(value))); return value;
    }
    if (typeof value === 'string') {
      addBytes(utf8Bytes(JSON.stringify(value)));
      if (secretText.test(value)) throw new BehaviorContractError('behavior.secret');
      return value;
    }
    if (typeof value !== 'object' || !value || seen.has(value)) throw new BehaviorContractError('behavior.non-json');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new BehaviorContractError('behavior.non-json');
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entryCount = Object.keys(descriptors).length - (Array.isArray(value) ? 1 : 0);
    addBytes(2 + Math.max(0, entryCount - 1));
    if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) throw new BehaviorContractError('behavior.non-json');
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    if (Array.isArray(value) && (value.length > 100_000 || Object.keys(value).length !== value.length)) throw new BehaviorContractError('behavior.non-json');
    for (const key of Object.keys(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) throw new BehaviorContractError('behavior.non-json');
      const descriptor = descriptors[key];
      // `prototype` is also a legitimate JSON data field (assembly source bindings).
      // These values are copied as own data properties, never traversed as object paths.
      // Reject accessors and prototype-pollution entry points, not ordinary field names.
      if (!('value' in descriptor) || !descriptor.enumerable || secretKey.test(key) || key === '__proto__' || key === 'constructor') throw new BehaviorContractError('behavior.secret-or-accessor');
      if (!Array.isArray(value)) addBytes(utf8Bytes(JSON.stringify(key)) + 1);
      const member = walk(descriptor.value, depth + 1);
      if (key === 'prototype') Object.defineProperty(result, key, { value: member, enumerable: true, writable: true, configurable: true });
      else (result as Record<string, unknown>)[key] = member;
    }
    seen.delete(value);
    return result;
  }
  const result = walk(input, 0);
  if (utf8Bytes(canonicalJson(result)) > maxBytes) throw new BehaviorContractError('behavior.byte-budget');
  return result;
}
/** Call only on validated JSON. Object keys sort by UTF-16, arrays retain semantic order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function freezeProjection<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeProjection); Object.freeze(value); }
  return value;
}
