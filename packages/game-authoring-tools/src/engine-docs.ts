import { GameToolProtocolError } from './types.js';
import { sha256 } from '@haiyue/ai-studio-operation-log';
import { tokenize } from '@haiyue/ai-studio-agent-runtime';
import type { JsonObject, JsonValue } from '@haiyue/ai-studio-contracts';

export type EngineDocSurface = 'studio-script' | 'authoring' | 'engine-native';
export interface EngineDocEntry {
  readonly id: string; readonly title: string; readonly surface: EngineDocSurface;
  readonly source: string; readonly summary: string; readonly keywords: string;
  readonly capabilityIds: readonly string[]; readonly blocks: readonly string[]; readonly relatedIds: readonly string[]; readonly digest: string;
}
export interface EngineDocBundle {
  readonly schemaVersion: 1; readonly digest: string;
  readonly binding: Readonly<{ engineVersion: string; engineIntegrity: string; scriptContractDigest: string; guidesDigest: string }>;
  readonly entries: readonly EngineDocEntry[];
}
export interface EngineDocumentation {
  search(input: JsonObject): JsonObject;
  read(input: JsonObject): JsonObject;
}
const surfaces = ['studio-script', 'authoring', 'engine-native'];
const digest = (value: unknown) => `sha256:${sha256(JSON.stringify(value))}`;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function fail(code: string, message: string): never { throw new GameToolProtocolError(code, message, code === 'engine.docs.stale'); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function bounded(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max; }
function budget(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('engine.docs.invalid', `Expected integer in ${min}..${max}.`);
  return value as number;
}

/** Immutable local corpus; callers cannot supply paths or choose another installed version. */
export class EngineDocumentationStore implements EngineDocumentation {
  readonly bundle: EngineDocBundle;
  private readonly byId: ReadonlyMap<string, EngineDocEntry>;
  private readonly index: readonly { entry: EngineDocEntry; terms: ReadonlySet<string>; titleTerms: ReadonlySet<string> }[];
  constructor(value: unknown, expected?: EngineDocBundle['binding']) {
    if (!record(value) || value.schemaVersion !== 1 || !record(value.binding) || !Array.isArray(value.entries) || value.entries.length > 40_000) fail('engine.docs.bundle-invalid', 'Invalid documentation bundle.');
    const binding = value.binding;
    for (const key of ['engineVersion', 'engineIntegrity', 'scriptContractDigest', 'guidesDigest']) if (!bounded(binding[key], 256)) fail('engine.docs.binding-invalid', 'Documentation binding is missing.');
    if (expected && Object.entries(expected).some(([key, expectedValue]) => binding[key] !== expectedValue)) fail('engine.docs.version-mismatch', 'Documentation does not match the installed Engine and Studio script contract.');
    const ids = new Set<string>();
    for (const entry of value.entries) {
      if (!record(entry) || !bounded(entry.id, 100) || !/^doc:[a-f0-9]{24}$/.test(entry.id) || ids.has(entry.id)
        || !bounded(entry.title, 512) || !surfaces.includes(entry.surface as string) || !bounded(entry.source, 1024)
        || !bounded(entry.summary, 1024) || typeof entry.keywords !== 'string' || entry.keywords.length > 2048
        || !Array.isArray(entry.capabilityIds) || entry.capabilityIds.length > 64 || entry.capabilityIds.some(id => !bounded(id, 160))
        || !Array.isArray(entry.blocks) || !entry.blocks.length || entry.blocks.length > 512 || entry.blocks.some(block => !bounded(block, 24_000))
        || !Array.isArray(entry.relatedIds) || entry.relatedIds.length > 128 || entry.relatedIds.some(id => typeof id !== 'string')
        || entry.digest !== digest(entry.blocks)) fail('engine.docs.entry-invalid', 'Documentation entry or content digest is invalid.');
      ids.add(entry.id);
    }
    if (value.entries.some(entry => entry.relatedIds.some((id: string) => !ids.has(id)))) fail('engine.docs.link-invalid', 'Documentation contains an unresolved link.');
    if (value.digest !== digest({ binding: value.binding, entries: value.entries })) fail('engine.docs.digest-mismatch', 'Documentation corpus digest is invalid.');
    this.bundle = JSON.parse(JSON.stringify(value)) as EngineDocBundle;
    for (const entry of this.bundle.entries) { Object.freeze(entry.capabilityIds); Object.freeze(entry.blocks); Object.freeze(entry.relatedIds); Object.freeze(entry); }
    Object.freeze(this.bundle.binding); Object.freeze(this.bundle.entries); Object.freeze(this.bundle);
    this.byId = new Map(this.bundle.entries.map(entry => [entry.id, entry]));
    this.index = this.bundle.entries.map(entry => ({ entry, titleTerms: new Set(tokenize(`${entry.title} ${entry.keywords}`)), terms: new Set(tokenize(`${entry.title} ${entry.keywords} ${entry.summary} ${entry.blocks.join('\n')}`)) }));
  }
  search(input: JsonObject): JsonObject {
    if (!bounded(input.query, 2048) || !input.query.trim() || (input.surface !== undefined && ![...surfaces, 'all'].includes(input.surface as string))) fail('engine.docs.invalid', 'Use a short query and a supported surface.');
    const limit = budget(input.limit, 6, 1, 12); const maxBytes = budget(input.maxBytes, 4096, 1024, 16_384);
    const query = input.query.trim().toLowerCase(); const terms = new Set(tokenize(query));
    const ranked = this.index.filter(({ entry }) => input.surface === 'all' || (input.surface ? entry.surface === input.surface : entry.surface !== 'engine-native')).map(({ entry, titleTerms, terms: content }) => {
      let score = entry.title.toLowerCase() === query ? 100 : entry.title.toLowerCase().includes(query) ? 20 : 0;
      for (const term of terms) score += titleTerms.has(term) ? 3 : content.has(term) ? 0.25 : 0;
      return { entry, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    const result: Record<string, JsonValue> = { bundleDigest: this.bundle.digest, binding: this.bundle.binding, surface: input.surface ?? 'studio-script+authoring', matches: [], candidateCount: ranked.length, truncated: false };
    const matches: JsonObject[] = [];
    for (const { entry } of ranked) {
      const match = { id: entry.id, title: entry.title, surface: entry.surface, summary: entry.summary, source: entry.source, contentDigest: entry.digest, nextTool: 'engine.docs.read' };
      if (matches.length >= limit || bytes({ ...result, matches: [...matches, match] }) > maxBytes) break;
      matches.push(match);
    }
    result.matches = matches; result.truncated = matches.length < ranked.length;
    if (!matches.length && ranked.length) result.diagnostic = 'Matching documentation exceeded maxBytes; increase the search budget.';
    if (!ranked.length) result.diagnostic = 'No matching documentation in this surface; search tool.search or explicitly inspect engine-native. Absence is not proof of unsupported Engine functionality.';
    return result;
  }
  read(input: JsonObject): JsonObject {
    if (!bounded(input.id, 100) || input.bundleDigest !== this.bundle.digest) fail('engine.docs.stale', 'Search again to obtain the current documentation id and bundleDigest.');
    const entry = this.byId.get(input.id);
    if (!entry) fail('engine.docs.not-found', 'Unknown documentation id.');
    const maxBytes = budget(input.maxBytes, 16_384, 1024, 32_768);
    let offset = 0;
    if (input.cursor !== undefined) {
      if (!bounded(input.cursor, 512)) fail('engine.docs.cursor-invalid', 'Invalid documentation cursor.');
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { fail('engine.docs.cursor-invalid', 'Invalid documentation cursor.'); }
      if (!record(cursor) || cursor.digest !== this.bundle.digest || cursor.id !== entry.id || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0 || (cursor.offset as number) >= entry.blocks.length) fail('engine.docs.cursor-invalid', 'Cursor does not identify this document revision.');
      offset = cursor.offset as number;
    }
    const related = entry.relatedIds.map(id => { const related = this.byId.get(id)!; return { id, title: related.title, surface: related.surface }; });
    const result: Record<string, JsonValue> = { id: entry.id, title: entry.title, surface: entry.surface, source: entry.source, contentDigest: entry.digest, bundleDigest: this.bundle.digest, binding: this.bundle.binding, blocks: [], nextCursor: null, related: related.slice(0, 8), relatedCount: related.length };
    const blocks: string[] = [];
    while (offset + blocks.length < entry.blocks.length) {
      const next = entry.blocks[offset + blocks.length]!;
      const nextOffset = offset + blocks.length + 1;
      const nextCursor = nextOffset < entry.blocks.length ? Buffer.from(JSON.stringify({ digest: this.bundle.digest, id: entry.id, offset: nextOffset })).toString('base64url') : null;
      const proposed = { ...result, blocks: [...blocks, next], nextCursor };
      if (bytes(proposed) > maxBytes) {
        if (!blocks.length) fail('engine.docs.budget-too-small', `A complete documentation block needs ${bytes(proposed)} bytes; increase maxBytes (maximum 32768).`);
        break;
      }
      blocks.push(next); result.nextCursor = nextCursor;
    }
    result.blocks = blocks;
    return result;
  }
}
