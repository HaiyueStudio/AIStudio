import { randomUUID } from 'node:crypto';
import {
  asStableId,
  type BackendSessionBindingV1,
  type JsonObject,
  type JsonValue,
  type M13StableId,
  type SessionCheckpointV1,
  type SessionOpV1,
  type StableId,
  type SurfaceOpV1,
} from '@haiyue/ai-studio-contracts';
import { canonicalStringify, redactObject, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import { AgentSessionError } from './error.js';
import { projectSession } from './projection.js';
import type {
  AppendSessionMessageInput,
  AppendSessionOpInput,
  CreateSessionInput,
  DurableSessionHandle,
  ForkSessionInput,
  OpenSessionOptions,
  ReplaceModelSurfaceInput,
  SessionForkSeedV1,
  SessionReplaySnapshotV1,
  SessionRuntimeOptions,
} from './types.js';
import { deepFreeze, digestJson, isRecord, isStableId, isTimestamp, parsePersistedSessionOp, validateBackendBinding, validateSessionOp } from './validation.js';

const SESSION_SOURCE = asStableId('studio.agent-session');
const SESSION_EVENT_KIND = 'agent/session-op';

export class DurableSessionRuntime {
  private readonly clock: () => Date;
  private readonly idFactory: NonNullable<SessionRuntimeOptions['idFactory']>;
  private readonly queryWindow: number;
  private readonly tails = new Map<M13StableId, Promise<void>>();
  private idIndex = 0;
  private state: 'active' | 'disposing' | 'disposed' = 'active';

  constructor(private readonly log: OperationLog, options: SessionRuntimeOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((kind) => `${kind}:${randomUUID()}`);
    this.queryWindow = options.queryWindow ?? 128;
    if (!Number.isSafeInteger(this.queryWindow) || this.queryWindow < 1 || this.queryWindow > 200) throw new AgentSessionError('session.query-window-invalid', 'Session replay queryWindow must be between 1 and 200.');
  }

  async create(input: CreateSessionInput): Promise<DurableSessionHandle> {
    this.assertActive();
    const sessionId = this.stable(input.id ?? this.nextId('session'), 'session id');
    await this.enqueue(sessionId, async () => {
      const existing = await this.readOps(sessionId);
      if (existing.ops.length > 0) throw new AgentSessionError('session.duplicate', `Session ${sessionId} already exists.`);
      const op = this.makeOp(sessionId, 0, {
        kind: 'session.created',
        payload: deepFreeze({ projectId: nullableId(input.projectId, 'project id'), documentId: nullableId(input.documentId, 'document id'), activeGoal: nullableText(input.activeGoal, 32_768, 'active goal'), taskBudgetId: nullableId(input.taskBudgetId, 'task budget id') }),
      });
      await this.persist(op);
    });
    return new SessionHandle(this, sessionId);
  }

  async open(sessionId: M13StableId, options: OpenSessionOptions = {}): Promise<DurableSessionHandle> {
    this.assertActive();
    const id = this.stable(sessionId, 'session id');
    const snapshot = await this.replay(id);
    if (options.repairOpenOperations !== false) await this.repairOpenOperations(snapshot);
    return new SessionHandle(this, id);
  }

  async replay(sessionId: M13StableId, throughSequence?: number): Promise<SessionReplaySnapshotV1> {
    this.assertActive();
    const id = this.stable(sessionId, 'session id');
    await (this.tails.get(id) ?? Promise.resolve());
    return this.replayNow(id, throughSequence);
  }

  async append(sessionId: M13StableId, input: AppendSessionOpInput): Promise<SessionReplaySnapshotV1> {
    this.assertActive();
    const id = this.stable(sessionId, 'session id');
    return this.enqueue(id, async () => this.appendFromSnapshot(await this.replayNow(id), input));
  }

  async appendMessage(sessionId: M13StableId, input: AppendSessionMessageInput): Promise<SessionReplaySnapshotV1> {
    this.assertActive();
    if (typeof input.content !== 'string' || input.content.length === 0) throw new AgentSessionError('session.message-invalid', 'Session message content is required.');
    const id = this.stable(sessionId, 'session id');
    return this.enqueue(id, async () => {
      const snapshot = await this.replayNow(id);
      const artifact = await this.log.putArtifact({ schemaVersion: 1, kind: 'session-message', role: input.role, content: input.content }, { schemaVersion: 'agent-session-message/1' });
      const opId = this.nextUniqueId('op', new Set(snapshot.ops.map((op) => op.id)));
      const surfaceId = this.nextUniqueId('surface-node', new Set(snapshot.surface.nodes.map((node) => node.id)));
      const surfaceOperation: SurfaceOpV1 = deepFreeze({ op: 'append', id: surfaceId, sourceOpIds: Object.freeze([opId]), messageArtifactId: artifact.id, role: input.role });
      return this.appendFromSnapshot(snapshot, {
        id: opId,
        kind: input.role === 'user' ? 'user.message' : 'assistant.message',
        turnId: input.turnId ?? null,
        stepId: input.stepId ?? null,
        projectRevision: input.projectRevision ?? null,
        artifactRefs: [artifact.id],
        payload: { surfaceOperation: surfaceOperation as unknown as JsonValue },
      });
    });
  }

  async replaceSurface(sessionId: M13StableId, input: ReplaceModelSurfaceInput): Promise<SessionReplaySnapshotV1> {
    this.assertActive();
    if (typeof input.summary !== 'string' || input.summary.length === 0) throw new AgentSessionError('surface.summary-invalid', 'Surface replacement summary is required.');
    const id = this.stable(sessionId, 'session id');
    return this.enqueue(id, async () => {
      const snapshot = await this.replayNow(id);
      const start = snapshot.surface.nodes.findIndex((node) => node.id === input.startNodeId);
      const end = snapshot.surface.nodes.findIndex((node) => node.id === input.endNodeId);
      if (start < 0 || end < start) throw new AgentSessionError('surface.replace-range-invalid', 'Surface replacement range is invalid.');
      const sourceOpIds = unique(snapshot.surface.nodes.slice(start, end + 1).flatMap((node) => node.replacedSourceOpIds.length > 0 ? [...node.replacedSourceOpIds] : [node.originOpId])).sort();
      const artifact = await this.log.putArtifact({ schemaVersion: 1, kind: 'surface-summary', role: 'assistant', content: input.summary }, { schemaVersion: 'agent-surface-summary/1' });
      const surfaceOperation: SurfaceOpV1 = deepFreeze({ op: 'replace', id: this.nextUniqueId('surface-node', new Set(snapshot.surface.nodes.map((node) => node.id))), sourceOpIds: Object.freeze(sourceOpIds), startNodeId: input.startNodeId, endNodeId: input.endNodeId, replacementArtifactId: artifact.id, reason: input.reason });
      return this.appendFromSnapshot(snapshot, {
        kind: 'compaction.summary-created', turnId: input.turnId ?? null, projectRevision: input.projectRevision ?? null,
        artifactRefs: [artifact.id], payload: { surfaceOperation: surfaceOperation as unknown as JsonValue },
      });
    });
  }

  async bindBackend(sessionId: M13StableId, binding: BackendSessionBindingV1): Promise<SessionReplaySnapshotV1> {
    const value = validateBackendBinding(binding);
    return this.append(sessionId, { kind: 'backend.bound', payload: { binding: value as unknown as JsonValue } });
  }

  async checkpoint(sessionId: M13StableId): Promise<SessionReplaySnapshotV1> {
    this.assertActive();
    const id = this.stable(sessionId, 'session id');
    return this.enqueue(id, async () => {
      const snapshot = await this.replayNow(id);
      const throughSequence = snapshot.ops.length;
      const unresolved = unique([...snapshot.recovery.openToolNodeIds, ...snapshot.recovery.openBatchIds, ...snapshot.recovery.unresolvedBarrierIds]).sort();
      const latest = [...snapshot.ops].reverse();
      const turnId = latest.find((op) => op.turnId)?.turnId ?? null;
      const batchId = snapshot.recovery.openBatchIds.at(-1) ?? latest.find((op) => op.batchId)?.batchId ?? null;
      const documentRevision = latest.find((op) => op.projectRevision !== null)?.projectRevision ?? null;
      const checkpointBase = {
        sessionId: id,
        throughSequence,
        turnId,
        batchId,
        documentRevision,
        surfaceGeneration: snapshot.surface.generation,
        surfaceDigest: snapshot.surface.digest,
        unresolvedBarrierIds: unresolved,
      };
      const checkpointIds = new Set<M13StableId>();
      for (const op of snapshot.ops) { const value = op.payload.checkpoint; if (isRecord(value) && isStableId(value.id)) checkpointIds.add(value.id); }
      const checkpoint: SessionCheckpointV1 = deepFreeze({
        id: this.nextUniqueId('checkpoint', checkpointIds), sessionId: id, throughSequence,
        turnId,
        batchId,
        documentRevision,
        surfaceGeneration: snapshot.surface.generation,
        unresolvedBarrierIds: Object.freeze(unresolved),
        digest: digestJson(checkpointBase as unknown as JsonValue), createdAt: this.now(),
      });
      return this.appendFromSnapshot(snapshot, { kind: 'session.checkpointed', payload: { checkpoint: checkpoint as unknown as JsonValue } });
    });
  }

  async fork(sessionId: M13StableId, input: ForkSessionInput = {}): Promise<DurableSessionHandle> {
    this.assertActive();
    const sourceId = this.stable(sessionId, 'parent session id');
    const parent = await this.replay(sourceId, input.throughSequence);
    const targetId = this.stable(input.id ?? this.nextId('session'), 'fork session id');
    if (targetId === sourceId) throw new AgentSessionError('session.fork-invalid', 'Fork session id must differ from its parent.');
    const parentTranscript = parent.transcript.map(({ sessionId: _sessionId, source: _source, content: _content, ...entry }) => entry);
    const seed: SessionForkSeedV1 = deepFreeze({ schemaVersion: 1, kind: 'agent-session-fork-seed', parentSessionId: sourceId, parentThroughSequence: parent.ops.at(-1)!.sequence, parentSurface: parent.surface, parentTranscript: Object.freeze(parentTranscript) });
    const seedArtifact = await this.log.putArtifact(seed as unknown as JsonValue, { schemaVersion: 'agent-session-fork-seed/1' });
    await this.enqueue(targetId, async () => {
      const existing = await this.readOps(targetId);
      if (existing.ops.length > 0) throw new AgentSessionError('session.duplicate', `Session ${targetId} already exists.`);
      const op = this.makeOp(targetId, 0, {
        kind: 'session.created', artifactRefs: [seedArtifact.id],
        payload: deepFreeze({
          projectId: parent.session.projectId, documentId: parent.session.documentId,
          activeGoal: input.activeGoal === undefined ? parent.session.activeGoal : nullableText(input.activeGoal, 32_768, 'active goal'),
          taskBudgetId: parent.session.taskBudgetId, parentSessionId: sourceId, forkSeedArtifactId: seedArtifact.id,
        }),
      });
      await this.persist(op);
      await projectSession(targetId, [op], this.log, this.log.status().nextSequence - 1);
    });
    return new SessionHandle(this, targetId);
  }

  async flush(): Promise<void> {
    this.assertActive();
    await Promise.all(this.tails.values());
    await this.log.flush();
  }

  async dispose(): Promise<void> {
    if (this.state !== 'active') return;
    this.state = 'disposing';
    try { await Promise.all(this.tails.values()); await this.log.flush(); }
    finally { this.state = 'disposed'; this.tails.clear(); }
  }

  private async repairOpenOperations(snapshot: SessionReplaySnapshotV1): Promise<void> {
    if (snapshot.recovery.unresolvedBarrierIds.length > 0) return;
    if (snapshot.recovery.openTurnIds.length === 0 && snapshot.recovery.openToolNodeIds.length === 0 && snapshot.recovery.openBatchIds.length === 0) return;
    let current = snapshot;
    for (const nodeId of snapshot.recovery.openToolNodeIds) {
      const started = [...current.ops].reverse().find((op) => op.kind === 'tool.started' && op.nodeId === nodeId);
      if (!started) throw new AgentSessionError('session.sequence-gap', `Open tool ${nodeId} has no start operation.`);
      current = await this.append(snapshot.session.id, {
        kind: 'tool.outcome-unknown', turnId: started.turnId, stepId: started.stepId, batchId: started.batchId, nodeId,
        parentOpId: started.id, dependsOn: [started.id], projectRevision: started.projectRevision,
        payload: { diagnostic: 'session.outcome-unknown', startedOpId: started.id, retryAllowed: false, recoveredAfterRestart: true, effect: typeof started.payload.effect === 'string' ? started.payload.effect : 'unknown' },
      });
    }
    for (const batchId of [...current.recovery.openBatchIds]) current = await this.append(snapshot.session.id, { kind: 'tool-batch.completed', batchId, payload: { status: 'interrupted', recoveredAfterRestart: true } });
    for (const turnId of [...current.recovery.openTurnIds]) current = await this.append(snapshot.session.id, { kind: 'turn.completed', turnId, payload: { status: 'interrupted', recoveredAfterRestart: true } });
    current = await this.append(snapshot.session.id, { kind: 'session.status-changed', payload: { status: 'interrupted', reason: 'crash-recovery' } });
    await this.checkpoint(current.session.id);
  }

  private async appendFromSnapshot(snapshot: SessionReplaySnapshotV1, input: AppendSessionOpInput): Promise<SessionReplaySnapshotV1> {
    const op = this.makeOp(snapshot.session.id, snapshot.ops.length, input.id === undefined ? { ...input, id: this.nextUniqueId('op', new Set(snapshot.ops.map((entry) => entry.id))) } : input);
    const projected = await projectSession(snapshot.session.id, [...snapshot.ops, op], this.log, snapshot.throughLogSequence);
    const event = await this.persist(op);
    return deepFreeze({ ...projected, throughLogSequence: event.sequence });
  }

  private makeOp(sessionId: M13StableId, sequence: number, input: AppendSessionOpInput): SessionOpV1 {
    const payload = redactObject(input.payload ?? {}).value;
    const op = {
      schemaVersion: 1 as const,
      id: this.stable(input.id ?? this.nextId('op'), 'operation id'),
      sessionId,
      sequence,
      kind: input.kind,
      timestamp: input.timestamp === undefined ? this.now() : normalizedTimestamp(input.timestamp),
      turnId: nullableId(input.turnId ?? null, 'turn id'),
      stepId: nullableId(input.stepId ?? null, 'step id'),
      batchId: nullableId(input.batchId ?? null, 'batch id'),
      nodeId: nullableId(input.nodeId ?? null, 'node id'),
      parentOpId: nullableId(input.parentOpId ?? null, 'parent operation id'),
      dependsOn: Object.freeze((input.dependsOn ?? []).map((id) => this.stable(id, 'dependency id'))),
      projectRevision: nullableRevision(input.projectRevision ?? null),
      artifactRefs: Object.freeze((input.artifactRefs ?? []).map((id) => this.stable(id, 'artifact id'))),
      payload,
      payloadDigest: digestJson(payload),
    };
    return validateSessionOp(op);
  }

  private persist(op: SessionOpV1) {
    return this.log.append({
      eventId: op.id as StableId,
      timestamp: op.timestamp,
      kind: SESSION_EVENT_KIND,
      severity: op.kind === 'tool.outcome-unknown' || op.kind === 'compaction.failed' ? 'warning' : 'info',
      source: SESSION_SOURCE,
      correlation: {
        sessionId: op.sessionId as StableId,
        ...(op.turnId ? { turnId: op.turnId as StableId } : {}),
        ...(op.stepId ? { stepId: op.stepId as StableId } : {}),
      },
      payload: { sessionOp: op as unknown as JsonValue },
      provenance: { schemaVersion: 'agent-session-op/1', pluginVersion: '0.0.0' },
      artifactRefs: op.artifactRefs as readonly StableId[],
    });
  }

  private async replayNow(sessionId: M13StableId, throughSequence?: number): Promise<SessionReplaySnapshotV1> {
    const read = await this.readOps(sessionId);
    const ops = throughSequence === undefined ? read.ops : read.ops.filter((op) => op.sequence <= throughSequence);
    if (throughSequence !== undefined && (!Number.isSafeInteger(throughSequence) || throughSequence < 0 || ops.at(-1)?.sequence !== throughSequence)) throw new AgentSessionError('session.sequence-gap', `Requested Session prefix ${throughSequence} is unavailable.`);
    for (const artifactId of unique(ops.flatMap((op) => [...op.artifactRefs]))) await this.log.readArtifact(artifactId as StableId);
    return projectSession(sessionId, ops, this.log, read.throughLogSequence);
  }

  private async readOps(sessionId: M13StableId): Promise<Readonly<{ ops: readonly SessionOpV1[]; throughLogSequence: number }>> {
    const status = this.log.status();
    const ops: SessionOpV1[] = [];
    let throughLogSequence = status.retainedFromSequence - 1;
    for (let start = status.retainedFromSequence; start < status.nextSequence; start += this.queryWindow) {
      const end = Math.min(status.nextSequence, start + this.queryWindow);
      const page = await this.log.query({ sessionId: sessionId as StableId, ...(start > 0 ? { afterSequence: start - 1 } : {}), beforeSequence: end, limit: this.queryWindow, traverseCorrelation: false });
      for (const event of page.events) {
        throughLogSequence = Math.max(throughLogSequence, event.sequence);
        if (event.source !== SESSION_SOURCE) continue;
        if (event.kind !== SESSION_EVENT_KIND) throw new AgentSessionError('session.version-unsupported', `Unknown Studio Session event ${event.kind}.`);
        ops.push(parsePersistedSessionOp(event, sessionId));
      }
    }
    return deepFreeze({ ops: Object.freeze(ops), throughLogSequence });
  }

  private enqueue<T>(sessionId: M13StableId, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(action);
    this.tails.set(sessionId, result.then(() => undefined, () => undefined));
    return result;
  }

  private nextId(kind: Parameters<NonNullable<SessionRuntimeOptions['idFactory']>>[0]): M13StableId { return this.idFactory(kind, this.idIndex++); }
  private nextUniqueId(kind: Parameters<NonNullable<SessionRuntimeOptions['idFactory']>>[0], used: ReadonlySet<M13StableId>): M13StableId {
    for (let attempt = 0; attempt < 1024; attempt += 1) {
      const candidate = this.stable(this.nextId(kind), `${kind} id`);
      if (!used.has(candidate)) return candidate;
    }
    throw new AgentSessionError('session.id-exhausted', `Could not allocate a unique ${kind} id.`);
  }
  private now(): string { return this.clock().toISOString(); }
  private stable(value: M13StableId, kind: string): M13StableId { try { return asStableId(value, kind); } catch (cause) { throw new AgentSessionError('session.id-invalid', `Invalid ${kind}.`, { cause }); } }
  private assertActive(): void { if (this.state !== 'active') throw new AgentSessionError('session.runtime-disposed', `Durable Session runtime is ${this.state}.`); }
}

class SessionHandle implements DurableSessionHandle {
  private disposed = false;
  constructor(private readonly runtime: DurableSessionRuntime, readonly id: M13StableId) {}
  snapshot(): Promise<SessionReplaySnapshotV1> { this.assertActive(); return this.runtime.replay(this.id); }
  append(input: AppendSessionOpInput): Promise<SessionReplaySnapshotV1> { this.assertActive(); return this.runtime.append(this.id, input); }
  appendMessage(input: AppendSessionMessageInput): Promise<SessionReplaySnapshotV1> { this.assertActive(); return this.runtime.appendMessage(this.id, input); }
  replaceSurface(input: ReplaceModelSurfaceInput): Promise<SessionReplaySnapshotV1> { this.assertActive(); return this.runtime.replaceSurface(this.id, input); }
  bindBackend(binding: BackendSessionBindingV1): Promise<SessionReplaySnapshotV1> { this.assertActive(); return this.runtime.bindBackend(this.id, binding); }
  checkpoint(): Promise<SessionReplaySnapshotV1> { this.assertActive(); return this.runtime.checkpoint(this.id); }
  fork(input?: ForkSessionInput): Promise<DurableSessionHandle> { this.assertActive(); return this.runtime.fork(this.id, input); }
  flush(): Promise<void> { this.assertActive(); return this.runtime.flush(); }
  async dispose(): Promise<void> { this.disposed = true; }
  private assertActive(): void { if (this.disposed) throw new AgentSessionError('session.handle-disposed', `Session handle ${this.id} is disposed.`); }
}

function nullableId(value: M13StableId | null, kind: string): M13StableId | null { if (value === null) return null; if (!isStableId(value)) throw new AgentSessionError('session.id-invalid', `Invalid ${kind}.`); return value; }
function nullableText(value: string | null, max: number, kind: string): string | null { if (value === null) return null; if (typeof value !== 'string' || value.length > max) throw new AgentSessionError('session.text-invalid', `Invalid ${kind}.`); return value; }
function nullableRevision(value: number | null): number | null { if (value === null) return null; if (!Number.isSafeInteger(value) || value < 0) throw new AgentSessionError('session.revision-invalid', 'Project revision is invalid.'); return value; }
function normalizedTimestamp(value: string): string { if (!isTimestamp(value)) throw new AgentSessionError('session.timestamp-invalid', 'Session operation timestamp is invalid.'); return new Date(value).toISOString(); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
export function sessionPayloadDigest(payload: JsonObject): `sha256:${string}` { return `sha256:${sha256(canonicalStringify(payload))}`; }
