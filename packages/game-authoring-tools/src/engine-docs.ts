import { randomUUID } from 'node:crypto';
import { QUERY_PAGE_SIZE } from './query-limits.js';
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
  private readonly searchResults = new Map<string, Readonly<{ bundleDigest: string; ids: readonly string[]; searchInput: JsonObject; nextCursor: string | null }>>();
  private readonly searchNamespace = randomUUID().replaceAll('-', '').slice(0, 16);
  private searchSequence = 0;
  private readonly byReference = new Map<string, EngineDocEntry>();
  private readonly referenceFor = new Map<string, string>();
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
    for (const entry of this.bundle.entries) {
      const ref = `dref:${sha256(`${this.bundle.digest}:${entry.id}`).slice(0, 16)}`;
      if (this.byReference.has(ref)) fail('engine.docs.reference-collision', 'Documentation reference collision.');
      this.byReference.set(ref, entry); this.referenceFor.set(entry.id, ref);
    }
    this.byId = new Map(this.bundle.entries.map(entry => [entry.id, entry]));
    this.index = this.bundle.entries.map(entry => ({ entry, titleTerms: new Set(tokenize(`${entry.title} ${entry.keywords}`)), terms: new Set(tokenize(`${entry.title} ${entry.keywords} ${entry.summary} ${entry.blocks.join('\n')}`)) }));
  }
  search(input: JsonObject): JsonObject {
    if (input.continueFrom !== undefined) {
      if (typeof input.continueFrom !== 'string' || !/^sref:[a-f0-9]{16}:[1-9][0-9]*$/.test(input.continueFrom) || Object.keys(input).some(key => !['continueFrom', 'maxBytes'].includes(key))) fail('engine.docs.selection-invalid', 'For another page, use only the returned nextCall.arguments: {continueFrom: resultRef}, plus optional maxBytes. Studio restores query, surface, limit and cursor; do not supply them or requested.');
      const previous = this.searchResults.get(input.continueFrom);
      if (!previous) fail('engine.docs.search-result-unavailable', 'The search page expired or belongs to another application instance. Start a new search with {query:"API or feature name"}.');
      if (!previous.nextCursor) fail('engine.docs.page-unavailable', 'This search page has no next page. Read one of its matches or start a new query.');
      input = { ...previous.searchInput, cursor: previous.nextCursor, ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }) };
    }
    if (!bounded(input.query, 2048) || !input.query.trim() || (input.surface !== undefined && ![...surfaces, 'all'].includes(input.surface as string))) fail('engine.docs.invalid', 'Use a short query and a supported surface.');
    const limit = budget(input.limit, 6, 1, QUERY_PAGE_SIZE); const maxBytes = budget(input.maxBytes, 4096, 1024, 16_384);
    const query = input.query.trim().toLowerCase(); const terms = new Set(tokenize(query));
    const ranked = this.index.filter(({ entry }) => input.surface === 'all' || (input.surface ? entry.surface === input.surface : entry.surface !== 'engine-native')).map(({ entry, titleTerms, terms: content }) => {
      let score = entry.title.toLowerCase() === query ? 100 : entry.title.toLowerCase().includes(query) ? 20 : 0;
      for (const term of terms) score += titleTerms.has(term) ? 3 : content.has(term) ? 0.25 : 0;
      return { entry, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    let offset = 0;
    const queryBinding = digest({ query, surface: input.surface ?? null, limit });
    if (input.cursor !== undefined) {
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString('utf8')); } catch { fail('engine.docs.cursor-invalid', 'Use the exact nextCursor from this search.'); }
      if (!record(cursor) || cursor.digest !== this.bundle.digest || cursor.query !== queryBinding || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0 || (cursor.offset as number) >= ranked.length) fail('engine.docs.cursor-invalid', 'Repeat the search without cursor, or keep query, surface and limit unchanged.');
      offset = cursor.offset as number;
    }
    const resultRef = `sref:${this.searchNamespace}:${++this.searchSequence}`;
    const nextCall = { toolId: 'engine.docs.search', arguments: { continueFrom: resultRef } };
    const result: Record<string, JsonValue> = { resultRef, readHint: 'Read an exact returned row with {fromSearch:{resultRef,index}}. Studio copies its id and version from this stored JSON; do not retype them. index is zero-based within this page.', nextCall: null, nextCursor: null, requestedCount: limit, bundleDigest: this.bundle.digest, binding: this.bundle.binding, surface: input.surface ?? 'studio-script+authoring', matches: [], candidateCount: ranked.length, truncated: false };
    const matches: JsonObject[] = [];
    for (const { entry } of ranked.slice(offset, offset + limit)) {
      const match = { index: matches.length, ref: this.referenceFor.get(entry.id)!, id: entry.id, title: entry.title, surface: entry.surface, summary: entry.summary, source: entry.source, contentDigest: entry.digest, nextTool: 'engine.docs.read' };
      const nextOffset = offset + matches.length + 1;
      const nextCursor = nextOffset < ranked.length ? Buffer.from(JSON.stringify({ digest: this.bundle.digest, query: queryBinding, offset: nextOffset })).toString('base64url') : null;
      if (bytes({ ...result, matches: [...matches, match], nextCursor, nextCall: nextCursor ? nextCall : null }) > maxBytes) break;
      matches.push(match); result.nextCursor = nextCursor; result.nextCall = nextCursor ? nextCall : null;
    }
    result.matches = matches; result.truncated = offset + matches.length < ranked.length;
    if (!matches.length && ranked.length) result.diagnostic = 'Matching documentation exceeded maxBytes; increase the search budget.';
    if (!ranked.length) result.diagnostic = 'No matching documentation in this surface; search tool.search or explicitly inspect engine-native. Absence is not proof of unsupported Engine functionality.';
    this.searchResults.set(resultRef, Object.freeze({ bundleDigest: this.bundle.digest, ids: Object.freeze(matches.map(match => match.id as string)), searchInput: Object.freeze({ query: input.query, ...(input.surface === undefined ? {} : { surface: input.surface }), limit, maxBytes }), nextCursor: result.nextCursor as string | null }));
    // Bounded to the latest 128 returned pages. Expired handles never resolve to another page.
    while (this.searchResults.size > 128) this.searchResults.delete(this.searchResults.keys().next().value!);
    return result;
  }
  read(input: JsonObject): JsonObject {
    const fromSearch = input.fromSearch;
    if (fromSearch !== undefined) {
      if (!record(fromSearch) || Object.keys(fromSearch).some(key => !['resultRef', 'index'].includes(key)) || typeof fromSearch.resultRef !== 'string' || !/^sref:[a-f0-9]{16}:[1-9][0-9]*$/.test(fromSearch.resultRef) || !Number.isSafeInteger(fromSearch.index) || (fromSearch.index as number) < 0 || input.id !== undefined || input.ref !== undefined || input.bundleDigest !== undefined) fail('engine.docs.selection-invalid', 'Use only {fromSearch:{resultRef:search.resultRef,index:match.index}} plus optional cursor/maxBytes. Do not provide id, ref or bundleDigest as well.');
      const result = this.searchResults.get(fromSearch.resultRef);
      if (!result) fail('engine.docs.search-result-unavailable', 'The selected search page expired or belongs to another application instance. Search again, then select its resultRef and index.');
      const id = result.ids[fromSearch.index as number];
      if (!id) fail('engine.docs.selection-invalid', `The selected index is outside this search page. Use a returned matches[].index (0 to ${result.ids.length - 1}).`);
      // Identity comes exclusively from the immutable server-owned response, never from model text.
      input = { ...input, id, bundleDigest: result.bundleDigest };
    }
    let entry: EngineDocEntry | undefined;
    if (input.ref !== undefined) {
      if (typeof input.ref !== 'string' || !/^dref:[a-f0-9]{16}$/.test(input.ref) || input.id !== undefined || input.bundleDigest !== undefined) fail('engine.docs.reference-invalid', 'Pass {ref: match.ref} from engine.docs.search; do not combine ref with id or bundleDigest.');
      entry = this.byReference.get(input.ref);
      if (!entry) fail('engine.docs.reference-unavailable', 'This reference is unavailable in the installed documentation. Search again and copy matches[].ref exactly.');
    } else {
      if (typeof input.id !== 'string' || !/^doc:[a-f0-9]{24}$/.test(input.id) || typeof input.bundleDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.bundleDigest)) fail('engine.docs.reference-invalid', 'Malformed document id or bundleDigest. Prefer {ref: match.ref} from engine.docs.search; placeholders and shortened digests are not valid.');
      if (input.bundleDigest !== this.bundle.digest) fail('engine.docs.stale', 'bundleDigest does not match the installed documentation; it may have been copied incorrectly. Search again and use matches[].ref.');
      entry = this.byId.get(input.id);
      if (!entry) fail('engine.docs.not-found', 'Unknown document id. Search again and use an exact matches[].ref; do not invent ids.');
    }
    const maxBytes = budget(input.maxBytes, 16_384, 1024, 32_768);
    let offset = 0;
    if (input.cursor !== undefined) {
      if (!bounded(input.cursor, 512)) fail('engine.docs.cursor-invalid', 'Invalid documentation cursor.');
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { fail('engine.docs.cursor-invalid', 'Invalid documentation cursor.'); }
      if (!record(cursor) || cursor.digest !== this.bundle.digest || cursor.id !== entry.id || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0 || (cursor.offset as number) >= entry.blocks.length) fail('engine.docs.cursor-invalid', 'Cursor does not identify this document revision.');
      offset = cursor.offset as number;
    }
    const related = entry.relatedIds.map(id => { const related = this.byId.get(id)!; return { ref: this.referenceFor.get(id)!, id, title: related.title, surface: related.surface }; });
    const result: Record<string, JsonValue> = { ...(fromSearch ? { resolvedFrom: fromSearch } : {}), ref: this.referenceFor.get(entry.id)!, id: entry.id, title: entry.title, surface: entry.surface, source: entry.source, contentDigest: entry.digest, bundleDigest: this.bundle.digest, binding: this.bundle.binding, blocks: [], nextCursor: null, related: related.slice(0, 8), relatedCount: related.length };
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
