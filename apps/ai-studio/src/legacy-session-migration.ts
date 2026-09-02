import { asStableId, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import type { DurableSessionHandle, DurableSessionRuntime, SessionReplaySnapshotV1 } from '@haiyue/ai-studio-agent-runtime';
import { canonicalStringify, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import type { ConversationNodeReadModel, ConversationTaskRunReadModel } from '@haiyue/ai-studio-shell';

const MIGRATION_VERSION = 1;

export interface LegacySessionMigrationInput {
  readonly sessions: DurableSessionRuntime;
  readonly operationLog: OperationLog;
  readonly nodes: readonly ConversationNodeReadModel[];
  readonly taskRuns: readonly ConversationTaskRunReadModel[];
  readonly project: Readonly<{ projectId?: StableId | null; documentId?: StableId | null }> | null;
}

export interface LegacySessionMigrationResult {
  readonly migrated: readonly StableId[];
  readonly resumed: readonly StableId[];
  readonly alreadyDurable: readonly StableId[];
  readonly failed: readonly Readonly<{ sessionId: StableId; code: string; message: string }>[];
}

/**
 * Converts pre-M13 conversation projections into an append-only Session without
 * replaying any historical tool mutation. Deterministic operation ids make an
 * interrupted migration safe to resume after another Studio restart.
 */
export async function migrateLegacySessions(input: LegacySessionMigrationInput): Promise<LegacySessionMigrationResult> {
  const grouped = legacySources(input.nodes, input.taskRuns);
  const migrated: StableId[] = [];
  const resumed: StableId[] = [];
  const alreadyDurable: StableId[] = [];
  const failed: Array<Readonly<{ sessionId: StableId; code: string; message: string }>> = [];
  for (const source of grouped) {
    try {
      const result = await migrateOne(input, source);
      if (result === 'migrated') migrated.push(source.sessionId);
      else if (result === 'resumed') resumed.push(source.sessionId);
      else alreadyDurable.push(source.sessionId);
    } catch (cause) {
      failed.push(Object.freeze({ sessionId: source.sessionId, code: errorCode(cause), message: errorMessage(cause) }));
    }
  }
  return Object.freeze({ migrated: Object.freeze(migrated), resumed: Object.freeze(resumed), alreadyDurable: Object.freeze(alreadyDurable), failed: Object.freeze(failed) });
}

interface LegacySource {
  readonly sessionId: StableId;
  readonly nodes: readonly ConversationNodeReadModel[];
  readonly taskRuns: readonly ConversationTaskRunReadModel[];
  readonly digest: string;
}

async function migrateOne(input: LegacySessionMigrationInput, source: LegacySource): Promise<'migrated' | 'resumed' | 'already-durable'> {
  const ids = migrationIds(source);
  let handle: DurableSessionHandle;
  let created = false;
  try { handle = await input.sessions.open(source.sessionId, { repairOpenOperations: false }); }
  catch (cause) {
    if (errorCode(cause) !== 'session.not-found') throw cause;
    const latest = source.taskRuns.at(-1);
    handle = await input.sessions.create({
      id: source.sessionId,
      projectId: input.project?.projectId ?? null,
      documentId: input.project?.documentId ?? null,
      activeGoal: latest?.requestSummary ?? latest?.title ?? 'Migrated Studio conversation',
      taskBudgetId: latest ? asStableId(`budget:${latest.taskId}`) : null,
    });
    created = true;
  }

  let snapshot = await handle.snapshot();
  if (snapshot.ops.some((op) => op.id === ids.completed)) return 'already-durable';
  const started = snapshot.ops.some((op) => op.id === ids.started);
  if (!created && !started && snapshot.ops.length > 1) return 'already-durable';

  if (!started) snapshot = await handle.append({
    id: ids.started,
    kind: 'session.status-changed',
    payload: { status: 'idle', reason: 'legacy-migration-started', migrationVersion: MIGRATION_VERSION, sourceDigest: source.digest },
  });

  const messages = legacyMessages(source);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const opId = messageOpId(source.sessionId, index, message.role, message.content);
    if (snapshot.ops.some((op) => op.id === opId)) continue;
    const artifact = await input.operationLog.putArtifact(
      { schemaVersion: 1, kind: 'session-message', role: message.role, content: message.content },
      { schemaVersion: 'agent-session-message/1' },
    );
    const surfaceId = asStableId(`surface:legacy:${sha256(`${opId}:surface`).slice(0, 24)}`);
    snapshot = await handle.append({
      id: opId,
      timestamp: message.timestamp,
      kind: message.role === 'user' ? 'user.message' : 'assistant.message',
      turnId: message.turnId,
      projectRevision: message.projectRevision,
      artifactRefs: [artifact.id],
      payload: { surfaceOperation: { op: 'append', id: surfaceId, sourceOpIds: [opId], messageArtifactId: artifact.id, role: message.role } as unknown as JsonValue },
    });
  }

  const sourceArtifact = await input.operationLog.putArtifact(legacyArtifact(source), { schemaVersion: 'legacy-conversation-migration/1' });
  if (!snapshot.ops.some((op) => op.id === ids.evidence)) snapshot = await handle.append({
    id: ids.evidence,
    kind: 'evidence.captured',
    nodeId: ids.node,
    projectRevision: latestRevision(source),
    artifactRefs: [sourceArtifact.id],
    payload: {
      evidenceType: 'Legacy conversation migration',
      summary: `${source.taskRuns.length} task record(s), ${source.nodes.length} timeline node(s), ${messages.length} Surface message(s) preserved without replaying mutations.`,
      sourceDigest: source.digest,
      mutationReplayCount: 0,
    },
  });
  if (!snapshot.ops.some((op) => op.id === ids.completed)) await handle.append({
    id: ids.completed,
    kind: 'session.status-changed',
    projectRevision: latestRevision(source),
    artifactRefs: [sourceArtifact.id],
    payload: {
      status: terminalStatus(source),
      reason: 'legacy-migration-completed',
      migrationVersion: MIGRATION_VERSION,
      sourceDigest: source.digest,
      sourceArtifactId: sourceArtifact.id,
      mutationReplayCount: 0,
    },
  });
  return started ? 'resumed' : 'migrated';
}

function legacySources(nodes: readonly ConversationNodeReadModel[], taskRuns: readonly ConversationTaskRunReadModel[]): readonly LegacySource[] {
  const ids = new Set<StableId>();
  for (const node of nodes) ids.add(node.provenance.sessionId);
  for (const run of taskRuns) if (run.sessionId) ids.add(run.sessionId);
  return Object.freeze([...ids].sort().map((sessionId) => {
    const selectedNodes = nodes.filter((node) => node.provenance.sessionId === sessionId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const selectedRuns = taskRuns.filter((run) => run.sessionId === sessionId).sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.taskId.localeCompare(right.taskId));
    const digest = `sha256:${sha256(canonicalStringify({ sessionId, nodeIds: selectedNodes.map((node) => node.id), taskRevisions: selectedRuns.map((run) => ({ taskId: run.taskId, revision: run.revision })) }))}`;
    return Object.freeze({ sessionId, nodes: Object.freeze(selectedNodes), taskRuns: Object.freeze(selectedRuns), digest });
  }));
}

function legacyMessages(source: LegacySource): readonly Readonly<{ role: 'user' | 'assistant'; content: string; timestamp: string; turnId: StableId | null; projectRevision: number | null }>[] {
  const values: Array<Readonly<{ role: 'user' | 'assistant'; content: string; timestamp: string; turnId: StableId | null; projectRevision: number | null }>> = [];
  const seen = new Set<string>();
  for (const run of source.taskRuns) pushMessage(values, seen, {
    role: 'user', content: run.requestSummary, timestamp: run.startedAt, turnId: run.turnId, projectRevision: run.documentRevision,
  });
  for (const node of source.nodes) {
    if (node.kind !== 'text' || typeof node.content.text !== 'string') continue;
    const role = node.content.role === 'user' ? 'user' : 'assistant';
    const run = source.taskRuns.find((candidate) => candidate.turnId === node.provenance.turnId);
    pushMessage(values, seen, { role, content: node.content.text, timestamp: node.createdAt, turnId: node.provenance.turnId, projectRevision: run?.documentRevision ?? null });
  }
  return Object.freeze(values);
}

function pushMessage(target: Array<Readonly<{ role: 'user' | 'assistant'; content: string; timestamp: string; turnId: StableId | null; projectRevision: number | null }>>, seen: Set<string>, input: Readonly<{ role: 'user' | 'assistant'; content: string; timestamp: string; turnId: StableId | null; projectRevision: number | null }>): void {
  const content = input.content.replace(/\s+/gu, ' ').trim().slice(0, 32_768);
  if (!content) return;
  const key = `${input.role}:${content}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(Object.freeze({ ...input, content }));
}

function legacyArtifact(source: LegacySource): JsonValue {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'legacy-conversation-migration-source',
    migrationVersion: MIGRATION_VERSION,
    sessionId: source.sessionId,
    sourceDigest: source.digest,
    mutationReplayCount: 0,
    nodes: source.nodes.map((node) => ({ id: node.id, kind: node.kind, status: node.status, createdAt: node.createdAt, provenance: node.provenance, content: node.content })),
    taskRuns: source.taskRuns.map((run) => ({ ...run, evidence: run.evidence.map(({ previewDataUrl: _preview, ...evidence }) => evidence) })),
  }) as unknown as JsonValue;
}

function migrationIds(source: LegacySource): Readonly<{ started: StableId; evidence: StableId; completed: StableId; node: StableId }> {
  const stem = sha256(`${source.sessionId}:${source.digest}:v${MIGRATION_VERSION}`).slice(0, 24);
  return Object.freeze({
    started: asStableId(`op:legacy-migration-started:${stem}`),
    evidence: asStableId(`op:legacy-migration-evidence:${stem}`),
    completed: asStableId(`op:legacy-migration-complete:${stem}`),
    node: asStableId(`node:legacy-migration:${stem}`),
  });
}

function messageOpId(sessionId: StableId, index: number, role: string, content: string): StableId {
  return asStableId(`op:legacy-message:${index}:${sha256(`${sessionId}:${role}:${content}`).slice(0, 24)}`);
}

function latestRevision(source: LegacySource): number | null {
  return source.taskRuns.reduce<number | null>((latest, run) => run.documentRevision === null ? latest : Math.max(latest ?? 0, run.documentRevision), null);
}

function terminalStatus(source: LegacySource): 'idle' | 'waiting-user' | 'interrupted' | 'completed' | 'failed' | 'cancelled' {
  if (source.taskRuns.some((run) => run.status === 'waiting-user')) return 'waiting-user';
  if (source.taskRuns.some((run) => run.status === 'running' || run.status === 'blocked')) return 'interrupted';
  if (source.taskRuns.some((run) => run.status === 'failed')) return 'failed';
  if (source.taskRuns.some((run) => run.status === 'cancelled')) return 'cancelled';
  if (source.taskRuns.some((run) => run.status === 'completed')) return 'completed';
  return 'idle';
}

function errorCode(cause: unknown): string { return cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'legacy-migration.failed'; }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message.slice(0, 2_000) : String(cause).slice(0, 2_000); }
