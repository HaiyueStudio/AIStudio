import type {
  AgentSessionStatusV1,
  AgentSessionV1,
  BackendSessionBindingV1,
  JsonValue,
  M13StableId,
  ModelSurfaceNodeV1,
  ModelSurfaceV1,
  SessionOpV1,
  SurfaceOpV1,
} from '@haiyue/ai-studio-contracts';
import type { OperationLog } from '@haiyue/ai-studio-operation-log';
import { AgentSessionError } from './error.js';
import type { SessionForkSeedV1, SessionMessageArtifactV1, SessionRecoverySnapshotV1, SessionReplaySnapshotV1, TranscriptEntryV1 } from './types.js';
import { deepFreeze, digestJson, isDigest, isNonNegativeInteger, isRecord, isStableId, isTimestamp, validateBackendBinding, validateCheckpoint, validateSurfaceOperation } from './validation.js';

const sessionStatuses = new Set<AgentSessionStatusV1>(['idle', 'running', 'waiting-user', 'waiting-approval', 'compacting', 'interrupted', 'completed', 'failed', 'cancelled']);

export async function projectSession(
  sessionId: M13StableId,
  ops: readonly SessionOpV1[],
  log: OperationLog,
  throughLogSequence: number,
): Promise<SessionReplaySnapshotV1> {
  assertOpPrefix(sessionId, ops);
  const created = ops[0]!;
  const creation = parseCreation(created.payload, sessionId);
  const seed = creation.forkSeedArtifactId ? await readForkSeed(log, creation.forkSeedArtifactId) : null;
  if (seed && seed.parentSessionId !== creation.parentSessionId) throw new AgentSessionError('session.fork-seed-invalid', 'Fork seed parent identity does not match session creation.');

  let nodes: ModelSurfaceNodeV1[] = seed ? seed.parentSurface.nodes.map((node) => deepFreeze({ ...node })) : [];
  let generation = seed?.parentSurface.generation ?? 0;
  let lastOperation: SurfaceOpV1 | null = seed?.parentSurface.lastOperation ?? null;
  const transcript: TranscriptEntryV1[] = [];
  if (seed) {
    for (const entry of seed.parentTranscript) {
      const message = await readMessage(log, entry.messageArtifactId);
      if (message.role !== entry.role) throw new AgentSessionError('session.fork-seed-invalid', `Fork transcript role for ${entry.id} is invalid.`);
      transcript.push(deepFreeze({ ...entry, sessionId, content: message.content, source: 'append-origin' as const }));
    }
  }

  let status: AgentSessionStatusV1 = 'idle';
  let checkpoint: AgentSessionV1['checkpoint'] = null;
  const bindings = new Map<M13StableId, BackendSessionBindingV1>();
  const usageRecordIds = new Set<M13StableId>();
  const costRecordIds = new Set<M13StableId>();
  const openTurns = new Set<M13StableId>();
  const openTools = new Map<M13StableId, SessionOpV1>();
  const openBatches = new Set<M13StableId>();
  const barriers = new Set<M13StableId>();
  const outcomeUnknown = new Set<M13StableId>();
  const surfaceNodeIds = new Set(nodes.map((node) => node.id));

  for (const op of ops.slice(1)) {
    collectAccounting(op, usageRecordIds, costRecordIds);
    status = foldStatus(status, op);
    foldRecovery(op, openTurns, openTools, openBatches, barriers, outcomeUnknown);
    if (op.kind === 'backend.bound') {
      const binding = validateBackendBinding(op.payload.binding);
      const previous = bindings.get(binding.bindingId);
      if (previous && binding.generation <= previous.generation) throw new AgentSessionError('session.backend-binding-invalid', `Backend binding ${binding.bindingId} generation did not advance.`);
      bindings.set(binding.bindingId, binding);
    }
    if (op.kind === 'backend.detached') {
      const bindingId = op.payload.bindingId;
      if (!isStableId(bindingId) || !bindings.has(bindingId)) throw new AgentSessionError('session.backend-binding-invalid', 'Detached backend binding is unknown.');
      bindings.set(bindingId, deepFreeze({ ...bindings.get(bindingId)!, status: 'detached' as const }));
    }
    if (op.kind === 'session.checkpointed') {
      const value = validateCheckpoint(op.payload.checkpoint, sessionId);
      if (value.throughSequence !== op.sequence || value.surfaceGeneration !== generation) throw new AgentSessionError('session.checkpoint-invalid', 'Checkpoint boundary does not match its Session prefix.');
      const unresolved = unique([...openTools.keys(), ...openBatches, ...barriers]).sort();
      if (!sameStrings(unresolved, [...value.unresolvedBarrierIds].sort())) throw new AgentSessionError('session.checkpoint-invalid', 'Checkpoint unresolved barriers do not match the Session prefix.');
      const previousThroughSequence = op.sequence - 1;
      const surfaceBase = { schemaVersion: 1 as const, sessionId, generation, throughSequence: previousThroughSequence, nodes: Object.freeze(nodes), lastOperation };
      const surfaceDigest = digestJson(surfaceBase as unknown as JsonValue);
      const expectedDigest = digestJson({ sessionId, throughSequence: value.throughSequence, turnId: value.turnId, batchId: value.batchId, documentRevision: value.documentRevision, surfaceGeneration: value.surfaceGeneration, surfaceDigest, unresolvedBarrierIds: unresolved } as unknown as JsonValue);
      if (value.digest !== expectedDigest) throw new AgentSessionError('session.checkpoint-invalid', 'Checkpoint digest does not match the Session prefix.');
      checkpoint = value;
    }
    if ('surfaceOperation' in op.payload) {
      const surfaceOp = validateSurfaceOperation(op.payload.surfaceOperation);
      if (surfaceNodeIds.has(surfaceOp.id)) throw new AgentSessionError('surface.source-missing', `Duplicate Surface node ${surfaceOp.id}.`);
      if (surfaceOp.op === 'append') {
        if (surfaceOp.sourceOpIds.length !== 1 || surfaceOp.sourceOpIds[0] !== op.id || !op.artifactRefs.includes(surfaceOp.messageArtifactId)) throw new AgentSessionError('surface.source-missing', `Surface append ${surfaceOp.id} has invalid provenance.`);
        const message = await readMessage(log, surfaceOp.messageArtifactId);
        if (message.role !== surfaceOp.role && surfaceOp.role !== 'tool') throw new AgentSessionError('surface.source-missing', `Surface message ${surfaceOp.id} role drifted.`);
        const node = deepFreeze({ id: surfaceOp.id, originOpId: op.id, messageArtifactId: surfaceOp.messageArtifactId, role: surfaceOp.role, replacedSourceOpIds: Object.freeze([]) });
        nodes.push(node); surfaceNodeIds.add(node.id); lastOperation = surfaceOp;
        if (surfaceOp.role === 'user' || surfaceOp.role === 'assistant') {
          if ((surfaceOp.role === 'user' && op.kind !== 'user.message') || (surfaceOp.role === 'assistant' && op.kind !== 'assistant.message')) throw new AgentSessionError('surface.source-missing', `Surface role and Session operation kind disagree for ${op.id}.`);
          transcript.push(deepFreeze({ id: surfaceOp.id, sessionId, originSessionId: sessionId, opId: op.id, role: surfaceOp.role, messageArtifactId: surfaceOp.messageArtifactId, content: message.content, timestamp: op.timestamp, source: 'append-origin' as const }));
        }
      } else {
        if (!op.artifactRefs.includes(surfaceOp.replacementArtifactId)) throw new AgentSessionError('surface.source-missing', `Surface replacement ${surfaceOp.id} does not reference its artifact.`);
        await readMessage(log, surfaceOp.replacementArtifactId);
        const start = nodes.findIndex((node) => node.id === surfaceOp.startNodeId);
        const end = nodes.findIndex((node) => node.id === surfaceOp.endNodeId);
        if (start < 0 || end < start) throw new AgentSessionError('surface.replace-range-invalid', `Surface replacement ${surfaceOp.id} range is invalid.`);
        const completeSources = unique(nodes.slice(start, end + 1).flatMap(nodeSources)).sort();
        if (!sameStrings(completeSources, [...surfaceOp.sourceOpIds].sort())) throw new AgentSessionError('surface.replace-range-invalid', `Surface replacement ${surfaceOp.id} does not cover the full source range.`);
        for (const removed of nodes.slice(start, end + 1)) surfaceNodeIds.delete(removed.id);
        const replacement = deepFreeze({ id: surfaceOp.id, originOpId: op.id, messageArtifactId: surfaceOp.replacementArtifactId, role: 'assistant' as const, replacedSourceOpIds: Object.freeze([...surfaceOp.sourceOpIds]) });
        nodes.splice(start, end - start + 1, replacement); surfaceNodeIds.add(replacement.id); generation += 1; lastOperation = surfaceOp;
      }
    }
  }

  const throughSequence = ops.at(-1)!.sequence;
  const surfaceBase = { schemaVersion: 1 as const, sessionId, generation, throughSequence, nodes: Object.freeze(nodes), lastOperation };
  const surface = deepFreeze({ ...surfaceBase, digest: digestJson(surfaceBase as unknown as JsonValue) }) as ModelSurfaceV1;
  const session: AgentSessionV1 = deepFreeze({
    schemaVersion: 1 as const,
    id: sessionId,
    projectId: creation.projectId,
    documentId: creation.documentId,
    createdAt: created.timestamp,
    updatedAt: ops.at(-1)!.timestamp,
    status,
    activeGoal: creation.activeGoal,
    surfaceGeneration: generation,
    backendBindings: Object.freeze([...bindings.values()].sort((left, right) => left.bindingId.localeCompare(right.bindingId))),
    checkpoint,
    taskBudgetId: creation.taskBudgetId,
    usageRecordIds: Object.freeze([...usageRecordIds]),
    costRecordIds: Object.freeze([...costRecordIds]),
  });
  const recovery: SessionRecoverySnapshotV1 = deepFreeze({
    openTurnIds: Object.freeze([...openTurns].sort()),
    openToolNodeIds: Object.freeze([...openTools.keys()].sort()),
    openBatchIds: Object.freeze([...openBatches].sort()),
    unresolvedBarrierIds: Object.freeze([...barriers].sort()),
    outcomeUnknownNodeIds: Object.freeze([...outcomeUnknown].sort()),
  });
  return deepFreeze({ schemaVersion: 1 as const, session, ops: Object.freeze([...ops]), surface, transcript: Object.freeze(transcript), recovery, throughLogSequence });
}

function assertOpPrefix(sessionId: M13StableId, ops: readonly SessionOpV1[]): void {
  if (ops.length === 0) throw new AgentSessionError('session.not-found', `Session ${sessionId} was not found.`);
  const ids = new Set<M13StableId>();
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]!;
    if (op.sessionId !== sessionId || op.sequence !== index || ids.has(op.id)) throw new AgentSessionError('session.sequence-gap', `Session ${sessionId} has a gap, duplicate or coordinate drift at sequence ${index}.`);
    if (index === 0 && op.kind !== 'session.created') throw new AgentSessionError('session.sequence-gap', `Session ${sessionId} root operation is missing.`);
    if (index > 0 && op.kind === 'session.created') throw new AgentSessionError('session.sequence-gap', `Session ${sessionId} contains a duplicate root.`);
    if (op.parentOpId && !ids.has(op.parentOpId)) throw new AgentSessionError('session.sequence-gap', `Session operation ${op.id} has an unknown parent.`);
    for (const dependency of op.dependsOn) if (!ids.has(dependency)) throw new AgentSessionError('session.sequence-gap', `Session operation ${op.id} has an unknown dependency.`);
    ids.add(op.id);
  }
}

function parseCreation(payload: SessionOpV1['payload'], sessionId: M13StableId): Readonly<{ projectId: M13StableId | null; documentId: M13StableId | null; activeGoal: string | null; taskBudgetId: M13StableId | null; parentSessionId: M13StableId | null; forkSeedArtifactId: M13StableId | null }> {
  const { projectId, documentId, activeGoal, taskBudgetId, parentSessionId = null, forkSeedArtifactId = null } = payload;
  if ((projectId !== null && !isStableId(projectId)) || (documentId !== null && !isStableId(documentId)) || (activeGoal !== null && (typeof activeGoal !== 'string' || activeGoal.length > 32_768)) || (taskBudgetId !== null && !isStableId(taskBudgetId)) || (parentSessionId !== null && !isStableId(parentSessionId)) || (forkSeedArtifactId !== null && !isStableId(forkSeedArtifactId))) throw new AgentSessionError('session.creation-invalid', `Session ${sessionId} creation payload is invalid.`);
  if ((parentSessionId === null) !== (forkSeedArtifactId === null)) throw new AgentSessionError('session.creation-invalid', 'Fork parent and seed must be present together.');
  return deepFreeze({ projectId, documentId, activeGoal, taskBudgetId, parentSessionId, forkSeedArtifactId });
}

function foldStatus(current: AgentSessionStatusV1, op: SessionOpV1): AgentSessionStatusV1 {
  if (op.kind === 'session.status-changed') {
    if (!sessionStatuses.has(op.payload.status as AgentSessionStatusV1)) throw new AgentSessionError('session.status-invalid', `Session status ${String(op.payload.status)} is invalid.`);
    return op.payload.status as AgentSessionStatusV1;
  }
  if (op.kind === 'turn.started') return 'running';
  if (op.kind === 'approval.requested') return 'waiting-approval';
  if (op.kind === 'approval.resolved' && current === 'waiting-approval') return 'running';
  if (op.kind === 'question.requested') return 'waiting-user';
  if (op.kind === 'question.resolved' && current === 'waiting-user') return 'running';
  if (op.kind === 'compaction.started') return 'compacting';
  if ((op.kind === 'compaction.completed' || op.kind === 'compaction.failed') && current === 'compacting') return 'running';
  if (op.kind === 'turn.completed') {
    const terminal = op.payload.status;
    if (terminal === 'interrupted' || terminal === 'failed' || terminal === 'cancelled' || terminal === 'completed') return terminal === 'completed' ? 'idle' : terminal;
  }
  return current;
}

function foldRecovery(op: SessionOpV1, turns: Set<M13StableId>, tools: Map<M13StableId, SessionOpV1>, batches: Set<M13StableId>, barriers: Set<M13StableId>, outcomeUnknown: Set<M13StableId>): void {
  if (op.kind === 'turn.started') { if (!op.turnId) throw invalidCoordinate(op); turns.add(op.turnId); }
  if (op.kind === 'turn.completed') { if (!op.turnId || !turns.delete(op.turnId)) throw invalidCoordinate(op); }
  if (op.kind === 'tool.started') { if (!op.nodeId || tools.has(op.nodeId)) throw invalidCoordinate(op); tools.set(op.nodeId, op); }
  if (op.kind === 'tool.completed' || op.kind === 'tool.outcome-unknown') {
    if (!op.nodeId || !tools.delete(op.nodeId)) throw invalidCoordinate(op);
    if (op.kind === 'tool.outcome-unknown') outcomeUnknown.add(op.nodeId);
  }
  if (op.kind === 'tool-batch.started') { if (!op.batchId || batches.has(op.batchId)) throw invalidCoordinate(op); batches.add(op.batchId); }
  if (op.kind === 'tool-batch.completed') { if (!op.batchId || !batches.delete(op.batchId)) throw invalidCoordinate(op); }
  if (op.kind === 'approval.requested' || op.kind === 'question.requested') { const id = barrierId(op); if (barriers.has(id)) throw invalidCoordinate(op); barriers.add(id); }
  if (op.kind === 'approval.resolved' || op.kind === 'question.resolved') { const id = barrierId(op); if (!barriers.delete(id)) throw invalidCoordinate(op); }
}

function collectAccounting(op: SessionOpV1, usage: Set<M13StableId>, cost: Set<M13StableId>): void {
  const usageId = op.payload.usageRecordId; const costId = op.payload.costRecordId;
  if (usageId !== undefined) { if (!isStableId(usageId)) throw new AgentSessionError('session.accounting-reference-invalid', 'Usage record id is invalid.'); usage.add(usageId); }
  if (costId !== undefined) { if (!isStableId(costId)) throw new AgentSessionError('session.accounting-reference-invalid', 'Cost record id is invalid.'); cost.add(costId); }
}

async function readMessage(log: OperationLog, id: M13StableId): Promise<SessionMessageArtifactV1> {
  const artifact = await log.readArtifact(id as import('@haiyue/ai-studio-contracts').StableId);
  const value = artifact.value;
  if (!isRecord(value) || value.schemaVersion !== 1 || !['session-message', 'surface-summary'].includes(String(value.kind)) || !['user', 'assistant'].includes(String(value.role)) || typeof value.content !== 'string' || Object.keys(value).some((key) => !['schemaVersion', 'kind', 'role', 'content'].includes(key))) throw new AgentSessionError('surface.source-missing', `Message artifact ${id} is invalid.`);
  return deepFreeze(value) as unknown as SessionMessageArtifactV1;
}

async function readForkSeed(log: OperationLog, id: M13StableId): Promise<SessionForkSeedV1> {
  const artifact = await log.readArtifact(id as import('@haiyue/ai-studio-contracts').StableId);
  const value = artifact.value;
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'kind', 'parentSessionId', 'parentThroughSequence', 'parentSurface', 'parentTranscript']) || value.schemaVersion !== 1 || value.kind !== 'agent-session-fork-seed' || !isStableId(value.parentSessionId) || !isNonNegativeInteger(value.parentThroughSequence) || !isRecord(value.parentSurface) || !Array.isArray(value.parentTranscript)) throw new AgentSessionError('session.fork-seed-invalid', `Fork seed ${id} is invalid.`);
  const surface = value.parentSurface;
  if (!hasExactKeys(surface, ['schemaVersion', 'sessionId', 'generation', 'throughSequence', 'nodes', 'lastOperation', 'digest']) || surface.schemaVersion !== 1 || surface.sessionId !== value.parentSessionId || !isNonNegativeInteger(surface.generation) || !isNonNegativeInteger(surface.throughSequence) || surface.throughSequence !== value.parentThroughSequence || !Array.isArray(surface.nodes) || surface.nodes.length > 16_384 || !isDigest(surface.digest)) throw new AgentSessionError('session.fork-seed-invalid', `Fork seed ${id} Surface is invalid.`);
  const nodeIds = new Set<M13StableId>();
  for (const node of surface.nodes) {
    if (!isRecord(node) || !hasExactKeys(node, ['id', 'originOpId', 'messageArtifactId', 'role', 'replacedSourceOpIds']) || !isStableId(node.id) || nodeIds.has(node.id) || !isStableId(node.originOpId) || !isStableId(node.messageArtifactId) || !['user', 'assistant', 'tool'].includes(String(node.role)) || !isStableIdArray(node.replacedSourceOpIds, 16_384)) throw new AgentSessionError('session.fork-seed-invalid', `Fork seed ${id} Surface node is invalid.`);
    nodeIds.add(node.id);
  }
  if (surface.lastOperation !== null) validateSurfaceOperation(surface.lastOperation);
  const base = { schemaVersion: 1, sessionId: surface.sessionId, generation: surface.generation, throughSequence: surface.throughSequence, nodes: surface.nodes, lastOperation: surface.lastOperation };
  if (digestJson(base as JsonValue) !== surface.digest) throw new AgentSessionError('session.fork-seed-invalid', `Fork seed ${id} Surface digest is invalid.`);
  const transcriptIds = new Set<M13StableId>();
  for (const entry of value.parentTranscript) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['id', 'originSessionId', 'opId', 'role', 'messageArtifactId', 'timestamp']) || !isStableId(entry.id) || transcriptIds.has(entry.id) || !isStableId(entry.originSessionId) || !isStableId(entry.opId) || !['user', 'assistant'].includes(String(entry.role)) || !isStableId(entry.messageArtifactId) || !isTimestamp(entry.timestamp)) throw new AgentSessionError('session.fork-seed-invalid', `Fork seed ${id} Transcript is invalid.`);
    transcriptIds.add(entry.id);
  }
  return deepFreeze(value) as unknown as SessionForkSeedV1;
}

function nodeSources(node: ModelSurfaceNodeV1): M13StableId[] { return node.replacedSourceOpIds.length > 0 ? [...node.replacedSourceOpIds] : [node.originOpId]; }
function unique(values: readonly M13StableId[]): M13StableId[] { return [...new Set(values)]; }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => key in value); }
function isStableIdArray(value: unknown, max: number): value is M13StableId[] { return Array.isArray(value) && value.length <= max && value.every(isStableId) && new Set(value).size === value.length; }
function barrierId(op: SessionOpV1): M13StableId { const value = op.payload.approvalId ?? op.payload.questionId ?? op.nodeId; if (!isStableId(value)) throw invalidCoordinate(op); return value; }
function invalidCoordinate(op: SessionOpV1): AgentSessionError { return new AgentSessionError('session.sequence-gap', `Session operation ${op.id} has an invalid lifecycle coordinate.`); }
