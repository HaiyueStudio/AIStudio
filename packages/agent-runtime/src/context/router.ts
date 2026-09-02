import { asStableId, type JsonObject, type JsonValue, type M13Digest, type M13StableId, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256, type OperationLog, type OperationSeverity } from '@haiyue/ai-studio-operation-log';
import type { ContextFrameInputDraft } from './types.js';

const SOURCE = asStableId('studio.context-router');
const MAX_DELTA_ITEMS = 1_000;
const MAX_EXTERNAL_INPUTS = 256;

export interface SceneExactContextSource {
  query(input: Readonly<{ revision: number; request: JsonObject }>): Promise<JsonValue> | JsonValue;
  diff(input: Readonly<{ fromRevision: number; toRevision: number; request: JsonObject }>): Promise<JsonValue> | JsonValue;
}

export interface CursorDeltaPage {
  readonly items: readonly JsonValue[];
  readonly nextCursor: string | null;
  readonly sourceRevision: number | null;
  readonly truncated: boolean;
}

export interface CursorDeltaSource {
  read(input: Readonly<{ cursor: string | null; limit: number }>): Promise<CursorDeltaPage> | CursorDeltaPage;
}

export interface OperationLogDeltaSourceOptions {
  readonly channel: string;
  readonly kinds?: readonly string[];
  readonly severity?: readonly OperationSeverity[];
}

export interface ContextRouterSources {
  readonly scene: SceneExactContextSource;
  readonly diagnostics?: CursorDeltaSource;
  readonly evidence?: CursorDeltaSource;
  readonly playTrace?: CursorDeltaSource;
}

export interface ContextRouteCursors {
  readonly diagnostics: string | null;
  readonly evidence: string | null;
  readonly playTrace: string | null;
}

export interface RouteContextInput {
  readonly sessionId: M13StableId;
  readonly turnId: M13StableId;
  readonly projectRevision: number;
  readonly previousProjectRevision: number | null;
  readonly sceneRequest?: JsonObject;
  readonly cursors?: Partial<ContextRouteCursors>;
  readonly deltaLimit?: number;
  readonly durableMemoryArtifactIds?: readonly M13StableId[];
  readonly knowledgeHitArtifactIds?: readonly M13StableId[];
  readonly knowledgePolicy?: Readonly<{
    readonly allowedPermissionScopes: readonly M13StableId[];
    readonly packageVersions?: readonly string[];
    readonly projectRevision?: number | null;
  }>;
  readonly signal?: AbortSignal;
}

export interface RoutedContextInputs {
  readonly inputs: readonly ContextFrameInputDraft[];
  readonly cursors: ContextRouteCursors;
  readonly sceneMode: 'snapshot' | 'diff' | 'snapshot-recovery';
  readonly recoveryDiagnostic: Readonly<{ code: string; message: string }> | null;
  readonly metrics: Readonly<{
    fullSceneTransmissions: 0 | 1;
    sceneBytes: number;
    exactBytes: number;
    durableBytes: number;
    semanticBytes: number;
  }>;
}

export class ContextRouterError extends Error {
  constructor(readonly code: string, message: string, readonly recoverable = false) { super(message); this.name = 'ContextRouterError'; }
}

/** Converts the append-only Operation Log into a redacted high-water cursor feed.
 * It pages the unfiltered sequence first and filters locally, so sparse channels
 * never skip unseen events when the log query reaches a scan/page boundary. */
export class OperationLogCursorDeltaSource implements CursorDeltaSource {
  private readonly kinds: ReadonlySet<string> | null;
  private readonly severity: ReadonlySet<OperationSeverity> | null;
  constructor(private readonly log: OperationLog, private readonly options: OperationLogDeltaSourceOptions) {
    if (!/^[a-z][a-z0-9-]{1,63}$/u.test(options.channel)) throw new TypeError('Operation Log context channel is invalid.');
    this.kinds = options.kinds ? new Set(options.kinds) : null; this.severity = options.severity ? new Set(options.severity) : null;
  }
  async read(input: Readonly<{ cursor: string | null; limit: number }>): Promise<CursorDeltaPage> {
    const status = this.log.status(); const afterSequence = input.cursor ? decodeLogCursor(input.cursor, this.options.channel) : status.retainedFromSequence - 1;
    if (afterSequence < status.retainedFromSequence - 1) throw new ContextRouterError('context.delta-history-pruned', `Operation Log ${this.options.channel} cursor predates retained sequence ${status.retainedFromSequence}.`, true);
    const page = await this.log.query({ ...(afterSequence >= 0 ? { afterSequence } : {}), limit: input.limit, traverseCorrelation: false });
    const items = page.events.filter((event) => (!this.kinds || this.kinds.has(event.kind)) && (!this.severity || this.severity.has(event.severity))).map((event) => Object.freeze({
      sequence: event.sequence, eventId: event.eventId, timestamp: event.timestamp, kind: event.kind, severity: event.severity, source: event.source,
      correlation: event.correlation as JsonObject, payloadDigest: `sha256:${event.payloadDigest}`, artifactRefs: event.artifactRefs,
    })) as unknown as readonly JsonValue[];
    const highWater = page.events.at(-1)?.sequence ?? Math.max(afterSequence, status.nextSequence - 1);
    return Object.freeze({ items: Object.freeze(items), nextCursor: encodeLogCursor(this.options.channel, highWater), sourceRevision: null, truncated: page.nextCursor !== null });
  }
}

export function operationLogContextDeltaSources(log: OperationLog): Readonly<Pick<ContextRouterSources, 'diagnostics' | 'evidence' | 'playTrace'>> {
  return Object.freeze({
    diagnostics: new OperationLogCursorDeltaSource(log, { channel: 'diagnostics', severity: ['warning', 'error'] }),
    evidence: new OperationLogCursorDeltaSource(log, { channel: 'evidence', kinds: ['observation/persisted', 'tool/execution-completed'] }),
    playTrace: new OperationLogCursorDeltaSource(log, { channel: 'play-trace', kinds: ['preview/started', 'preview/stopped', 'preview/runtime-error', 'observation/persisted'] }),
  });
}

/** Exact Scene/diagnostic/evidence facts are materialized first, then durable memory,
 * then semantic knowledge. Semantic inputs can never replace or mutate exact inputs. */
export class ContextRouterRuntime {
  private disposed = false;

  constructor(private readonly log: OperationLog, private readonly sources: ContextRouterSources) {}

  async route(input: RouteContextInput): Promise<RoutedContextInputs> {
    this.assertActive(); throwIfAborted(input.signal);
    validateRouteInput(input);
    const sceneRequest = Object.freeze({ ...(input.sceneRequest ?? {}) });
    let sceneMode: RoutedContextInputs['sceneMode'] = input.previousProjectRevision === null ? 'snapshot' : 'diff';
    let recoveryDiagnostic: RoutedContextInputs['recoveryDiagnostic'] = null;
    let sceneValue: JsonValue;
    if (input.previousProjectRevision === null) sceneValue = await this.sources.scene.query({ revision: input.projectRevision, request: sceneRequest });
    else {
      try { sceneValue = await this.sources.scene.diff({ fromRevision: input.previousProjectRevision, toRevision: input.projectRevision, request: sceneRequest }); }
      catch (cause) {
        const diagnostic = recoverableSourceDiagnostic(cause); if (!diagnostic) throw cause;
        recoveryDiagnostic = diagnostic; sceneMode = 'snapshot-recovery';
        sceneValue = await this.sources.scene.query({ revision: input.projectRevision, request: sceneRequest });
      }
    }
    throwIfAborted(input.signal);
    const sceneKind = sceneMode === 'diff' ? 'scene-diff' : 'scene-snapshot';
    const exact: ContextFrameInputDraft[] = [];
    const scene = await this.materialize(sceneKind, sceneValue, input.projectRevision, true);
    exact.push(scene.input);

    const limit = input.deltaLimit ?? 100;
    const cursors: ContextRouteCursors = { diagnostics: input.cursors?.diagnostics ?? null, evidence: input.cursors?.evidence ?? null, playTrace: input.cursors?.playTrace ?? null };
    const routedCursors: Record<keyof ContextRouteCursors, string | null> = { ...cursors };
    let exactBytes = scene.bytes;
    for (const route of [
      ['diagnostics', this.sources.diagnostics, 'diagnostics-delta'],
      ['evidence', this.sources.evidence, 'evidence-delta'],
      ['playTrace', this.sources.playTrace, 'evidence-delta'],
    ] as const) {
      const [channel, source, kind] = route; if (!source) continue;
      const page = await source.read({ cursor: cursors[channel], limit }); throwIfAborted(input.signal); validateDeltaPage(channel, page);
      routedCursors[channel] = page.nextCursor;
      if (page.items.length === 0 && !page.truncated) continue;
      const materialized = await this.materialize(kind, Object.freeze({ schemaVersion: 1, channel, items: page.items, truncated: page.truncated, nextCursor: page.nextCursor }) as unknown as JsonValue, page.sourceRevision, false);
      exact.push(materialized.input); exactBytes += materialized.bytes;
    }

    const durable = await this.approvedInputs(input.durableMemoryArtifactIds ?? [], 'durable-memory', input.projectRevision);
    const semantic = await this.approvedInputs(input.knowledgeHitArtifactIds ?? [], 'knowledge-hit', null, input.knowledgePolicy);
    const inputs = Object.freeze([...exact, ...durable.inputs, ...semantic.inputs]);
    const artifactRefs = Object.freeze(inputs.map((entry) => entry.artifactId as StableId));
    const metrics = Object.freeze({ fullSceneTransmissions: (sceneMode === 'diff' ? 0 : 1) as 0 | 1, sceneBytes: scene.bytes, exactBytes, durableBytes: durable.bytes, semanticBytes: semantic.bytes });
    await this.log.append({
      kind: 'agent/context-route-prepared', severity: recoveryDiagnostic ? 'warning' : 'info', source: SOURCE,
      correlation: { sessionId: input.sessionId as StableId, turnId: input.turnId as StableId },
      payload: { projectRevision: input.projectRevision, previousProjectRevision: input.previousProjectRevision, sceneMode, recoveryDiagnostic, inputKinds: inputs.map((entry) => entry.kind), inputCount: inputs.length, cursors: routedCursors, metrics },
      artifactRefs,
    }, { signal: input.signal });
    return deepFreeze({ inputs, cursors: routedCursors, sceneMode, recoveryDiagnostic, metrics });
  }

  dispose(): void { this.disposed = true; }

  private async materialize(kind: ContextFrameInputDraft['kind'], value: JsonValue, sourceRevision: number | null, required: boolean): Promise<Readonly<{ input: ContextFrameInputDraft; bytes: number }>> {
    const stored = await this.log.putArtifactDetailed(value, { schemaVersion: `context-router-${kind}/1`, pluginVersion: '0.0.0' });
    const digest = `sha256:${stored.reference.digest}` as M13Digest;
    return Object.freeze({
      input: Object.freeze({ kind, artifactId: stored.reference.id as M13StableId, digest, sourceRevision, estimatedTokens: estimateTokens(stored.reference.bytes), required }),
      bytes: stored.reference.bytes,
    });
  }

  private async approvedInputs(ids: readonly M13StableId[], kind: 'durable-memory' | 'knowledge-hit', sourceRevision: number | null, knowledgePolicy?: RouteContextInput['knowledgePolicy']): Promise<Readonly<{ inputs: readonly ContextFrameInputDraft[]; bytes: number }>> {
    if (ids.length > MAX_EXTERNAL_INPUTS || new Set(ids).size !== ids.length) throw new ContextRouterError('context.router-inputs-invalid', `${kind} inputs are duplicate or exceed ${MAX_EXTERNAL_INPUTS}.`);
    if (kind === 'knowledge-hit' && ids.length > 0 && !knowledgePolicy) throw new ContextRouterError('context.knowledge-policy-required', 'Semantic knowledge inputs require an explicit permission and version policy.');
    const inputs: ContextFrameInputDraft[] = []; let bytes = 0;
    for (const id of ids) {
      const artifact = await this.log.readArtifact(asStableId(id)); bytes += artifact.bytes;
      if (kind === 'knowledge-hit') validateKnowledgeHitProjection(artifact.value, knowledgePolicy!);
      inputs.push(Object.freeze({ kind, artifactId: id, digest: `sha256:${artifact.digest}` as M13Digest, sourceRevision, estimatedTokens: estimateTokens(artifact.bytes), required: false }));
    }
    return Object.freeze({ inputs: Object.freeze(inputs), bytes });
  }

  private assertActive(): void { if (this.disposed) throw new ContextRouterError('context.router-disposed', 'Context Router is disposed.'); }
}

export function fullSceneRetransmissionReduction(results: readonly Pick<RoutedContextInputs, 'metrics'>[]): number {
  if (results.length < 2) return 0;
  const later = results.slice(1); const full = later.reduce((sum, result) => sum + result.metrics.fullSceneTransmissions, 0);
  return 1 - full / later.length;
}

function validateRouteInput(input: RouteContextInput): void {
  if (!Number.isSafeInteger(input.projectRevision) || input.projectRevision < 0 || (input.previousProjectRevision !== null && (!Number.isSafeInteger(input.previousProjectRevision) || input.previousProjectRevision < 0 || input.previousProjectRevision > input.projectRevision))) throw new ContextRouterError('context.router-revision-invalid', 'Context Router revisions are invalid.');
  const limit = input.deltaLimit ?? 100; if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DELTA_ITEMS) throw new ContextRouterError('context.router-limit-invalid', `Context Router delta limit must be 1-${MAX_DELTA_ITEMS}.`);
  if (input.knowledgePolicy) {
    const scopes = input.knowledgePolicy.allowedPermissionScopes;
    if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 64 || new Set(scopes).size !== scopes.length) throw new ContextRouterError('context.knowledge-policy-invalid', 'Knowledge permission scopes are empty, duplicated or oversized.');
    const revision = input.knowledgePolicy.projectRevision;
    if (revision !== undefined && revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) throw new ContextRouterError('context.knowledge-policy-invalid', 'Knowledge project revision is invalid.');
  }
}

function validateKnowledgeHitProjection(value: JsonValue, policy: NonNullable<RouteContextInput['knowledgePolicy']>): void {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.hit) || !isRecord(value.citation) || typeof value.excerpt !== 'string' || !Number.isSafeInteger(value.estimatedTokens)) throw new ContextRouterError('context.knowledge-hit-invalid', 'Knowledge hit artifact shape is invalid.');
  const hit = value.hit; const citation = value.citation;
  if (typeof hit.source !== 'string' || typeof hit.sourceKind !== 'string' || typeof hit.packageVersion !== 'string' && hit.packageVersion !== null || typeof hit.projectRevision !== 'number' && hit.projectRevision !== null
    || typeof hit.contentDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(hit.contentDigest) || !isRecord(hit.chunk) || !Number.isSafeInteger(hit.chunk.start) || !Number.isSafeInteger(hit.chunk.end)
    || typeof hit.permissionScope !== 'string' || typeof hit.stale !== 'boolean' || typeof hit.score !== 'number' || !Number.isFinite(hit.score) || hit.score < 0 || hit.score > 1) throw new ContextRouterError('context.knowledge-hit-invalid', 'Knowledge hit provenance is invalid.');
  if (hit.stale) throw new ContextRouterError('context.knowledge-hit-stale', 'Stale knowledge cannot enter a Context Frame.');
  if (!policy.allowedPermissionScopes.includes(asStableId(hit.permissionScope))) throw new ContextRouterError('context.knowledge-hit-permission', 'Knowledge hit is outside the active permission scopes.');
  if (policy.packageVersions && hit.packageVersion !== null && !policy.packageVersions.includes(hit.packageVersion)) throw new ContextRouterError('context.knowledge-hit-version', 'Knowledge hit package version is not active.');
  if (policy.projectRevision !== undefined && policy.projectRevision !== null && hit.projectRevision !== null && hit.projectRevision !== policy.projectRevision) throw new ContextRouterError('context.knowledge-hit-revision', 'Knowledge hit project revision is stale.');
  for (const key of ['source', 'sourceKind', 'packageVersion', 'projectRevision', 'contentDigest'] as const) if (citation[key] !== hit[key]) throw new ContextRouterError('context.knowledge-hit-citation', `Knowledge citation ${key} does not match its hit.`);
  if (citation.start !== hit.chunk.start || citation.end !== hit.chunk.end || !Number.isSafeInteger(citation.startLine) || !Number.isSafeInteger(citation.endLine)) throw new ContextRouterError('context.knowledge-hit-citation', 'Knowledge citation offsets do not match its hit.');
}
function validateDeltaPage(channel: string, value: CursorDeltaPage): void {
  if (!value || !Array.isArray(value.items) || value.items.length > MAX_DELTA_ITEMS || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 2_048)) || (value.sourceRevision !== null && (!Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0)) || typeof value.truncated !== 'boolean') throw new ContextRouterError('context.router-delta-invalid', `${channel} delta source returned an invalid page.`);
  for (const item of value.items) canonicalStringify(item);
}
function recoverableSourceDiagnostic(cause: unknown): Readonly<{ code: string; message: string }> | null {
  if (!cause || typeof cause !== 'object' || !('recoverable' in cause) || (cause as { recoverable?: unknown }).recoverable !== true || !('code' in cause) || typeof (cause as { code?: unknown }).code !== 'string') return null;
  return Object.freeze({ code: (cause as { code: string }).code, message: cause instanceof Error ? cause.message : 'Exact Scene diff is unavailable; a bounded snapshot was used.' });
}
function estimateTokens(bytes: number): number { return Math.max(1, Math.ceil(bytes / 4)); }
function encodeLogCursor(channel: string, sequence: number): string { const body = Buffer.from(canonicalStringify({ version: 1, channel, sequence })).toString('base64url'); return `${body}.${sha256(body).slice(0, 24)}`; }
function decodeLogCursor(value: string, channel: string): number {
  if (typeof value !== 'string' || value.length > 2_048) throw new ContextRouterError('context.delta-cursor-invalid', 'Operation Log context cursor is invalid.', true);
  const [body, signature, extra] = value.split('.'); if (!body || !signature || extra || signature !== sha256(body).slice(0, 24)) throw new ContextRouterError('context.delta-cursor-invalid', 'Operation Log context cursor failed integrity validation.', true);
  let parsed: unknown; try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new ContextRouterError('context.delta-cursor-invalid', 'Operation Log context cursor payload is invalid.', true); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1 || (parsed as { channel?: unknown }).channel !== channel || !Number.isSafeInteger((parsed as { sequence?: unknown }).sequence) || ((parsed as { sequence: number }).sequence < -1)) throw new ContextRouterError('context.delta-cursor-invalid', 'Operation Log context cursor fields are invalid.', true);
  return (parsed as { sequence: number }).sequence;
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new ContextRouterError('context.router-cancelled', 'Context routing was cancelled.', true); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
function isRecord(value: unknown): value is Record<string, JsonValue> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
