import type { JsonObject } from '@haiyue/ai-studio-contracts';
import { isSupportedEvidenceAssertion, unavailablePlayEvidenceSignal } from '@haiyue/ai-studio-game-authoring-tools';
import { isRecord } from './value-utils.js';

const types = ['state', 'event-trace', 'runtime-errors', 'performance', 'screenshot', 'visual-analysis', 'lifecycle'];
/** Input convenience only: approved TaskSpec assertions retain their existing DSL. */
export const STRUCTURED_ASSERTION_SCHEMA: JsonObject = {
  type: 'object', additionalProperties: false, required: ['type', 'signal', 'operator', 'expected'],
  properties: {
    type: { enum: types }, signal: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,160}$' },
    operator: { enum: ['equals', 'gte', 'lte'] }, expected: {},
  },
};
export function structuredAssertion(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).some(k => !['type', 'signal', 'operator', 'expected'].includes(k)) ||
      typeof value.type !== 'string' || !types.includes(value.type) || typeof value.signal !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/u.test(value.signal) ||
      typeof value.operator !== 'string' || !['equals', 'gte', 'lte'].includes(value.operator) || !Object.hasOwn(value, 'expected') || !isJsonExpected(value.expected)) return null;
  try {
    const expected = JSON.stringify(value.expected);
    if (expected === undefined) return null;
    const text = `evidence ${value.type} signal ${value.signal} ${value.operator} ${expected}`;
    return text.length <= 2000 && isSupportedEvidenceAssertion(text) ? text : null;
  } catch { return null; }
}

/** Only unambiguous notation repairs, before approval. Never invent a field,
 * operator, expected value, or turn a missing predicate into a presence check. */
export function repairAssertionNotation(value: string): string {
  if (isSupportedEvidenceAssertion(value)) return value;
  const match = /^(evidence\s+[a-z-]+\s+signal\s+[A-Za-z0-9_.-]+)\s+(equals|gte|lte|==|>=|<=)\s+([\s\S]+)$/u.exec(value);
  if (!match) return value;
  const operator = ({ '==': 'equals', '>=': 'gte', '<=': 'lte' } as Record<string, string>)[match[2]!] ?? match[2]!;
  const source = match[3]!;
  let quoted = false, escaped = false, repaired = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) { repaired += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    if (c === ',' && !/[\[{,:]\s*$/u.test(source.slice(0, i)) && /^\s*[}\]]/u.test(source.slice(i + 1))) continue;
    repaired += c;
  }
  try {
    const candidate = `${match[1]} ${operator} ${JSON.stringify(JSON.parse(repaired))}`;
    return isSupportedEvidenceAssertion(candidate) ? candidate : value;
  } catch { return value; }
}

export function assertionCorrectionDetail(assertion: string): string {
  const match = /^evidence\s+([a-z-]+)\s+signal\s+([A-Za-z0-9_.-]+)(?:\s+([\s\S]*))?$/u.exec(assertion);
  if (!match) return 'Use a structured assertion object with type, signal, operator and expected, or a complete evidence DSL string.';
  const path = match[2]!;
  const tail = match[3]?.trim();
  const missing = !tail ? 'Missing operator and expected value.' : /^(equals|gte|lte)$/u.test(tail) ? 'Missing expected value.' : 'Invalid operator or JSON expected value; strings need JSON double quotes.';
  // Probe only the field catalogue, without accepting or modifying this predicate.
  const unavailable = unavailablePlayEvidenceSignal(`evidence ${match[1]} signal ${path} equals null`);
  const field = path === 'effects.unchangedEntityIds'
    ? 'effects.unchangedEntityIds does not exist. unchangedEntityIds belongs to play.pointer-gesture expect input, not effects output. Verify unchanged objects using their actual baseline/final state values; preserve the intended objects and requirement.'
    : unavailable;
  return `${missing}${field ? ` ${field}` : ''} Return the complete corrected plan using {type, signal, operator, expected}; do not guess defaults or remove this criterion.`;
}


function isJsonExpected(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 32 || ancestors.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const valid = Object.values(descriptors).every(d => 'value' in d) &&
    (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(item => isJsonExpected(item, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}
