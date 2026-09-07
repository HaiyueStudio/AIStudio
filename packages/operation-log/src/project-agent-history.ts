import { mkdir, lstat, realpath, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { asStableId, type AgentHistoryDetailV1, type AgentHistoryPageV1, type AgentHistoryRecordV1, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify } from './canonical.js';
import { OperationLog, OperationLogError } from './operation-log.js';
import type { DurableOperationEvent } from './types.js';

export type ConversationOperationLog = Pick<OperationLog, 'append' | 'putArtifact' | 'readArtifact' | 'query' | 'status'>;
export interface ProjectAgentHistoryOptions {
  readonly projectId: StableId;
  readonly directory: string;
  readonly source: OperationLog;
  readonly storage: 'project' | 'unsaved';
}

/** A portable, non-evicting project replica of the existing journal and content-addressed artifacts. */
export class ProjectAgentHistory {
  readonly log: ConversationOperationLog;
  private journal!: OperationLog;
  private subscription: Readonly<{ dispose(): void }> | null = null;
  private readonly eventIds = new Set<string>();
  private readonly sessionIds = new Set<string>();
  private readonly records = new Map<StableId, AgentHistoryRecordV1>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private failure: unknown = null;

  private constructor(private options: ProjectAgentHistoryOptions) {
    this.log = Object.freeze({
      append: (input, appendOptions) => {
        this.assertOpen();
        return this.options.source.append({ ...input, correlation: { ...input.correlation, projectId: this.options.projectId } }, appendOptions);
      },
      putArtifact: (...args) => this.options.source.putArtifact(...args),
      readArtifact: (id) => this.options.source.readArtifact(id),
      query: (query) => this.journal.query(query),
      status: () => this.journal.status(),
    });
  }

  static async open(options: ProjectAgentHistoryOptions): Promise<ProjectAgentHistory> {
    asStableId(options.projectId);
    const history = new ProjectAgentHistory(options);
    try { await history.initialize(); return history; }
    catch (cause) { await history.dispose().catch(() => undefined); throw cause; }
  }

  private async initialize(): Promise<void> {
    this.journal = await openProjectJournal(this.options.directory, this.options.projectId);
    const local = await allEvents(this.journal);
    for (const event of local) {
      if (event.correlation.projectId !== this.options.projectId) throw new OperationLogError('project-history.project-mismatch', 'Project history contains an event owned by another project.');
      this.eventIds.add(event.eventId); this.index(event);
    }
    this.subscription = this.options.source.subscribeAppends(event => {
      this.learnSession(event);
      return this.belongs(event) ? this.scheduleCapture(event) : Promise.resolve();
    });
    // Import portable records before opening Session handles. Their per-session sequences and IDs remain intact.
    const global = await allEvents(this.options.source);
    const known = new Map(global.map(event => [event.eventId, event]));
    for (const event of local) {
      const existing = known.get(event.eventId);
      if (existing) {
        if (existing.payloadDigest !== event.payloadDigest || existing.kind !== event.kind) throw new OperationLogError('project-history.event-conflict', 'A project history event conflicts with the local journal.');
        continue;
      }
      await copyArtifacts(event, this.journal, this.options.source);
      await this.options.source.append(event);
      known.set(event.eventId, event);
    }
    // Learn ownership first: a historical projection may precede its durable Session creation.
    for (const event of global) this.learnSession(event);
    for (const event of global) if (this.belongs(event)) await this.scheduleCapture(event);
    await this.migrateLegacyRecords();
  }

  private async migrateLegacyRecords(): Promise<void> {
    const latest = new Map<string, DurableOperationEvent>();
    for (const event of await allEvents(this.journal)) if (event.kind === 'conversation/node-projected' && typeof event.payload.nodeId === 'string') latest.set(event.payload.nodeId, event);
    for (const [id, event] of latest) {
      if (this.records.has(asStableId(id)) || !event.artifactRefs[0]) continue;
      const node = (await this.journal.readArtifact(event.artifactRefs[0])).value;
      if (!isRecord(node) || !isRecord(node.content) || !isRecord(node.provenance) || typeof node.kind !== 'string' || typeof node.createdAt !== 'string') continue;
      const data = await this.options.source.putArtifact({ ...node.content, legacyRecord: true, captureNote: '旧版本只保存了当时的摘要；未记录的完整参数、返回值和耗时无法补齐。' } as JsonObject, { schemaVersion: 'agent-execution-data/1' });
      const record = parseHistoryRecord({ schemaVersion: 1, id, projectId: this.options.projectId, kind: node.kind, status: node.status, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId,
        toolId: typeof node.content.toolId === 'string' ? node.content.toolId : null, startedAt: node.createdAt, finishedAt: null, durationMs: null, dataArtifactId: data.id });
      await this.log.append({ kind: 'agent/execution-record', severity: 'info', source: asStableId('studio.project-history'), correlation: event.correlation, payload: { record: record as unknown as JsonObject }, artifactRefs: [data.id] });
    }
  }

  private scheduleCapture(event: DurableOperationEvent): Promise<void> {
    const write = this.tail.then(() => this.capture(event));
    this.tail = write.catch(cause => { this.failure ??= cause; });
    return write;
  }

  async flush(): Promise<void> {
    await this.options.source.flush();
    await this.tail;
    if (this.failure) throw this.failure;
    await this.journal.flush();
  }

  async relocate(directory: string): Promise<void> {
    this.assertOpen();
    if (path.resolve(directory) === path.resolve(this.options.directory)) return;
    const move = this.tail.then(async () => {
      const destination = await openProjectJournal(directory, this.options.projectId);
      try {
        const existing = new Set((await allEvents(destination)).map(event => event.eventId));
        for (const event of await allEvents(this.journal)) if (!existing.has(event.eventId)) {
          await copyArtifacts(event, this.journal, destination); await destination.append(event);
        }
        await destination.flush();
      } catch (cause) { await destination.close(); throw cause; }
      const previous = this.journal; this.journal = destination;
      this.options = { ...this.options, directory, storage: 'project' };
      await previous.close();
    });
    this.tail = move.catch(cause => { this.failure ??= cause; });
    await move;
  }

  async query(input: Readonly<{ cursor?: string; limit?: number }> = {}): Promise<AgentHistoryPageV1> {
    this.assertOpen(); await this.tail;
    if (this.failure) throw this.failure;
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('History page size must be 1-100.');
    const records = [...this.records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    let start = 0;
    if (input.cursor) {
      const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as unknown;
      if (!isRecord(cursor) || cursor.projectId !== this.options.projectId || typeof cursor.id !== 'string') throw new TypeError('History cursor belongs to another project or is invalid.');
      const index = records.findIndex(record => record.id === cursor.id); if (index < 0) throw new TypeError('History cursor is no longer available.');
      start = index + 1;
    }
    const page = records.slice(start, start + limit);
    return Object.freeze({ schemaVersion: 1, projectId: this.options.projectId, records: Object.freeze(page), total: records.length, storage: this.options.storage,
      nextCursor: start + page.length < records.length ? Buffer.from(JSON.stringify({ projectId: this.options.projectId, id: page.at(-1)!.id })).toString('base64url') : null });
  }

  async detail(id: StableId): Promise<AgentHistoryDetailV1> {
    this.assertOpen(); await this.tail;
    const record = this.records.get(asStableId(id));
    if (!record) throw new OperationLogError('project-history.record-not-found', 'This record does not belong to the open project.');
    return Object.freeze({ schemaVersion: 1, projectId: this.options.projectId, record, data: (await this.journal.readArtifact(record.dataArtifactId)).value });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.subscription?.dispose(); this.subscription = null;
    await this.tail; await this.journal?.close();
  }

  private async capture(event: DurableOperationEvent): Promise<void> {
    if (this.eventIds.has(event.eventId)) return;
    await copyArtifacts(event, this.options.source, this.journal);
    const copied = await this.journal.append({ ...event, correlation: { ...event.correlation, projectId: this.options.projectId } });
    this.eventIds.add(event.eventId); this.index(copied);
  }

  private learnSession(event: DurableOperationEvent): void {
    const op = event.payload.sessionOp;
    const projectId = isRecord(op) && op.kind === 'session.created' && isRecord(op.payload) ? op.payload.projectId : event.correlation.projectId;
    if (projectId === this.options.projectId && event.correlation.sessionId) this.sessionIds.add(event.correlation.sessionId);
  }

  private belongs(event: DurableOperationEvent): boolean {
    if (event.correlation.projectId) return event.correlation.projectId === this.options.projectId;
    return Boolean(event.correlation.sessionId && this.sessionIds.has(event.correlation.sessionId));
  }

  private index(event: DurableOperationEvent): void {
    this.learnSession(event);
    if (event.kind === 'agent/execution-record') {
      const record = parseHistoryRecord(event.payload.record);
      if (record.projectId !== this.options.projectId) throw new OperationLogError('project-history.project-mismatch', 'Execution record belongs to another project.');
      this.records.set(record.id, record);
    }
  }

  private assertOpen(): void { if (this.closed) throw new OperationLogError('project-history.closed', 'Project history is closed.'); }
}

export function parseHistoryRecord(value: unknown): AgentHistoryRecordV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'id', 'projectId', 'kind', 'status', 'sessionId', 'turnId', 'toolId', 'startedAt', 'finishedAt', 'durationMs', 'dataArtifactId'].includes(key))
    || typeof value.kind !== 'string' || !/^[a-z][a-z0-9.-]{0,95}$/u.test(value.kind)
    || !['pending', 'streaming', 'completed', 'failed', 'cancelled'].includes(String(value.status))
    || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
    || value.finishedAt !== null && (typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt)))
    || value.durationMs !== null && (!Number.isSafeInteger(value.durationMs) || Number(value.durationMs) < 0)
    || value.toolId !== null && typeof value.toolId !== 'string' || typeof value.dataArtifactId !== 'string' || !/^artifact:sha256:[a-f0-9]{64}$/u.test(value.dataArtifactId)) throw new OperationLogError('project-history.record-invalid', 'Unsupported or malformed execution record.');
  for (const key of ['id', 'projectId', 'sessionId', 'turnId', 'dataArtifactId']) { if (typeof value[key] !== 'string') throw new TypeError(`${key} is invalid.`); asStableId(value[key], key); }
  return Object.freeze(value) as unknown as AgentHistoryRecordV1;
}

async function openProjectJournal(directory: string, projectId: StableId): Promise<OperationLog> {
  if (!path.isAbsolute(directory)) throw new TypeError('Project history directory must be absolute.');
  // Validate every existing ancestor before creating anything beneath the chosen location.
  let ancestor = path.parse(directory).root;
  for (const component of path.relative(ancestor, path.resolve(directory)).split(path.sep)) {
    ancestor = path.join(ancestor, component);
    try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Project history may not traverse a symbolic link.'); }
    catch (cause) { if (!isRecord(cause) || cause.code !== 'ENOENT') throw cause; }
  }
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  async function rejectLinks(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Project history may not contain symbolic links.');
      if (entry.isDirectory()) await rejectLinks(path.join(folder, entry.name));
    }
  }
  await rejectLinks(root);
  const manifestPath = path.join(root, 'project-history.json');
  const manifest = { schemaVersion: 1, format: 'ai-studio-project-agent-history', projectId };
  try {
    const prior = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (canonicalStringify(prior) !== canonicalStringify(manifest)) throw new Error('Project history manifest does not match this project.');
  } catch (cause) {
    if (!isRecord(cause) || cause.code !== 'ENOENT') throw cause;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  }
  return OperationLog.open({ rootDirectory: root, appVersion: 'project-agent-history/1', flushPolicy: 'always', maxTotalBytes: Number.MAX_SAFE_INTEGER, retentionSegments: Number.MAX_SAFE_INTEGER });
}

async function allEvents(log: OperationLog): Promise<readonly DurableOperationEvent[]> {
  const status = log.status(); const events: DurableOperationEvent[] = [];
  for (let start = status.retainedFromSequence; start < status.nextSequence; start += 200) {
    const page = await log.query({ limit: 200, traverseCorrelation: false, ...(start > 0 ? { afterSequence: start - 1 } : {}), beforeSequence: Math.min(status.nextSequence, start + 200) });
    events.push(...page.events);
  }
  return events;
}

async function copyArtifacts(event: DurableOperationEvent, source: OperationLog, destination: OperationLog): Promise<void> {
  const visited = new Set<string>();
  async function copy(id: StableId, required: boolean): Promise<void> {
    if (visited.has(id)) return; visited.add(id);
    let artifact;
    try { artifact = await source.readArtifact(id); }
    catch (cause) { if (!required && cause instanceof OperationLogError && cause.code === 'artifact-missing') return; throw cause; }
    for (const nested of artifactIds(artifact.value)) await copy(nested, false);
    const stored = await destination.putArtifact(artifact.value, artifact.provenance);
    if (stored.id !== id) throw new Error('Project artifact digest changed while copying.');
  }
  for (const id of event.artifactRefs) await copy(id, true);
  for (const id of artifactIds(event.payload)) await copy(id, false);
}

function artifactIds(value: JsonValue): StableId[] {
  if (typeof value === 'string') return /^artifact:sha256:[a-f0-9]{64}$/u.test(value) ? [asStableId(value)] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(item => artifactIds(item));
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
