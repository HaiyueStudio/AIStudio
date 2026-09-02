import { asStableId, type JsonObject, type JsonValue, type KnowledgeHitV1, type M13Digest, type M13StableId, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, OperationLogError, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import { LocalHashEmbeddingProvider, tokenize } from './embedding.js';
import {
  KnowledgeRetrievalError,
  type KnowledgeCitation,
  type KnowledgeIndexSnapshot,
  type KnowledgeRetrievalOptions,
  type KnowledgeSearchDiagnostic,
  type KnowledgeSearchHit,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
  type KnowledgeSourceInput,
  type LocalEmbeddingProvider,
} from './types.js';

const SOURCE = asStableId('studio.knowledge-retrieval');
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_SOURCES = 20_000;
const MAX_CHUNKS_PER_SOURCE = 2_000;
const MAX_SEARCH_LIMIT = 50;
const MAX_TOKEN_BUDGET = 16_384;
const REPLAY_WINDOW = 10_000;
const SECRET_PATTERN = /(?:authorization\s*:|bearer\s+[a-z0-9._~-]{8,}|api[_-]?key\s*[:=]|private[_-]?key\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;
const NETWORK_SOURCE = /^(?:https?|wss?):\/\//iu;

interface StoredChunk {
  readonly id: M13StableId;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly tokens: readonly string[];
  readonly embedding: readonly number[];
}

interface StoredSource {
  readonly input: KnowledgeSourceInput;
  readonly contentDigest: M13Digest;
  readonly chunks: readonly StoredChunk[];
  readonly artifactId: M13StableId;
}

interface RankedChunk {
  readonly source: StoredSource;
  readonly chunk: StoredChunk;
  readonly keyword: number;
  readonly embedding: number;
  readonly graph: number;
  readonly score: number;
  readonly stale: boolean;
  readonly retrieval: KnowledgeHitV1['retrieval'];
}

interface ApprovedHitArtifact { readonly digest: string; readonly bytes: number; }

export class KnowledgeRetrievalRuntime {
  private readonly embedding: LocalEmbeddingProvider;
  private readonly chunkCharacters: number;
  private readonly chunkOverlapCharacters: number;
  private readonly clock: () => Date;
  private readonly sources = new Map<M13StableId, StoredSource>();
  private readonly approvedHitArtifacts = new Map<M13StableId, ApprovedHitArtifact>();
  private initialized = false;
  private disposed = false;
  private tombstoneCount = 0;

  constructor(private readonly log: OperationLog, options: KnowledgeRetrievalOptions = {}) {
    this.embedding = options.embedding ?? new LocalHashEmbeddingProvider();
    this.chunkCharacters = options.chunkCharacters ?? 1_200;
    this.chunkOverlapCharacters = options.chunkOverlapCharacters ?? 160;
    this.clock = options.clock ?? (() => new Date());
    if (!Number.isSafeInteger(this.chunkCharacters) || this.chunkCharacters < 256 || this.chunkCharacters > 8_192) throw new TypeError('Knowledge chunk size must be 256-8192 characters.');
    if (!Number.isSafeInteger(this.chunkOverlapCharacters) || this.chunkOverlapCharacters < 0 || this.chunkOverlapCharacters >= this.chunkCharacters / 2) throw new TypeError('Knowledge chunk overlap is invalid.');
  }

  async initialize(): Promise<void> {
    this.assertActive();
    if (this.initialized) return;
    const status = this.log.status();
    const untilSequence = status.nextSequence;
    let afterSequence = status.retainedFromSequence - 1;
    let windowSize = Math.max(1, Math.min(REPLAY_WINDOW, untilSequence - afterSequence - 1));
    let scanned = 0;
    while (afterSequence < untilSequence - 1) {
      const beforeSequence = Math.min(untilSequence, afterSequence + windowSize + 1);
      let cursor: string | undefined;
      try {
        do {
          const page = await this.log.query({
            kinds: ['knowledge/index-source-upserted', 'knowledge/index-source-tombstoned', 'knowledge/retrieval-completed'],
            ...(afterSequence >= 0 ? { afterSequence } : {}), beforeSequence, limit: 200, traverseCorrelation: false, ...(cursor ? { cursor } : {}),
          });
          for (const event of page.events) {
            scanned += 1;
            if (scanned > 50_000) throw new KnowledgeRetrievalError('knowledge.replay-limit', 'Knowledge index replay exceeds 50000 events.');
            if (event.kind === 'knowledge/index-source-tombstoned') {
              const sourceId = event.payload.sourceId;
              if (typeof sourceId === 'string') { this.sources.delete(asStableId(sourceId)); this.tombstoneCount += 1; }
              continue;
            }
            if (event.kind === 'knowledge/index-source-upserted') {
              const artifactId = event.artifactRefs[0];
              if (!artifactId) continue;
              const source = validateStoredSource((await this.log.readArtifact(artifactId)).value, artifactId, this.embedding.dimensions);
              this.sources.set(source.input.sourceId, source);
              continue;
            }
            for (const artifactId of event.artifactRefs) {
              try {
                const record = await this.log.readArtifact(artifactId);
                if (isKnowledgeHitArtifact(record.value)) this.approvedHitArtifacts.set(asStableId(artifactId), Object.freeze({ digest: record.digest, bytes: record.bytes }));
              } catch { /* Missing evidence remains unreadable and is never silently reconstructed. */ }
            }
          }
          cursor = page.nextCursor;
        } while (cursor);
        afterSequence = beforeSequence - 1;
      } catch (cause) {
        if (!(cause instanceof OperationLogError) || cause.code !== 'query-scan-budget-exceeded' || windowSize === 1) throw cause;
        windowSize = Math.max(1, Math.floor(windowSize / 2));
      }
    }
    this.initialized = true;
  }

  async upsert(input: KnowledgeSourceInput, signal?: AbortSignal): Promise<KnowledgeIndexSnapshot> {
    await this.initialize(); throwIfAborted(signal); validateSourceInput(input);
    if (this.sources.size >= MAX_SOURCES && !this.sources.has(input.sourceId)) throw new KnowledgeRetrievalError('knowledge.index-capacity', `Knowledge index is limited to ${MAX_SOURCES} sources.`);
    const contentDigest = `sha256:${sha256(input.text)}` as M13Digest;
    const chunks = chunkSource(input, contentDigest, this.chunkCharacters, this.chunkOverlapCharacters, this.embedding);
    const current = this.sources.get(input.sourceId);
    if (current && current.contentDigest === contentDigest && canonicalMetadata(current.input) === canonicalMetadata(input)) return this.snapshot();
    if (current) await this.appendTombstone(input.sourceId, 'replaced', signal);
    const projection = deepFreeze({
      schemaVersion: 1,
      embedding: { id: this.embedding.id, dimensions: this.embedding.dimensions },
      input: freezeSource(input), contentDigest, chunks,
    }) as unknown as JsonValue;
    const stored = await this.log.putArtifactDetailed(projection, { schemaVersion: 'knowledge-index-source/1', pluginVersion: '0.0.0' });
    const artifactId = stored.reference.id as M13StableId;
    const source: StoredSource = Object.freeze({ input: freezeSource(input), contentDigest, chunks, artifactId });
    this.sources.set(input.sourceId, source);
    await this.log.append({
      kind: 'knowledge/index-source-upserted', severity: 'info', source: SOURCE,
      payload: { sourceId: input.sourceId, sourceKind: input.sourceKind, contentDigest, packageVersion: input.packageVersion, projectRevision: input.projectRevision, permissionScope: input.permissionScope, capabilityIds: input.capabilityIds ?? [], chunkCount: chunks.length, embeddingId: this.embedding.id, localCasHit: stored.localHit },
      artifactRefs: [artifactId as StableId],
    }, { signal });
    return this.snapshot();
  }

  async tombstone(sourceId: M13StableId, reason = 'deleted', signal?: AbortSignal): Promise<KnowledgeIndexSnapshot> {
    await this.initialize(); throwIfAborted(signal);
    if (!this.sources.has(sourceId)) return this.snapshot();
    await this.appendTombstone(sourceId, bounded(reason, 256), signal);
    return this.snapshot();
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    await this.initialize(); throwIfAborted(input.signal); validateSearchInput(input);
    const mode = input.mode ?? 'hybrid';
    const query = bounded(input.query.trim(), 2_048);
    const queryTokens = tokenize(query);
    const queryEmbedding = this.embedding.embed(query);
    const allowed = new Set(input.allowedPermissionScopes);
    const kinds = input.sourceKinds ? new Set(input.sourceKinds) : null;
    const versions = input.packageVersions ? new Set(input.packageVersions) : null;
    const capabilities = input.capabilityIds ? new Set(input.capabilityIds) : null;
    const graphDistance = this.graphDistances(input.graphSeedSourceIds ?? []);
    const diagnostics: KnowledgeSearchDiagnostic[] = [];
    let permissionFiltered = 0; let versionFiltered = 0; let staleFiltered = 0;
    const candidates: RankedChunk[] = [];
    const documentFrequency = termDocumentFrequency([...this.sources.values()], queryTokens);
    for (const source of this.sources.values()) {
      if (!allowed.has(source.input.permissionScope)) { permissionFiltered += source.chunks.length; continue; }
      if (kinds && !kinds.has(source.input.sourceKind)) continue;
      if (capabilities && !(source.input.capabilityIds ?? []).some((id) => capabilities.has(id))) continue;
      const versionStale = Boolean(versions && source.input.packageVersion !== null && !versions.has(source.input.packageVersion));
      if (versionStale && !input.includeStale) { versionFiltered += source.chunks.length; continue; }
      const revisionStale = input.projectRevision !== undefined && input.projectRevision !== null && source.input.projectRevision !== null && source.input.projectRevision !== input.projectRevision;
      const stale = versionStale || revisionStale;
      if (stale && !input.includeStale) { staleFiltered += source.chunks.length; continue; }
      for (const chunk of source.chunks) {
        const keyword = bm25(queryTokens, chunk.tokens, documentFrequency, Math.max(1, this.chunkCount()));
        const semantic = mode === 'hybrid' ? Math.max(0, cosine(queryEmbedding, chunk.embedding)) : 0;
        const distance = graphDistance.get(source.input.sourceId);
        const graph = distance === undefined ? 0 : 1 / (1 + distance);
        const exact = chunk.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? 1 : 0;
        const score = mode === 'exact-only' ? Math.min(1, keyword + graph * 0.1 + exact * 0.2) : Math.min(1, keyword * 0.5 + semantic * 0.35 + graph * 0.1 + exact * 0.05);
        if (score <= 0.0001) continue;
        const retrieval: KnowledgeHitV1['retrieval'] = graph > 0 && keyword === 0 && semantic === 0 ? 'graph' : mode === 'exact-only' || semantic === 0 ? 'keyword' : keyword === 0 ? 'embedding' : 'hybrid';
        candidates.push(Object.freeze({ source, chunk, keyword, embedding: semantic, graph, score, stale, retrieval }));
      }
    }
    pushDiagnostic(diagnostics, 'permission-filtered', permissionFiltered, 'Knowledge outside the active permission scopes was excluded before ranking.');
    pushDiagnostic(diagnostics, 'version-filtered', versionFiltered, 'Knowledge from a different package version was excluded.');
    pushDiagnostic(diagnostics, 'stale-filtered', staleFiltered, 'Revision-stale project knowledge was excluded in favor of exact context.');
    candidates.sort((left, right) => right.score - left.score || left.source.input.source.localeCompare(right.source.input.source) || left.chunk.start - right.chunk.start);
    const conflicts = conflictSourceIds(candidates);
    if (conflicts.size) pushDiagnostic(diagnostics, 'conflicting-sources', conflicts.size, 'Conflicting claims were withheld; exact facts or a version-qualified query are required.');
    const limit = input.limit ?? 8; const tokenBudget = input.tokenBudget ?? 2_048;
    const hits: KnowledgeSearchHit[] = []; let estimatedTokens = 0; let budgetSkipped = 0;
    for (const candidate of candidates) {
      if (hits.length >= limit) break;
      if (conflicts.has(candidate.source.input.sourceId)) continue;
      const tokenCount = Math.max(1, Math.ceil(Buffer.byteLength(candidate.chunk.text) / 4));
      if (estimatedTokens + tokenCount > tokenBudget) { budgetSkipped += 1; continue; }
      const materialized = await this.materializeHit(candidate, tokenCount, input.signal);
      hits.push(materialized); estimatedTokens += tokenCount;
    }
    pushDiagnostic(diagnostics, 'token-budget', budgetSkipped, 'Lower-ranked knowledge was omitted to keep the retrieval token budget bounded.');
    if (!hits.length) pushDiagnostic(diagnostics, 'no-results', 1, 'No authorized, current, non-conflicting knowledge matched; use exact tools or report uncertainty.');
    const artifactIds = Object.freeze(hits.map((entry) => entry.artifactId));
    const result: KnowledgeSearchResult = deepFreeze({ query, hits, artifactIds, diagnostics, estimatedTokens, candidateCount: candidates.length, retrieval: mode, indexDigest: this.snapshot().indexDigest });
    await this.log.append({
      kind: 'knowledge/retrieval-completed', severity: diagnostics.some((entry) => entry.code === 'conflicting-sources') ? 'warning' : 'info', source: SOURCE,
      payload: { queryDigest: `sha256:${sha256(query)}`, mode, resultCount: hits.length, candidateCount: candidates.length, estimatedTokens, indexDigest: result.indexDigest, diagnosticCodes: diagnostics.map((entry) => entry.code) },
      artifactRefs: artifactIds as readonly StableId[],
    }, { signal: input.signal });
    return result;
  }

  async indexSessionDecision(input: Readonly<{ sessionId: M13StableId; turnId: M13StableId; permissionScope: M13StableId; projectRevision: number | null; summary: JsonObject; relatedSourceIds?: readonly M13StableId[] }>, signal?: AbortSignal): Promise<KnowledgeIndexSnapshot> {
    const text = canonicalStringify(input.summary);
    return this.upsert({
      sourceId: asStableId(`knowledge-session:${sha256(`${input.sessionId}:${input.turnId}`).slice(0, 32)}`),
      source: `session://${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.turnId)}`,
      sourceKind: 'session-decision', text, mediaType: 'application/json', packageVersion: null, projectRevision: input.projectRevision,
      permissionScope: input.permissionScope, capabilityIds: [], claimKeys: [], relatedSourceIds: input.relatedSourceIds ?? [], authorized: true, verified: true,
    }, signal);
  }

  async assertReadable(ids: readonly M13StableId[]): Promise<void> {
    await this.initialize();
    for (const id of ids) {
      const approved = this.approvedHitArtifacts.get(id);
      if (!approved) throw new KnowledgeRetrievalError('knowledge.hit-not-approved', `Knowledge artifact ${id} is not an approved retrieval result.`);
      const record = await this.log.readArtifact(asStableId(id));
      if (record.digest !== approved.digest || record.bytes !== approved.bytes || !isKnowledgeHitArtifact(record.value)) throw new KnowledgeRetrievalError('knowledge.hit-integrity', `Knowledge artifact ${id} failed integrity validation.`);
    }
  }

  async readProjection(id: M13StableId): Promise<JsonValue> {
    await this.assertReadable([id]); return (await this.log.readArtifact(asStableId(id))).value;
  }

  snapshot(): KnowledgeIndexSnapshot {
    const semantic = [...this.sources.values()].sort((a, b) => a.input.sourceId.localeCompare(b.input.sourceId)).map((entry) => ({ sourceId: entry.input.sourceId, contentDigest: entry.contentDigest, packageVersion: entry.input.packageVersion, projectRevision: entry.input.projectRevision, permissionScope: entry.input.permissionScope, chunks: entry.chunks.map((chunk) => chunk.id) }));
    return deepFreeze({ sourceCount: this.sources.size, chunkCount: this.chunkCount(), tombstoneCount: this.tombstoneCount, indexDigest: `sha256:${sha256(canonicalStringify(semantic as unknown as JsonValue))}`, initialized: this.initialized });
  }

  dispose(): void { this.disposed = true; this.sources.clear(); this.approvedHitArtifacts.clear(); }

  private async appendTombstone(sourceId: M13StableId, reason: string, signal?: AbortSignal): Promise<void> {
    const current = this.sources.get(sourceId); this.sources.delete(sourceId); this.tombstoneCount += 1;
    await this.log.append({ kind: 'knowledge/index-source-tombstoned', severity: 'info', source: SOURCE, payload: { sourceId, reason, priorContentDigest: current?.contentDigest ?? null, at: this.clock().toISOString() } }, { signal });
  }

  private async materializeHit(candidate: RankedChunk, estimatedTokens: number, signal?: AbortSignal): Promise<KnowledgeSearchHit> {
    const source = candidate.source.input;
    const reason = `hybrid=${candidate.score.toFixed(4)} keyword=${candidate.keyword.toFixed(4)} embedding=${candidate.embedding.toFixed(4)} graph=${candidate.graph.toFixed(4)}; version=${source.packageVersion ?? 'project'}; provenance=authorized; verified=${source.verified === true}`;
    const hit: KnowledgeHitV1 = deepFreeze({
      schemaVersion: 1, id: asStableId(`knowledge-hit:${sha256(`${candidate.chunk.id}:${candidate.score.toFixed(8)}`).slice(0, 32)}`), source: source.source, sourceKind: source.sourceKind,
      packageVersion: source.packageVersion, projectRevision: source.projectRevision, contentDigest: candidate.source.contentDigest,
      chunk: { start: candidate.chunk.start, end: candidate.chunk.end }, retrieval: candidate.retrieval, score: candidate.score, reason,
      permissionScope: source.permissionScope, stale: candidate.stale,
    });
    const citation: KnowledgeCitation = deepFreeze({ source: source.source, sourceKind: source.sourceKind, packageVersion: source.packageVersion, projectRevision: source.projectRevision, contentDigest: candidate.source.contentDigest, start: candidate.chunk.start, end: candidate.chunk.end, startLine: candidate.chunk.startLine, endLine: candidate.chunk.endLine });
    const projection = deepFreeze({ schemaVersion: 1, hit, citation, excerpt: candidate.chunk.text, estimatedTokens, capabilityIds: source.capabilityIds ?? [], retrievedAt: this.clock().toISOString() }) as unknown as JsonValue;
    const stored = await this.log.putArtifactDetailed(projection, { schemaVersion: 'knowledge-hit/1', pluginVersion: '0.0.0' });
    const artifactId = stored.reference.id as M13StableId;
    this.approvedHitArtifacts.set(artifactId, Object.freeze({ digest: stored.reference.digest, bytes: stored.reference.bytes }));
    throwIfAborted(signal);
    return deepFreeze({ hit, citation, excerpt: candidate.chunk.text, estimatedTokens, capabilityIds: source.capabilityIds ?? [], artifactId });
  }

  private graphDistances(seedIds: readonly M13StableId[]): ReadonlyMap<M13StableId, number> {
    const distances = new Map<M13StableId, number>(); const queue: M13StableId[] = [];
    for (const id of seedIds.slice(0, 64)) if (this.sources.has(id)) { distances.set(id, 0); queue.push(id); }
    while (queue.length) {
      const id = queue.shift()!; const distance = distances.get(id)!; if (distance >= 4) continue;
      const source = this.sources.get(id); if (!source) continue;
      const neighbors = new Set(source.input.relatedSourceIds ?? []);
      for (const candidate of this.sources.values()) if ((candidate.input.relatedSourceIds ?? []).includes(id)) neighbors.add(candidate.input.sourceId);
      for (const neighbor of [...neighbors].sort()) if (this.sources.has(neighbor) && !distances.has(neighbor)) { distances.set(neighbor, distance + 1); queue.push(neighbor); }
    }
    return distances;
  }

  private chunkCount(): number { return [...this.sources.values()].reduce((sum, source) => sum + source.chunks.length, 0); }
  private assertActive(): void { if (this.disposed) throw new KnowledgeRetrievalError('knowledge.disposed', 'Knowledge retrieval runtime is disposed.'); }
}

function validateSourceInput(input: KnowledgeSourceInput): void {
  if (!input.authorized) throw new KnowledgeRetrievalError('knowledge.source-unauthorized', 'Unauthorized knowledge cannot be indexed.');
  if (NETWORK_SOURCE.test(input.source)) throw new KnowledgeRetrievalError('knowledge.network-source-rejected', 'Knowledge indexing is local-only; network sources must be materialized by an authorized owner first.');
  if (!input.source.trim() || Buffer.byteLength(input.source) > 2_048) throw new KnowledgeRetrievalError('knowledge.source-invalid', 'Knowledge source is invalid.');
  if (!['engine-doc', 'component-schema', 'project-doc', 'asset-metadata', 'verified-example', 'session-decision'].includes(input.sourceKind)) throw new KnowledgeRetrievalError('knowledge.source-kind-invalid', 'Knowledge source kind is invalid.');
  if (!input.text.trim() || Buffer.byteLength(input.text) > MAX_SOURCE_BYTES) throw new KnowledgeRetrievalError('knowledge.source-size', `Knowledge text must be 1-${MAX_SOURCE_BYTES} bytes.`);
  if (SECRET_PATTERN.test(input.text)) throw new KnowledgeRetrievalError('knowledge.secret-rejected', 'Secret-shaped content cannot enter the knowledge index.');
  if (input.sourceKind === 'verified-example' && input.verified !== true) throw new KnowledgeRetrievalError('knowledge.example-unverified', 'Only verified examples may enter the knowledge index.');
  if (input.packageVersion !== null && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(input.packageVersion)) throw new KnowledgeRetrievalError('knowledge.package-version-invalid', 'Knowledge package version is invalid.');
  if (input.projectRevision !== null && (!Number.isSafeInteger(input.projectRevision) || input.projectRevision < 0)) throw new KnowledgeRetrievalError('knowledge.project-revision-invalid', 'Knowledge project revision is invalid.');
  for (const list of [input.capabilityIds ?? [], input.relatedSourceIds ?? []]) if (list.length > 256 || new Set(list).size !== list.length) throw new KnowledgeRetrievalError('knowledge.source-metadata-invalid', 'Knowledge source relations are duplicate or oversized.');
  if ((input.claimKeys ?? []).length > 64 || (input.claimKeys ?? []).some((key) => !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(key))) throw new KnowledgeRetrievalError('knowledge.claim-key-invalid', 'Knowledge claim keys are invalid.');
}

function validateSearchInput(input: KnowledgeSearchInput): void {
  if (typeof input.query !== 'string' || !input.query.trim() || Buffer.byteLength(input.query) > 2_048) throw new KnowledgeRetrievalError('knowledge.query-invalid', 'Knowledge query is invalid.');
  if (!Array.isArray(input.allowedPermissionScopes) || input.allowedPermissionScopes.length < 1 || input.allowedPermissionScopes.length > 64 || new Set(input.allowedPermissionScopes).size !== input.allowedPermissionScopes.length) throw new KnowledgeRetrievalError('knowledge.permission-required', 'At least one unique permission scope is required.');
  const limit = input.limit ?? 8; if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) throw new KnowledgeRetrievalError('knowledge.limit-invalid', `Knowledge result limit must be 1-${MAX_SEARCH_LIMIT}.`);
  const budget = input.tokenBudget ?? 2_048; if (!Number.isSafeInteger(budget) || budget < 64 || budget > MAX_TOKEN_BUDGET) throw new KnowledgeRetrievalError('knowledge.token-budget-invalid', `Knowledge token budget must be 64-${MAX_TOKEN_BUDGET}.`);
  if (input.projectRevision !== undefined && input.projectRevision !== null && (!Number.isSafeInteger(input.projectRevision) || input.projectRevision < 0)) throw new KnowledgeRetrievalError('knowledge.project-revision-invalid', 'Knowledge search revision is invalid.');
}

function chunkSource(input: KnowledgeSourceInput, digest: M13Digest, size: number, overlap: number, embedding: LocalEmbeddingProvider): readonly StoredChunk[] {
  const chunks: StoredChunk[] = []; let start = 0;
  while (start < input.text.length) {
    let end = Math.min(input.text.length, start + size);
    if (end < input.text.length) {
      const boundary = Math.max(input.text.lastIndexOf('\n', end), input.text.lastIndexOf('。', end), input.text.lastIndexOf('. ', end));
      if (boundary > start + size / 2) end = boundary + 1;
    }
    const text = input.text.slice(start, end).trim();
    if (text) {
      const actualStart = input.text.indexOf(text, start); const actualEnd = actualStart + text.length;
      chunks.push(Object.freeze({ id: asStableId(`knowledge-chunk:${sha256(`${input.sourceId}:${digest}:${actualStart}:${actualEnd}`).slice(0, 32)}`), start: actualStart, end: actualEnd, startLine: lineAt(input.text, actualStart), endLine: lineAt(input.text, actualEnd), text, tokens: tokenize(text), embedding: embedding.embed(text) }));
    }
    if (end >= input.text.length) break;
    start = Math.max(start + 1, end - overlap);
    if (chunks.length > MAX_CHUNKS_PER_SOURCE) throw new KnowledgeRetrievalError('knowledge.chunk-capacity', `One source exceeds ${MAX_CHUNKS_PER_SOURCE} chunks.`);
  }
  return Object.freeze(chunks);
}

function validateStoredSource(value: JsonValue, artifactId: StableId, dimensions: number): StoredSource {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.input) || typeof value.contentDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.contentDigest) || !Array.isArray(value.chunks)) throw new KnowledgeRetrievalError('knowledge.index-artifact-invalid', 'Stored knowledge index artifact is invalid.');
  const input = value.input as unknown as KnowledgeSourceInput; validateSourceInput(input);
  const chunks = value.chunks.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || !Number.isSafeInteger(entry.startLine) || !Number.isSafeInteger(entry.endLine) || typeof entry.text !== 'string' || !Array.isArray(entry.tokens) || entry.tokens.some((token) => typeof token !== 'string') || !Array.isArray(entry.embedding) || entry.embedding.length !== dimensions || entry.embedding.some((member) => typeof member !== 'number' || !Number.isFinite(member))) throw new KnowledgeRetrievalError('knowledge.index-chunk-invalid', 'Stored knowledge chunk is invalid.');
    return Object.freeze({
      id: asStableId(entry.id), start: entry.start as number, end: entry.end as number,
      startLine: entry.startLine as number, endLine: entry.endLine as number, text: entry.text,
      tokens: Object.freeze(entry.tokens as string[]), embedding: Object.freeze(entry.embedding as number[]),
    });
  });
  return Object.freeze({ input: freezeSource(input), contentDigest: value.contentDigest as M13Digest, chunks: Object.freeze(chunks), artifactId: artifactId as M13StableId });
}

function freezeSource(input: KnowledgeSourceInput): KnowledgeSourceInput { return deepFreeze({ sourceId: input.sourceId, source: input.source, sourceKind: input.sourceKind, text: input.text, mediaType: input.mediaType ?? 'text/plain', packageVersion: input.packageVersion, projectRevision: input.projectRevision, permissionScope: input.permissionScope, capabilityIds: [...(input.capabilityIds ?? [])], claimKeys: [...(input.claimKeys ?? [])], relatedSourceIds: [...(input.relatedSourceIds ?? [])], authorized: input.authorized, ...(input.verified === undefined ? {} : { verified: input.verified }) }); }
function canonicalMetadata(input: KnowledgeSourceInput): string { const { text: _text, ...metadata } = freezeSource(input); return canonicalStringify(metadata as unknown as JsonValue); }
function lineAt(text: string, offset: number): number { let line = 1; for (let index = 0; index < Math.min(offset, text.length); index += 1) if (text.charCodeAt(index) === 10) line += 1; return line; }
function termDocumentFrequency(sources: readonly StoredSource[], queryTokens: readonly string[]): ReadonlyMap<string, number> { const result = new Map<string, number>(); for (const token of new Set(queryTokens)) for (const source of sources) for (const chunk of source.chunks) if (chunk.tokens.includes(token)) result.set(token, (result.get(token) ?? 0) + 1); return result; }
function bm25(query: readonly string[], document: readonly string[], df: ReadonlyMap<string, number>, count: number): number { if (!query.length || !document.length) return 0; const frequencies = new Map<string, number>(); for (const token of document) frequencies.set(token, (frequencies.get(token) ?? 0) + 1); let score = 0; for (const token of new Set(query)) { const tf = frequencies.get(token) ?? 0; if (!tf) continue; const idf = Math.log(1 + (count - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5)); score += idf * (tf * 2.2) / (tf + 1.2); } return 1 - Math.exp(-score / 4); }
function cosine(left: readonly number[], right: readonly number[]): number { if (left.length !== right.length) return 0; let value = 0; for (let index = 0; index < left.length; index += 1) value += left[index]! * right[index]!; return Math.max(-1, Math.min(1, value)); }
function conflictSourceIds(candidates: readonly RankedChunk[]): ReadonlySet<M13StableId> { const claims = new Map<string, Map<string, Set<M13StableId>>>(); for (const candidate of candidates.slice(0, 100)) for (const key of candidate.source.input.claimKeys ?? []) { let digests = claims.get(key); if (!digests) { digests = new Map(); claims.set(key, digests); } let ids = digests.get(candidate.source.contentDigest); if (!ids) { ids = new Set(); digests.set(candidate.source.contentDigest, ids); } ids.add(candidate.source.input.sourceId); } const conflicts = new Set<M13StableId>(); for (const digests of claims.values()) if (digests.size > 1) for (const ids of digests.values()) for (const id of ids) conflicts.add(id); return conflicts; }
function pushDiagnostic(target: KnowledgeSearchDiagnostic[], code: KnowledgeSearchDiagnostic['code'], count: number, message: string): void { if (count > 0) target.push(Object.freeze({ code, count, message })); }
function isKnowledgeHitArtifact(value: JsonValue): boolean { return isRecord(value) && value.schemaVersion === 1 && isRecord(value.hit) && typeof value.hit.id === 'string' && typeof value.hit.contentDigest === 'string' && isRecord(value.citation) && typeof value.excerpt === 'string' && Number.isSafeInteger(value.estimatedTokens); }
function isRecord(value: unknown): value is Record<string, JsonValue> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function bounded(value: string, maximum: number): string { return value.length <= maximum ? value : value.slice(0, maximum); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new KnowledgeRetrievalError('knowledge.cancelled', 'Knowledge operation was cancelled.', true); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
