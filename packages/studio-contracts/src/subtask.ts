import type { JsonObject } from './index.js';

/** Selection of already approved, independent plan items; no model-supplied authority. */
export interface SubtaskSelectionV1 { readonly schemaVersion: 1; readonly taskIds: readonly string[]; }
/** Candidate only: never an executable editor command or acceptance evidence. */
export interface SubtaskCandidateV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly baseRevision: number;
  readonly artifacts: readonly Readonly<{ key: string; kind: 'proposal' | 'patch' | 'test'; content: string; sources: readonly string[] }>[];
}
const id = { type: 'string', minLength: 3, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]+$' };
const ref = { type: 'string', minLength: 1, maxLength: 512 };
export const SUBTASK_SELECTION_SCHEMA = { type: 'object', additionalProperties: false, required: ['schemaVersion', 'taskIds'], properties: {
  schemaVersion: { const: 1 }, taskIds: { type: 'array', minItems: 2, maxItems: 4, uniqueItems: true, items: id },
} } as JsonObject;
export const SUBTASK_CANDIDATE_SCHEMA = { type: 'object', additionalProperties: false, required: ['schemaVersion', 'taskId', 'baseRevision', 'artifacts'], properties: {
  schemaVersion: { const: 1 }, taskId: id, baseRevision: { type: 'integer', minimum: 0 }, artifacts: { type: 'array', minItems: 1, maxItems: 8, items: {
    type: 'object', additionalProperties: false, required: ['key', 'kind', 'content', 'sources'], properties: {
      key: ref, kind: { enum: ['proposal', 'patch', 'test'] }, content: { type: 'string', minLength: 1, maxLength: 8192 },
      sources: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: ref },
    },
  } },
} } as JsonObject;
export function isSubtaskSelectionV1(v: unknown): v is SubtaskSelectionV1 {
  return object(v, ['schemaVersion', 'taskIds']) && v.schemaVersion === 1 && Array.isArray(v.taskIds)
    && v.taskIds.length >= 2 && v.taskIds.length <= 4 && new Set(v.taskIds).size === v.taskIds.length && v.taskIds.every(stable);
}
export function isSubtaskCandidateV1(v: unknown): v is SubtaskCandidateV1 {
  return object(v, ['schemaVersion', 'taskId', 'baseRevision', 'artifacts']) && v.schemaVersion === 1 && stable(v.taskId)
    && Number.isSafeInteger(v.baseRevision) && Number(v.baseRevision) >= 0 && Array.isArray(v.artifacts) && v.artifacts.length >= 1 && v.artifacts.length <= 8
    && v.artifacts.every(a => object(a, ['key', 'kind', 'content', 'sources']) && text(a.key, 512) && ['proposal', 'patch', 'test'].includes(String(a.kind))
      && text(a.content, 8192) && Array.isArray(a.sources) && a.sources.length >= 1 && a.sources.length <= 20 && new Set(a.sources).size === a.sources.length && a.sources.every(s => text(s, 512)));
}
function object(v: unknown, keys: string[]): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)); }
function stable(v: unknown): boolean { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(v); }
function text(v: unknown, max: number): boolean { return typeof v === 'string' && v.length > 0 && v.length <= max; }
