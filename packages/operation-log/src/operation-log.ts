import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { asStableId, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from './canonical.js';
import { assertNoHiddenReasoningKind, redactJson, redactObject } from './redaction.js';
import type {
  AppendOptions,
  ArtifactRecord,
  ArtifactPutResult,
  ArtifactReference,
  BugBundleOptions,
  BugBundleResult,
  DiagnosticsQueryService,
  DurableOperationEvent,
  LogViewerReadModel,
  OperationCorrelation,
  OperationEventInput,
  OperationLogDiagnostic,
  OperationLogHealth,
  OperationLogOptions,
  OperationLogQuery,
  OperationLogQueryPage,
  OperationLogStatus,
  OperationProvenance,
  SafeOperationSummary,
} from './types.js';

interface JournalRecordV1 {
  readonly recordVersion: 1;
  readonly event: DurableOperationEvent;
  readonly checksum: string;
}

interface StoredEvent {
  readonly segment: string;
  readonly event: DurableOperationEvent;
}

interface SegmentState {
  readonly name: string;
  bytes: number;
}

interface CursorPayload {
  readonly version: 1;
  readonly queryDigest: string;
  readonly afterSequence: number;
}

const DEFAULTS = Object.freeze({
  maxPayloadBytes: 64 * 1024,
  maxArtifactBytes: 512 * 1024,
  maxSegmentBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  retentionSegments: 8,
  maxQueryScan: 10_000,
});

const INDEX_CHECKPOINT_INTERVAL = 32;
const ATOMIC_RENAME_RETRY_DELAYS_MS = Object.freeze([5, 15, 40, 100]);

export class OperationLogError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OperationLogError';
  }
}

export class OperationLog {
  private readonly journalDirectory: string;
  private readonly indexDirectory: string;
  private readonly artifactDirectory: string;
  private readonly quarantineDirectory: string;
  private readonly clock: () => Date;
  private readonly makeEventId: (sequence: number) => StableId;
  private readonly flushPolicy: 'always' | 'manual';
  private readonly maxPayloadBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly maxSegmentBytes: number;
  private readonly maxTotalBytes: number;
  private readonly retentionSegments: number;
  private readonly maxQueryScan: number;
  private readonly faultInjector?: OperationLogOptions['faultInjector'];
  private readonly diagnostics: OperationLogDiagnostic[] = [];
  private readonly events: StoredEvent[] = [];
  private readonly segments: SegmentState[] = [];
  private appendTail: Promise<void> = Promise.resolve();
  private health: OperationLogHealth = 'healthy';
  private nextSequence = 0;
  private indexDirty = false;
  private closed = false;

  private constructor(private readonly options: OperationLogOptions) {
    this.journalDirectory = path.join(options.rootDirectory, 'journal');
    this.indexDirectory = path.join(options.rootDirectory, 'index');
    this.artifactDirectory = path.join(options.rootDirectory, 'artifacts', 'sha256');
    this.quarantineDirectory = path.join(options.rootDirectory, 'quarantine');
    this.clock = options.clock ?? (() => new Date());
    this.makeEventId = options.eventId ?? ((sequence) => asStableId(`event:${sequence}:${randomUUID()}`));
    this.flushPolicy = options.flushPolicy ?? 'always';
    this.maxPayloadBytes = positive(options.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes, 'maxPayloadBytes');
    this.maxArtifactBytes = positive(options.maxArtifactBytes ?? DEFAULTS.maxArtifactBytes, 'maxArtifactBytes');
    this.maxSegmentBytes = positive(options.maxSegmentBytes ?? DEFAULTS.maxSegmentBytes, 'maxSegmentBytes');
    this.maxTotalBytes = positive(options.maxTotalBytes ?? DEFAULTS.maxTotalBytes, 'maxTotalBytes');
    this.retentionSegments = positive(options.retentionSegments ?? DEFAULTS.retentionSegments, 'retentionSegments');
    this.maxQueryScan = positive(options.maxQueryScan ?? DEFAULTS.maxQueryScan, 'maxQueryScan');
    this.faultInjector = options.faultInjector;
  }

  static async open(options: OperationLogOptions): Promise<OperationLog> {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new OperationLogError('root-not-absolute', 'Operation Log rootDirectory must be an absolute app user-data path.');
    }
    if (!options.appVersion.trim()) throw new OperationLogError('app-version-required', 'Operation Log appVersion is required.');
    const log = new OperationLog(options);
    await log.initialize();
    return log;
  }

  status(): OperationLogStatus {
    const writable = !this.closed && (this.health === 'healthy' || this.health === 'recovered');
    return Object.freeze({
      health: this.closed ? 'closed' : this.health,
      canPersist: writable,
      allowsMutation: writable,
      allowsTrustedCode: writable,
      allowsRuntimeStart: writable,
      retainedFromSequence: this.events[0]?.event.sequence ?? this.nextSequence,
      nextSequence: this.nextSequence,
      eventCount: this.events.length,
      bytes: this.segments.reduce((sum, segment) => sum + segment.bytes, 0),
      segmentCount: this.segments.length,
      retainedFileHandles: 0,
      diagnostics: Object.freeze(this.diagnostics.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  append(input: OperationEventInput, options: AppendOptions = {}): Promise<DurableOperationEvent> {
    let resolveResult!: (event: DurableOperationEvent) => void;
    let rejectResult!: (cause: unknown) => void;
    const result = new Promise<DurableOperationEvent>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.appendTail = this.appendTail.then(async () => {
      try { resolveResult(await this.appendInternal(input, options)); }
      catch (cause) { rejectResult(cause); }
    });
    return result;
  }

  async flush(): Promise<void> {
    this.assertOpen();
    await this.appendTail;
    const active = this.activeSegment();
    const handle = await open(path.join(this.journalDirectory, active.name), 'a');
    try { await handle.sync(); }
    finally { await handle.close(); }
    await this.checkpointIndex('index-flush-failed', 'Derived index flush failed');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.appendTail;
    if (this.flushPolicy === 'manual' && this.segments.length > 0) await this.flush();
    else await this.checkpointIndex('index-close-failed', 'Derived index close checkpoint failed');
    this.closed = true;
    this.health = 'closed';
  }

  async putArtifact(
    value: JsonValue,
    provenance: Partial<OperationProvenance> = {},
    redaction: { readonly fields?: readonly string[]; readonly taintedFields?: readonly string[] } = {},
  ): Promise<ArtifactReference> {
    return (await this.putArtifactDetailed(value, provenance, redaction)).reference;
  }

  async putArtifactDetailed(
    value: JsonValue,
    provenance: Partial<OperationProvenance> = {},
    redaction: { readonly fields?: readonly string[]; readonly taintedFields?: readonly string[] } = {},
  ): Promise<ArtifactPutResult> {
    this.assertWritable();
    const normalized = redactJson(value, redaction);
    const serializedValue = canonicalStringify(normalized.value);
    const bytes = Buffer.byteLength(serializedValue);
    if (bytes > this.maxArtifactBytes) {
      throw new OperationLogError('artifact-too-large', `Artifact is ${bytes} bytes; maximum is ${this.maxArtifactBytes}.`);
    }
    const digest = sha256(serializedValue);
    const id = asStableId(`artifact:sha256:${digest}`);
    try {
      const existing = await this.readArtifact(id);
      return Object.freeze({ reference: artifactReference(existing), localHit: true });
    } catch (cause) {
      if (!(cause instanceof OperationLogError) || cause.code !== 'artifact-missing') throw cause;
    }
    const record: ArtifactRecord = Object.freeze({
      schemaVersion: 1,
      id,
      digest,
      mediaType: 'application/json',
      bytes,
      createdAt: this.clock().toISOString(),
      provenance: this.normalizeProvenance(provenance),
      redactedFields: normalized.redactedFields,
      value: normalized.value,
    });
    const body = `${canonicalStringify(record as unknown as Readonly<Record<string, unknown>>)}\n`;
    await this.faultInjector?.('before-artifact-write', Buffer.byteLength(body));
    await atomicWrite(path.join(this.artifactDirectory, `${digest}.json`), body);
    return Object.freeze({ reference: artifactReference(record), localHit: false });
  }

  async readArtifact(id: StableId): Promise<ArtifactRecord> {
    this.assertOpen();
    const digest = artifactDigest(id);
    let raw: string;
    try { raw = await readFile(path.join(this.artifactDirectory, `${digest}.json`), 'utf8'); }
    catch (cause) { throw new OperationLogError('artifact-missing', `Approved artifact ${id} is unavailable.`, { cause }); }
    const parsed = JSON.parse(raw) as ArtifactRecord;
    const actual = sha256(canonicalStringify(parsed.value));
    if (actual !== digest || parsed.digest !== digest || parsed.id !== id) {
      throw new OperationLogError('artifact-checksum-mismatch', `Artifact ${id} failed integrity validation.`);
    }
    return Object.freeze(parsed);
  }

  diagnosticsService(approvedArtifactIds: ReadonlySet<StableId> = new Set()): DiagnosticsQueryService {
    return Object.freeze({
      query: (query: OperationLogQuery) => this.query(query),
      safeSummaries: async (query: OperationLogQuery) => (await this.query(query)).events.map(toSafeSummary),
      readApprovedArtifact: async (id: StableId) => {
        if (!approvedArtifactIds.has(id)) throw new OperationLogError('artifact-not-approved', `Artifact ${id} is not approved for diagnostics.`);
        return this.readArtifact(id);
      },
    });
  }

  async query(query: OperationLogQuery): Promise<OperationLogQueryPage> {
    this.assertOpen();
    validateQuery(query);
    const normalizedForDigest = compactRecord({ ...query, cursor: undefined });
    const queryDigest = sha256(canonicalStringify(normalizedForDigest));
    const cursor = query.cursor ? decodeCursor(query.cursor, queryDigest) : undefined;
    const after = Math.max(query.afterSequence ?? -1, cursor?.afterSequence ?? -1);
    const start = firstIndexAfterSequence(this.events, after);
    const before = query.beforeSequence;
    const end = before === undefined ? this.events.length : Math.max(start, firstIndexAtOrAfterSequence(this.events, before));
    const scanned = end - start;
    if (scanned > this.maxQueryScan) {
      throw new OperationLogError('query-scan-budget-exceeded', `Query window contains ${scanned} retained events; scan budget is ${this.maxQueryScan}. Add a sequence window.`);
    }
    let candidates = this.events.slice(start, end).map((entry) => entry.event);
    const direct = candidates.filter((event) => matchesQuery(event, query));
    if (query.traverseCorrelation && hasCorrelationFilter(query)) {
      const related = new Set(direct);
      const ids = new Set(direct.flatMap((event) => Object.values(event.correlation)));
      let changed = true;
      while (changed) {
        changed = false;
        for (const event of candidates) {
          if (related.has(event)) continue;
          if (Object.values(event.correlation).some((id) => ids.has(id))) {
            related.add(event);
            Object.values(event.correlation).forEach((id) => ids.add(id));
            changed = true;
          }
        }
      }
      candidates = [...related].sort((left, right) => left.sequence - right.sequence);
    } else {
      candidates = direct;
    }
    const pageEvents = candidates.slice(0, query.limit);
    const nextCursor = candidates.length > query.limit && pageEvents.length > 0
      ? encodeCursor({ version: 1, queryDigest, afterSequence: pageEvents.at(-1)!.sequence })
      : undefined;
    return Object.freeze({ events: Object.freeze(pageEvents), nextCursor, scanned });
  }

  async logViewer(query: OperationLogQuery): Promise<LogViewerReadModel> {
    const page = await this.query(query);
    const counts = { debug: 0, info: 0, warning: 0, error: 0 };
    for (const event of page.events) counts[event.severity] += 1;
    return Object.freeze({
      events: Object.freeze(page.events.map(toSafeSummary)),
      counts: Object.freeze(counts),
      nextCursor: page.nextCursor,
      status: this.status(),
    });
  }

  async exportBugBundle(options: BugBundleOptions): Promise<BugBundleResult> {
    this.assertOpen();
    if (!path.isAbsolute(options.destinationRoot)) throw new OperationLogError('bundle-root-not-absolute', 'Bug bundle destination must be absolute.');
    const stamp = this.clock().toISOString().replace(/[:.]/g, '-');
    const directory = path.join(options.destinationRoot, `haiyue-bug-bundle-${stamp}`);
    const artifactOut = path.join(directory, 'artifacts');
    await mkdir(artifactOut, { recursive: true });
    const page = await this.query(options.query);
    const eventLines = page.events.map((event) => canonicalStringify(redactJson(event as unknown as JsonValue).value)).join('\n');
    const eventsBody = eventLines ? `${eventLines}\n` : '';
    await atomicWrite(path.join(directory, 'events.jsonl'), eventsBody);
    const files: { path: string; bytes: number; sha256: string }[] = [fileEntry('events.jsonl', eventsBody)];
    for (const id of options.artifactIds ?? []) {
      const artifact = await this.readArtifact(id);
      const safe = redactJson(artifact as unknown as JsonValue).value;
      const body = `${canonicalStringify(safe)}\n`;
      const relative = `artifacts/${artifact.digest}.json`;
      await atomicWrite(path.join(directory, ...relative.split('/')), body);
      files.push(fileEntry(relative, body));
    }
    const manifest = {
      schemaVersion: 1,
      createdAt: this.clock().toISOString(),
      versions: options.versions,
      queryDigest: sha256(canonicalStringify(compactRecord({ ...options.query, cursor: undefined }))),
      eventCount: page.events.length,
      artifactCount: options.artifactIds?.length ?? 0,
      contents: files,
    } as const;
    const manifestBody = `${canonicalStringify(manifest as unknown as Readonly<Record<string, unknown>>)}\n`;
    await atomicWrite(path.join(directory, 'manifest.json'), manifestBody);
    files.unshift(fileEntry('manifest.json', manifestBody));
    const contentDigest = sha256(canonicalStringify(files as unknown as JsonValue));
    const contentsBody = `${canonicalStringify({ schemaVersion: 1, contentDigest, files } as unknown as Readonly<Record<string, unknown>>)}\n`;
    await atomicWrite(path.join(directory, 'contents.json'), contentsBody);
    files.push(fileEntry('contents.json', contentsBody));
    return Object.freeze({
      directory,
      eventCount: page.events.length,
      artifactCount: options.artifactIds?.length ?? 0,
      contentDigest,
      files: Object.freeze(files.map((entry) => Object.freeze(entry))),
    });
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.journalDirectory, { recursive: true }),
      mkdir(this.indexDirectory, { recursive: true }),
      mkdir(this.artifactDirectory, { recursive: true }),
      mkdir(this.quarantineDirectory, { recursive: true }),
    ]);
    const names = (await readdir(this.journalDirectory))
      .filter((name) => /^segment-\d{6}\.jsonl$/.test(name))
      .sort();
    if (names.length === 0) {
      const name = segmentName(1);
      await writeFile(path.join(this.journalDirectory, name), '', { flag: 'wx' });
      names.push(name);
    }
    let previousSequence: number | undefined;
    let stopAt = names.length;
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      const file = path.join(this.journalDirectory, name);
      const contents = await readFile(file);
      this.segments.push({ name, bytes: contents.byteLength });
      let offset = 0;
      while (offset < contents.byteLength) {
        const newline = contents.indexOf(0x0a, offset);
        if (newline < 0) {
          await this.quarantineTail(name, contents, offset, 'partial-tail', 'A partial journal tail was isolated during recovery.', false);
          this.segments.at(-1)!.bytes = offset;
          this.health = 'recovered';
          break;
        }
        const lineStart = offset;
        const line = contents.subarray(offset, newline).toString('utf8');
        offset = newline + 1;
        if (!line.trim()) continue;
        try {
          const event = parseJournalLine(line);
          if (previousSequence !== undefined && event.sequence !== previousSequence + 1) {
            throw new OperationLogError('sequence-discontinuity', `Expected sequence ${previousSequence + 1}, received ${event.sequence}.`);
          }
          previousSequence = event.sequence;
          this.events.push({ segment: name, event });
          this.nextSequence = Math.max(this.nextSequence, event.sequence + 1);
        } catch (cause) {
          const code = cause instanceof OperationLogError ? cause.code : 'corrupt-tail';
          await this.quarantineTail(name, contents, lineStart, code, errorMessage(cause), true);
          this.segments.at(-1)!.bytes = lineStart;
          this.health = 'degraded';
          stopAt = index + 1;
          break;
        }
      }
      if (this.health === 'degraded') break;
    }
    for (const name of names.slice(stopAt)) {
      const source = path.join(this.journalDirectory, name);
      const targetName = `${name}.${this.clock().getTime()}.quarantine`;
      await rename(source, path.join(this.quarantineDirectory, targetName));
      this.diagnostics.push(Object.freeze({
        code: 'segment-after-corruption', severity: 'error', segment: name, quarantineFile: targetName,
        message: 'A segment after the corrupt tail was quarantined to preserve sequence integrity.',
      }));
    }
    this.segments.splice(stopAt);
    if (this.segments.length === 0) {
      const name = segmentName(1);
      await writeFile(path.join(this.journalDirectory, name), '', { flag: 'wx' });
      this.segments.push({ name, bytes: 0 });
    }
    this.indexDirty = true;
    await this.checkpointIndex('index-rebuild-failed', 'Derived index rebuild failed');
  }

  private async appendInternal(input: OperationEventInput, options: AppendOptions): Promise<DurableOperationEvent> {
    this.assertWritable();
    throwIfAborted(options.signal);
    assertNoHiddenReasoningKind(input.kind);
    if (!/^[a-z][a-z0-9./-]{2,95}$/.test(input.kind)) throw new OperationLogError('invalid-event-kind', `Invalid event kind ${input.kind}.`);
    asStableId(input.source, 'event source');
    const sequence = this.nextSequence;
    const redacted = redactObject(input.payload, input.redaction);
    const payloadBody = canonicalStringify(redacted.value);
    const payloadBytes = Buffer.byteLength(payloadBody);
    if (payloadBytes > this.maxPayloadBytes) {
      throw new OperationLogError('payload-too-large', `Payload is ${payloadBytes} bytes; maximum is ${this.maxPayloadBytes}.`);
    }
    const artifactRefs = Object.freeze([...(input.artifactRefs ?? [])]);
    for (const artifactId of artifactRefs) await this.readArtifact(artifactId);
    throwIfAborted(options.signal);
    const event: DurableOperationEvent = Object.freeze({
      schemaVersion: 1,
      eventId: input.eventId ? asStableId(input.eventId, 'event id') : this.makeEventId(sequence),
      sequence,
      timestamp: normalizeTimestamp(input.timestamp ?? this.clock().toISOString()),
      kind: input.kind,
      severity: input.severity,
      source: input.source,
      correlation: Object.freeze(normalizeCorrelation(input.correlation ?? {})),
      payload: Object.freeze(redacted.value),
      payloadDigest: sha256(payloadBody),
      redactedFields: redacted.redactedFields,
      provenance: this.normalizeProvenance(input.provenance ?? {}),
      artifactRefs,
    });
    const base = { recordVersion: 1 as const, event };
    const record: JournalRecordV1 = Object.freeze({ ...base, checksum: sha256(canonicalStringify(base as unknown as Readonly<Record<string, unknown>>)) });
    const body = `${canonicalStringify(record as unknown as Readonly<Record<string, unknown>>)}\n`;
    const bytes = Buffer.byteLength(body);
    await this.rotateIfNeeded(bytes);
    await this.enforceQuota(bytes);
    const segment = this.activeSegment();
    try {
      await this.faultInjector?.('before-journal-write', bytes);
      const handle = await open(path.join(this.journalDirectory, segment.name), 'a');
      try {
        await handle.write(body);
        if (this.flushPolicy === 'always') await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (cause) {
      this.health = isQuotaError(cause) ? 'backpressure' : 'degraded';
      this.addDiagnostic('journal-write-failed', 'error', `Journal append failed at sequence ${sequence}: ${errorMessage(cause)}`, sequence, segment.name);
      throw new OperationLogError('journal-write-failed', 'Durable journal append failed; protected operations are disabled.', { cause });
    }
    segment.bytes += bytes;
    this.events.push({ segment: segment.name, event });
    this.nextSequence += 1;
    this.indexDirty = true;
    if (this.nextSequence % INDEX_CHECKPOINT_INTERVAL === 0) {
      await this.checkpointIndex('index-write-failed', 'Derived index checkpoint failed after durable append', sequence, segment.name);
    }
    return event;
  }

  private normalizeProvenance(value: Partial<OperationProvenance>): OperationProvenance {
    const upstream = value.upstream ? Object.freeze(Object.fromEntries(Object.entries(value.upstream).sort())) : undefined;
    return Object.freeze(compactRecord({
      appVersion: value.appVersion ?? this.options.appVersion,
      schemaVersion: value.schemaVersion ?? 'operation-event/1',
      pluginVersion: value.pluginVersion,
      backendId: value.backendId,
      upstream,
    }) as unknown as OperationProvenance);
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    const active = this.activeSegment();
    if (active.bytes === 0 || active.bytes + incomingBytes <= this.maxSegmentBytes) return;
    const next = segmentName(segmentNumber(active.name) + 1);
    await writeFile(path.join(this.journalDirectory, next), '', { flag: 'wx' });
    this.segments.push({ name: next, bytes: 0 });
    while (this.segments.length > this.retentionSegments) await this.removeOldestSegment('retention');
  }

  private async enforceQuota(incomingBytes: number): Promise<void> {
    while (this.totalBytes() + incomingBytes > this.maxTotalBytes && this.segments.length > 1) {
      await this.removeOldestSegment('quota-rotation');
    }
    if (this.totalBytes() + incomingBytes > this.maxTotalBytes) {
      this.health = 'backpressure';
      this.addDiagnostic('quota-exceeded', 'error', `Journal quota ${this.maxTotalBytes} bytes is exhausted.`);
      throw new OperationLogError('quota-exceeded', 'Journal quota is exhausted; protected operations are disabled.');
    }
  }

  private async removeOldestSegment(reason: string): Promise<void> {
    const oldest = this.segments[0];
    if (!oldest || oldest === this.activeSegment()) return;
    await unlink(path.join(this.journalDirectory, oldest.name));
    this.segments.shift();
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index]!.segment === oldest.name) this.events.splice(index, 1);
    }
    this.addDiagnostic('segment-retired', 'warning', `Segment ${oldest.name} was retired by ${reason}.`, undefined, oldest.name);
  }

  private async writeIndex(): Promise<void> {
    const rows = this.events.map(({ segment, event }) => ({
      sequence: event.sequence,
      eventId: event.eventId,
      timestamp: event.timestamp,
      kind: event.kind,
      severity: event.severity,
      source: event.source,
      correlation: event.correlation,
      payloadDigest: event.payloadDigest,
      segment,
    }));
    const body = `${canonicalStringify({ schemaVersion: 1, rows } as unknown as Readonly<Record<string, unknown>>)}\n`;
    await this.faultInjector?.('before-index-write', Buffer.byteLength(body));
    await atomicWrite(path.join(this.indexDirectory, 'events-v1.json'), body);
    this.indexDirty = false;
  }

  private async checkpointIndex(code: string, message: string, sequence?: number, segment?: string): Promise<void> {
    if (!this.indexDirty) return;
    try { await this.writeIndex(); }
    catch (cause) {
      // The journal is the durable source of truth and the index is rebuilt on open.
      // A transient index replacement failure must not disable protected operations.
      if (this.health === 'healthy') this.health = 'recovered';
      this.addDiagnostic(code, 'warning', `${message}: ${errorMessage(cause)}`, sequence, segment);
    }
  }

  private async quarantineTail(
    segment: string,
    contents: Buffer,
    offset: number,
    code: string,
    message: string,
    integrityFailure: boolean,
  ): Promise<void> {
    const quarantineFile = `${segment}.${this.clock().getTime()}.${code}.bin`;
    await writeFile(path.join(this.quarantineDirectory, quarantineFile), contents.subarray(offset), { flag: 'wx' });
    await truncate(path.join(this.journalDirectory, segment), offset);
    this.diagnostics.push(Object.freeze({
      code,
      severity: integrityFailure ? 'error' : 'warning',
      message,
      segment,
      quarantineFile,
    }));
  }

  private addDiagnostic(code: string, severity: 'warning' | 'error', message: string, sequence?: number, segment?: string): void {
    this.diagnostics.push(Object.freeze(compactRecord({ code, severity, message, sequence, segment }) as unknown as OperationLogDiagnostic));
  }

  private activeSegment(): SegmentState {
    const segment = this.segments.at(-1);
    if (!segment) throw new OperationLogError('journal-not-initialized', 'Journal has no active segment.');
    return segment;
  }

  private totalBytes(): number { return this.segments.reduce((sum, segment) => sum + segment.bytes, 0); }

  private assertOpen(): void {
    if (this.closed) throw new OperationLogError('log-closed', 'Operation Log is closed.');
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.health !== 'healthy' && this.health !== 'recovered') {
      throw new OperationLogError('log-unavailable', `Operation Log health is ${this.health}; protected operations are disabled.`);
    }
  }
}

function parseJournalLine(line: string): DurableOperationEvent {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch (cause) { throw new OperationLogError('corrupt-json', 'Journal tail contains invalid JSON.', { cause }); }
  if (!value || typeof value !== 'object') throw new OperationLogError('invalid-record', 'Journal record must be an object.');
  const raw = value as Record<string, unknown>;
  if (raw.recordVersion === 0) return migrateLegacyEvent(raw.event);
  if (raw.recordVersion !== 1 || typeof raw.checksum !== 'string' || !raw.event || typeof raw.event !== 'object') {
    throw new OperationLogError('unsupported-record-version', 'Journal record version is unsupported.');
  }
  const expected = sha256(canonicalStringify({ recordVersion: 1, event: raw.event }));
  if (expected !== raw.checksum) throw new OperationLogError('checksum-mismatch', 'Journal record checksum mismatch.');
  const event = raw.event as unknown as DurableOperationEvent;
  validateRecoveredEvent(event);
  return Object.freeze(event);
}

function migrateLegacyEvent(value: unknown): DurableOperationEvent {
  if (!value || typeof value !== 'object') throw new OperationLogError('legacy-record-invalid', 'Legacy journal event is invalid.');
  const raw = value as Record<string, unknown>;
  const payload = (raw.payload ?? {}) as JsonObject;
  const event = {
    schemaVersion: 1,
    eventId: raw.eventId,
    sequence: raw.sequence,
    timestamp: raw.timestamp,
    kind: raw.kind,
    severity: raw.severity,
    source: raw.source,
    correlation: raw.correlation ?? {},
    payload,
    payloadDigest: sha256(canonicalStringify(payload)),
    redactedFields: raw.redactedFields ?? [],
    provenance: { appVersion: 'legacy', schemaVersion: 'operation-event/0' },
    artifactRefs: [],
  } as unknown as DurableOperationEvent;
  validateRecoveredEvent(event);
  return Object.freeze(event);
}

function validateRecoveredEvent(event: DurableOperationEvent): void {
  if (event.schemaVersion !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    throw new OperationLogError('invalid-event-envelope', 'Recovered event envelope is invalid.');
  }
  asStableId(event.eventId, 'event id');
  asStableId(event.source, 'event source');
  normalizeTimestamp(event.timestamp);
  if (sha256(canonicalStringify(event.payload)) !== event.payloadDigest) {
    throw new OperationLogError('payload-digest-mismatch', 'Recovered event payload digest mismatch.');
  }
}

function validateQuery(query: OperationLogQuery): void {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) {
    throw new OperationLogError('query-limit-invalid', 'Operation Log query limit must be between 1 and 200.');
  }
  for (const value of [query.afterSequence, query.beforeSequence]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new OperationLogError('query-sequence-invalid', 'Sequence windows must be non-negative integers.');
  }
  for (const kind of query.kinds ?? []) {
    if (!/^[a-z][a-z0-9./-]{2,95}$/.test(kind)) throw new OperationLogError('query-kind-invalid', `Invalid exact event kind ${kind}.`);
  }
  if (query.afterTime) normalizeTimestamp(query.afterTime);
  if (query.beforeTime) normalizeTimestamp(query.beforeTime);
}

function firstIndexAfterSequence(events: readonly StoredEvent[], sequence: number): number {
  let low = 0; let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (events[middle]!.event.sequence <= sequence) low = middle + 1; else high = middle;
  }
  return low;
}

function firstIndexAtOrAfterSequence(events: readonly StoredEvent[], sequence: number): number {
  let low = 0; let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (events[middle]!.event.sequence < sequence) low = middle + 1; else high = middle;
  }
  return low;
}

function matchesQuery(event: DurableOperationEvent, query: OperationLogQuery): boolean {
  if (query.beforeSequence !== undefined && event.sequence >= query.beforeSequence) return false;
  if (query.afterTime && event.timestamp <= query.afterTime) return false;
  if (query.beforeTime && event.timestamp >= query.beforeTime) return false;
  if (query.severity && !query.severity.includes(event.severity)) return false;
  if (query.kinds && !query.kinds.includes(event.kind)) return false;
  for (const key of correlationQueryKeys) {
    const expected = query[key];
    if (expected !== undefined && event.correlation[key] !== expected) return false;
  }
  return true;
}

const correlationQueryKeys = [
  'sessionId', 'projectId', 'turnId', 'stepId', 'toolCallId', 'approvalId', 'commandId',
  'transactionId', 'documentId', 'entityId', 'pluginId', 'scriptId', 'previewId',
] as const;

function hasCorrelationFilter(query: OperationLogQuery): boolean {
  return correlationQueryKeys.some((key) => query[key] !== undefined);
}

function toSafeSummary(event: DurableOperationEvent): SafeOperationSummary {
  return Object.freeze({
    sequence: event.sequence,
    eventId: event.eventId,
    timestamp: event.timestamp,
    kind: event.kind,
    severity: event.severity,
    source: event.source,
    correlation: event.correlation,
    payloadDigest: event.payloadDigest,
    redactedFieldCount: event.redactedFields.length,
  });
}

function normalizeCorrelation(value: OperationCorrelation): OperationCorrelation {
  const result: Record<string, StableId> = {};
  for (const [key, id] of Object.entries(value)) {
    if (id !== undefined) result[key] = asStableId(id, `correlation ${key}`);
  }
  return result as OperationCorrelation;
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new OperationLogError('timestamp-invalid', `Timestamp must be canonical ISO-8601: ${value}`);
  }
  return value;
}

function artifactDigest(id: StableId): string {
  const match = /^artifact:sha256:([0-9a-f]{64})$/.exec(id);
  if (!match) throw new OperationLogError('artifact-id-invalid', `Invalid artifact id ${id}.`);
  return match[1]!;
}

function artifactReference(record: ArtifactRecord): ArtifactReference {
  const { value: _value, ...reference } = record;
  return Object.freeze(reference);
}

function encodeCursor(value: CursorPayload): string {
  return Buffer.from(canonicalStringify(value as unknown as Readonly<Record<string, unknown>>)).toString('base64url');
}

function decodeCursor(value: string, queryDigest: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CursorPayload;
    if (parsed.version !== 1 || parsed.queryDigest !== queryDigest || !Number.isSafeInteger(parsed.afterSequence)) throw new Error('invalid');
    return parsed;
  } catch (cause) {
    throw new OperationLogError('query-cursor-invalid', 'Query cursor is invalid or belongs to another query.', { cause });
  }
}

function compactRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined));
}

function fileEntry(relativePath: string, body: string): { path: string; bytes: number; sha256: string } {
  return { path: relativePath, bytes: Buffer.byteLength(body), sha256: sha256(body) };
}

async function atomicWrite(target: string, body: string): Promise<void> {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, target);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(source, target); return; }
    catch (cause) {
      if (!isTransientRenameError(cause) || attempt >= ATOMIC_RENAME_RETRY_DELAYS_MS.length) throw cause;
      await new Promise((resolve) => setTimeout(resolve, ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function isTransientRenameError(value: unknown): boolean {
  const code = value instanceof Error && 'code' in value ? (value as NodeJS.ErrnoException).code : undefined;
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM';
}

function segmentName(number: number): string { return `segment-${String(number).padStart(6, '0')}.jsonl`; }
function segmentNumber(name: string): number { return Number(/^segment-(\d{6})\.jsonl$/.exec(name)?.[1] ?? 0); }
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new OperationLogError('option-invalid', `${name} must be a positive integer.`);
  return value;
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationLogError('append-cancelled', 'Operation Log append was cancelled.', { cause: signal.reason });
}
function isQuotaError(value: unknown): boolean {
  return value instanceof OperationLogError && value.code === 'quota-exceeded'
    || (value instanceof Error && 'code' in value && (value as NodeJS.ErrnoException).code === 'ENOSPC');
}
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
