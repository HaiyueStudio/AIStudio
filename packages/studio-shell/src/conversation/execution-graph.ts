import type { CompactionRecordV1, ContextPressureV1, JsonValue, M13StableId, SessionOpV1 } from '@haiyue/ai-studio-contracts';
import type {
  ExecutionGraphContextReadModel,
  ExecutionGraphDiagnosticReadModel,
  ExecutionGraphEdgeReadModel,
  ExecutionGraphNodeReadModel,
  ExecutionGraphProductEdgeKind,
  ExecutionGraphProductNodeKind,
  ExecutionGraphProductNodeStatus,
  ExecutionGraphProjectionInput,
  ExecutionGraphReadModel,
  ExecutionTranscriptItemReadModel,
} from './execution-graph-types.js';

interface MutableNode {
  id: M13StableId;
  kind: ExecutionGraphProductNodeKind;
  status: ExecutionGraphProductNodeStatus;
  title: string;
  summary: string;
  turnId: M13StableId | null;
  batchId: M13StableId | null;
  sourceNodeId: M13StableId | null;
  sourceOpIds: M13StableId[];
  artifactRefs: M13StableId[];
  projectRevisionBefore: number | null;
  projectRevisionAfter: number | null;
  startedAt: string;
  completedAt: string | null;
  toolId: string | null;
  toolVersion: string | null;
  executionClass: string | null;
  barrierKind: string | null;
  transactionId: M13StableId | null;
  usageRecordIds: M13StableId[];
  costRecordIds: M13StableId[];
  diagnostic: string | null;
  validation: string | null;
}

interface MutableEdge {
  readonly id: M13StableId;
  readonly kind: ExecutionGraphProductEdgeKind;
  readonly from: M13StableId;
  readonly to: M13StableId;
  readonly sourceOpIds: M13StableId[];
}

const terminalStatuses = new Set<ExecutionGraphProductNodeStatus>(['completed', 'failed', 'cancelled']);
const activeStatuses = new Set<ExecutionGraphProductNodeStatus>(['running', 'waiting', 'outcome-unknown']);

export function projectExecutionGraph(input: ExecutionGraphProjectionInput): ExecutionGraphReadModel {
  const ops = [...input.ops].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const diagnostics: ExecutionGraphDiagnosticReadModel[] = [];
  validatePrefix(input.sessionId, ops, diagnostics);
  const nodes = new Map<M13StableId, MutableNode>();
  const edges = new Map<M13StableId, MutableEdge>();
  const opToGraphNode = new Map<M13StableId, M13StableId>();
  const sourceNodeToGraphNode = new Map<M13StableId, M13StableId>();
  const transcriptByOp = new Map((input.transcript ?? []).map((entry) => [entry.opId, entry]));
  const transcript: ExecutionTranscriptItemReadModel[] = [];
  const rootId = graphId('goal', input.sessionId);
  const first = ops[0];
  nodes.set(rootId, mutableNode({
    id: rootId,
    kind: 'goal',
    status: sessionStatus(input.status, ops),
    title: safeText(input.activeGoal, 'Agent task'),
    summary: safeText(first?.payload.activeGoal, safeText(input.activeGoal, 'Agent session')),
    startedAt: first?.timestamp ?? new Date(0).toISOString(),
  }));

  let latestPressure: ContextPressureV1 | null = null;
  let latestCompaction: CompactionRecordV1 | null = null;
  const toolIntervals = new Map<M13StableId, Readonly<{ batchId: M13StableId; startedAt: number; completedAt: number | null }>>();

  for (const op of ops) {
    const graphNodeId = graphNodeIdFor(op, input.sessionId);
    if (!graphNodeId) {
      diagnostics.push(freeze({ code: 'graph.coordinate-missing', message: `Session operation ${op.id} has no graph coordinate.`, sourceOpId: op.id }));
      continue;
    }
    const descriptor = describeOp(op, input.activeGoal ?? null);
    const existing = nodes.get(graphNodeId);
    const node = existing ?? mutableNode({
      id: graphNodeId,
      kind: descriptor.kind,
      status: descriptor.status,
      title: descriptor.title,
      summary: descriptor.summary,
      turnId: op.turnId,
      batchId: op.batchId,
      sourceNodeId: op.nodeId,
      startedAt: op.timestamp,
    });
    foldNode(node, op, descriptor);
    nodes.set(graphNodeId, node);
    if (op.kind === 'turn.completed' && op.turnId) {
      const turnNode = nodes.get(graphId('turn', op.turnId));
      if (turnNode) {
        turnNode.status = descriptor.status;
        turnNode.summary = descriptor.summary;
        turnNode.completedAt = op.timestamp;
        turnNode.sourceOpIds.push(op.id);
      }
    }
    opToGraphNode.set(op.id, graphNodeId);
    if (op.nodeId) sourceNodeToGraphNode.set(op.nodeId, graphNodeId);

    if (graphNodeId !== rootId) {
      const parent = ensureStructuralParents(op, input.sessionId, rootId, nodes, edges);
      addEdge(edges, 'contains', parent, graphNodeId, op.id);
    }
    if (op.kind === 'tool.started' && op.batchId) toolIntervals.set(graphNodeId, freeze({ batchId: op.batchId, startedAt: Date.parse(op.timestamp), completedAt: null }));
    if ((op.kind === 'tool.completed' || op.kind === 'tool.outcome-unknown') && op.batchId) {
      const interval = toolIntervals.get(graphNodeId);
      if (interval) toolIntervals.set(graphNodeId, freeze({ ...interval, completedAt: Date.parse(op.timestamp) }));
    }
    const compaction = compactionRecord(op.payload.compaction);
    if (compaction) {
      latestCompaction = compaction;
      latestPressure = compaction.after ?? compaction.before;
    }
    const pressure = contextPressure(op.payload.pressure);
    if (pressure) latestPressure = pressure;
    const transcriptEntry = transcriptByOp.get(op.id);
    if (transcriptEntry) transcript.push(freeze({
      id: transcriptEntry.id,
      kind: 'message',
      role: transcriptEntry.role,
      timestamp: transcriptEntry.timestamp,
      title: transcriptEntry.role === 'user' ? 'You' : 'Agent',
      body: safeText(transcriptEntry.content, ''),
      status: 'completed',
      sourceOpIds: freeze([op.id]),
      graphNodeIds: freeze([graphNodeId]),
      artifactRefs: freeze([...op.artifactRefs]),
    }));
    const systemItem = transcriptItemFor(op, graphNodeId, descriptor);
    if (systemItem) transcript.push(systemItem);
  }

  for (const op of ops) {
    const to = opToGraphNode.get(op.id);
    if (!to) continue;
    if (op.parentOpId) addReferenceEdge('depends-on', op.parentOpId, to, op, opToGraphNode, sourceNodeToGraphNode, edges, diagnostics);
    for (const dependency of op.dependsOn) addReferenceEdge('depends-on', dependency, to, op, opToGraphNode, sourceNodeToGraphNode, edges, diagnostics);
    if (op.kind === 'document.committed') connectTransaction(op, to, nodes, edges, sourceNodeToGraphNode);
    if (op.kind === 'approval.requested' || op.kind === 'question.requested') connectBarrier(op, to, edges, sourceNodeToGraphNode);
    if (op.kind === 'evidence.captured' || op.kind === 'evaluation.completed') connectEvidence(op, to, nodes, edges);
    if (op.kind === 'compaction.completed') connectCompaction(op, to, ops, opToGraphNode, edges);
    const retrySource = stringValue(op.payload.retriedFrom) ?? stringValue(op.payload.retryOf);
    if (retrySource) addReferenceEdge('retried-from', retrySource, to, op, opToGraphNode, sourceNodeToGraphNode, edges, diagnostics);
    const resumedSource = stringValue(op.payload.resumedFrom);
    if (resumedSource) addReferenceEdge('resumed-from', resumedSource, to, op, opToGraphNode, sourceNodeToGraphNode, edges, diagnostics);
  }
  connectParallelIntervals(toolIntervals, edges);

  const root = nodes.get(rootId);
  if (root) root.status = sessionStatus(input.status, ops);

  const frozenNodes = freeze([...nodes.values()].map(freezeNode).sort(compareNodes));
  const frozenEdges = freeze([...edges.values()].map((edge) => freeze({ ...edge, sourceOpIds: freeze(unique(edge.sourceOpIds).sort()) })).sort(compareEdges));
  const currentNodeIds = freeze(frozenNodes.filter((node) => activeStatuses.has(node.status)).map((node) => node.id));
  const criticalPathNodeIds = freeze(calculateCriticalPath(frozenNodes, frozenEdges));
  const sortedTranscript = freeze(transcript.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)));
  const context = contextModel(latestPressure, latestCompaction, frozenNodes);
  const throughSequence = ops.at(-1)?.sequence ?? -1;
  const taskByTurn = new Map(ops.filter(op => op.kind === 'turn.started' && op.turnId && stringValue(op.payload.taskId)).map(op => [op.turnId!, stringValue(op.payload.taskId)!]));
  const taskByOp = new Map<string, string>(); let currentTask: string | null = null;
  for (const op of ops) {
    if (op.kind === 'turn.started') currentTask = taskByTurn.get(op.turnId!) ?? null;
    const taskId = op.turnId ? taskByTurn.get(op.turnId) : currentTask;
    if (taskId) taskByOp.set(op.id, taskId);
  }
  const taskScopes = [...new Set(taskByOp.values())].sort().map(taskId => freeze({
    taskId,
    nodeIds: freeze(frozenNodes.filter(node => node.id !== rootId && ((node.turnId && taskByTurn.get(node.turnId) === taskId) || node.sourceOpIds.some(id => taskByOp.get(id) === taskId))).map(node => node.id)),
    transcriptIds: freeze(sortedTranscript.filter(item => item.sourceOpIds.some(id => taskByOp.get(id) === taskId)).map(item => item.id)),
  }));
  const semantic = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    revision: throughSequence + 1,
    title: nodes.get(rootId)?.title ?? 'Agent task',
    status: nodes.get(rootId)?.status ?? 'pending',
    nodes: frozenNodes,
    edges: frozenEdges,
    criticalPathNodeIds,
    currentNodeIds,
    transcript: sortedTranscript,
    context,
    diagnostics: freeze([...diagnostics]),
    throughSequence,
    ...(taskScopes.length ? { taskScopes: freeze(taskScopes) } : {}),
  } as const;
  return freeze({ ...semantic, digest: sha256Digest(canonicalStringify(semantic as unknown as JsonValue)) });
}

export function normalizeExecutionGraphs(value: unknown): readonly ExecutionGraphReadModel[] {
  if (!Array.isArray(value)) return freeze([]);
  const result: ExecutionGraphReadModel[] = [];
  const sessions = new Set<M13StableId>();
  for (const item of value.slice(-50)) {
    try {
      const graph = normalizeExecutionGraph(item);
      const identity = executionGraphIdentity(graph);
      if (sessions.has(identity)) continue;
      sessions.add(identity); result.push(graph);
    } catch { /* malformed or future projections fail closed */ }
  }
  return freeze(result.sort(compareExecutionGraphs));
}

/** Revisions count operations within one session and cannot order different sessions. */
export function compareExecutionGraphs(left: ExecutionGraphReadModel, right: ExecutionGraphReadModel): number {
  const latest = (graph: ExecutionGraphReadModel): string => {
    let timestamp = '';
    for (const node of graph.nodes) for (const value of [node.startedAt, node.completedAt]) if (value && value > timestamp) timestamp = value;
    for (const item of graph.transcript) if (item.timestamp > timestamp) timestamp = item.timestamp;
    return timestamp;
  };
  const order = (graph: ExecutionGraphReadModel): string => graph.taskId ? graph.nodes.find(node => node.kind === 'goal')?.startedAt ?? latest(graph) : latest(graph);
  return order(left).localeCompare(order(right)) || executionGraphIdentity(left).localeCompare(executionGraphIdentity(right));
}

export function executionGraphIdentity(graph: ExecutionGraphReadModel): M13StableId { return graph.taskId ?? graph.sessionId; }

/** Compose the product task without changing its durable session graphs or context/approval owners. */
export function groupExecutionGraphsByTask(graphs: readonly ExecutionGraphReadModel[], tasks: readonly Readonly<{ taskId: string; title: string; status: string }>[] = []): readonly ExecutionGraphReadModel[] {
  const groups = new Map<string, { graph: ExecutionGraphReadModel; nodeIds: readonly string[]; transcriptIds: readonly string[] }[]>();
  const result: ExecutionGraphReadModel[] = [];
  for (const graph of graphs) {
    if (graph.taskId || !graph.taskScopes?.length) { result.push(graph); continue; }
    for (const scope of graph.taskScopes) { const parts = groups.get(scope.taskId) ?? []; parts.push({ graph, ...scope }); groups.set(scope.taskId, parts); }
    // Legacy turns without durable task membership remain independently inspectable.
    const known = new Set(graph.taskScopes.flatMap(scope => scope.nodeIds));
    const legacy = graph.nodes.filter(node => node.kind !== 'goal' && !known.has(node.id));
    if (legacy.length) {
      const ids = new Set([...legacy.map(node => node.id), ...graph.nodes.filter(node => node.kind === 'goal').map(node => node.id)]);
      const { digest: _digest, taskScopes: _scopes, ...base } = graph;
      const last = [...legacy].sort(compareNodes).at(-1)!;
      const semantic = { ...base, status: last.status, nodes: graph.nodes.filter(node => ids.has(node.id)).map(node => node.kind === 'goal' ? freeze({ ...node, status: last.status, completedAt: last.completedAt, summary: 'Earlier session history without task membership.' }) : node), edges: graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), currentNodeIds: graph.currentNodeIds.filter(id => ids.has(id)), criticalPathNodeIds: graph.criticalPathNodeIds.filter(id => ids.has(id)), transcript: graph.transcript.filter(item => item.graphNodeIds.some(id => ids.has(id) && !known.has(id))) };
      result.push(deepFreeze({ ...semantic, digest: sha256Digest(canonicalStringify(semantic as unknown as JsonValue)) }));
    }
  }
  for (const [taskId, parts] of groups) {
    const firstTime = (part: typeof parts[number]): string => { const ids = new Set(part.nodeIds); return part.graph.nodes.filter(node => ids.has(node.id)).map(node => node.startedAt).sort()[0] ?? ''; };
    parts.sort((a, b) => firstTime(a).localeCompare(firstTime(b)) || a.graph.sessionId.localeCompare(b.graph.sessionId));
    const latest = parts.at(-1)!.graph; const task = tasks.find(item => item.taskId === taskId);
    const rootId = graphId('task', taskId); const sourceRoot = latest.nodes.find(node => node.kind === 'goal')!;
    const status = task ? productStatus(task.status === 'waiting-user' ? 'waiting' : task.status) : latest.status;
    const title = task?.title ?? (parts[0]!.graph.taskScopes?.length === 1 ? parts[0]!.graph.title : 'Agent task');
    const nodes: ExecutionGraphNodeReadModel[] = [freeze({ ...sourceRoot, id: rootId, title, status, summary: `${parts.length} 个执行阶段`, startedAt: firstTime(parts[0]!), completedAt: terminalStatuses.has(status) ? sourceRoot.completedAt : null, durationMs: null, sourceOpIds: freeze([]), artifactRefs: freeze([]) })];
    const edges: ExecutionGraphEdgeReadModel[] = []; const transcript: ExecutionTranscriptItemReadModel[] = [];
    const critical: string[] = []; const diagnostics: ExecutionGraphDiagnosticReadModel[] = [];
    for (const part of parts) {
      const membership = new Set(part.nodeIds); const roots = new Set(part.graph.nodes.filter(node => node.kind === 'goal').map(node => node.id));
      const mapId = (id: string): string => roots.has(id) ? rootId : `${part.graph.sessionId}:${id}`;
      for (const node of part.graph.nodes) if (membership.has(node.id)) nodes.push(freeze({ ...node, id: mapId(node.id) }));
      for (const edge of part.graph.edges) if ((membership.has(edge.from) || roots.has(edge.from)) && (membership.has(edge.to) || roots.has(edge.to))) edges.push(freeze({ ...edge, id: `${part.graph.sessionId}:${edge.id}`, from: mapId(edge.from), to: mapId(edge.to) }));
      const transcriptIds = new Set(part.transcriptIds);
      for (const item of part.graph.transcript) if (transcriptIds.has(item.id)) transcript.push(freeze({ ...item, id: `${part.graph.sessionId}:${item.id}`, graphNodeIds: freeze(item.graphNodeIds.filter(id => membership.has(id) || roots.has(id)).map(mapId)) }));
      critical.push(...part.graph.criticalPathNodeIds.filter(id => membership.has(id)).map(mapId));
      diagnostics.push(...part.graph.diagnostics);
    }
    const semantic = { schemaVersion: 1 as const, sessionId: latest.sessionId, taskId, sourceSessionIds: freeze(parts.map(part => part.graph.sessionId)), revision: parts.reduce((sum, part) => sum + part.graph.revision, 0), title, status,
      nodes: freeze(nodes.sort(compareNodes)), edges: freeze(edges.sort(compareEdges)), criticalPathNodeIds: freeze(critical), currentNodeIds: freeze(nodes.filter(node => activeStatuses.has(node.status)).map(node => node.id)),
      transcript: freeze(transcript.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))), context: latest.context, diagnostics: freeze(diagnostics), throughSequence: latest.throughSequence };
    result.push(deepFreeze({ ...semantic, digest: sha256Digest(canonicalStringify(semantic as unknown as JsonValue)) }));
  }
  return freeze(result.sort(compareExecutionGraphs));
}

export function normalizeExecutionGraph(value: unknown): ExecutionGraphReadModel {
  if (!record(value) || value.schemaVersion !== 1 || !stringValue(value.sessionId) || !stringValue(value.digest)) throw new TypeError('Execution Graph envelope is invalid.');
  const serialized = JSON.stringify(value);
  if (serialized.length > 8 * 1024 * 1024) throw new TypeError('Execution Graph exceeds the renderer budget.');
  if (!Array.isArray(value.nodes) || value.nodes.length > 5_000 || !Array.isArray(value.edges) || value.edges.length > 20_000 || !Array.isArray(value.transcript) || value.transcript.length > 10_000 || !Array.isArray(value.diagnostics) || value.diagnostics.length > 1_000) throw new TypeError('Execution Graph collections are invalid.');
  const nodeIds = new Set<M13StableId>();
  for (const node of value.nodes) {
    if (!record(node) || !stringValue(node.id) || nodeIds.has(node.id as string) || !stringValue(node.kind) || !stringValue(node.status) || !stringValue(node.title) || !Array.isArray(node.sourceOpIds) || !Array.isArray(node.artifactRefs) || !record(node.detail)) throw new TypeError('Execution Graph node is invalid.');
    nodeIds.add(node.id as string);
  }
  if (value.taskId !== undefined && !stringValue(value.taskId)) throw new TypeError('Execution Graph task identity is invalid.');
  if (value.sourceSessionIds !== undefined && (!Array.isArray(value.sourceSessionIds) || value.sourceSessionIds.some(id => !stringValue(id)))) throw new TypeError('Execution Graph session membership is invalid.');
  const transcriptIds = new Set(value.transcript.map(item => record(item) ? item.id : null));
  if (value.taskScopes !== undefined) {
    if (!Array.isArray(value.taskScopes) || value.taskScopes.length > 5_000) throw new TypeError('Execution Graph task membership is invalid.');
    const roots = new Set(value.nodes.filter(node => record(node) && node.kind === 'goal').map(node => (node as Record<string, unknown>).id));
    const taskIds = new Set<string>();
    for (const scope of value.taskScopes) {
      if (roots.size !== 1 || !record(scope) || !stringValue(scope.taskId) || taskIds.has(scope.taskId as string)
        || !Array.isArray(scope.nodeIds) || !scope.nodeIds.length || scope.nodeIds.some(id => typeof id !== 'string' || !nodeIds.has(id) || roots.has(id))
        || !Array.isArray(scope.transcriptIds) || scope.transcriptIds.some(id => typeof id !== 'string' || !transcriptIds.has(id))) throw new TypeError('Execution Graph task membership is invalid.');
      taskIds.add(scope.taskId as string);
    }
  }
  for (const edge of value.edges) if (!record(edge) || !stringValue(edge.id) || !stringValue(edge.kind) || !stringValue(edge.from) || !stringValue(edge.to) || !nodeIds.has(edge.from as string) || !nodeIds.has(edge.to as string) || !Array.isArray(edge.sourceOpIds)) throw new TypeError('Execution Graph edge is invalid.');
  for (const item of value.transcript) if (!record(item) || !stringValue(item.id) || !stringValue(item.kind) || !stringValue(item.role) || !stringValue(item.timestamp) || !stringValue(item.title) || typeof item.body !== 'string' || !Array.isArray(item.sourceOpIds) || !Array.isArray(item.graphNodeIds)) throw new TypeError('Execution Graph transcript item is invalid.');
  const { digest, ...semantic } = value;
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(digest)) || sha256Digest(canonicalStringify(semantic as JsonValue)) !== digest) throw new TypeError('Execution Graph digest is invalid.');
  return deepFreeze(value) as unknown as ExecutionGraphReadModel;
}

function validatePrefix(sessionId: M13StableId, ops: readonly SessionOpV1[], diagnostics: ExecutionGraphDiagnosticReadModel[]): void {
  let expected = 0;
  for (const op of ops) {
    if (op.sessionId !== sessionId || op.sequence !== expected) diagnostics.push(freeze({ code: 'graph.sequence-gap', message: `Expected sequence ${expected}; received ${op.sequence} for ${op.id}.`, sourceOpId: op.id }));
    expected = op.sequence + 1;
  }
}

function graphNodeIdFor(op: SessionOpV1, sessionId: M13StableId): M13StableId | null {
  if (op.kind === 'session.created' || op.kind === 'session.status-changed' || op.kind === 'session.checkpointed' || op.kind === 'backend.bound' || op.kind === 'backend.detached') return graphId('goal', sessionId);
  if (op.kind === 'turn.started') return op.turnId ? graphId('turn', op.turnId) : null;
  if (op.kind === 'turn.completed') return graphId('result', op.id);
  if (op.kind.startsWith('tool-batch.')) return op.nodeId ? graphId('tool', op.nodeId) : op.batchId ? graphId('batch', op.batchId) : null;
  if (op.kind.startsWith('tool.')) return op.nodeId ? graphId('tool', op.nodeId) : null;
  if (op.kind.startsWith('approval.')) return graphId('barrier', stringValue(op.payload.approvalId) ?? op.nodeId ?? op.id);
  if (op.kind.startsWith('question.')) return graphId(stringValue(op.payload.barrierKind) === 'plan-review' ? 'plan' : 'barrier', stringValue(op.payload.questionId) ?? op.nodeId ?? op.id);
  if (op.kind === 'document.committed') return graphId('transaction', stringValue(op.payload.transactionId) ?? op.id);
  if (op.kind.startsWith('compaction.')) return graphId('compaction', op.nodeId ?? op.id);
  if (op.kind === 'evidence.captured') return graphId('evidence', op.nodeId ?? op.artifactRefs[0] ?? op.id);
  if (op.kind === 'evaluation.completed') return graphId('evaluation', op.nodeId ?? op.artifactRefs[0] ?? op.id);
  if (op.kind === 'user.message' || op.kind === 'assistant.message') return op.turnId ? graphId('turn', op.turnId) : graphId('goal', sessionId);
  return graphId('unknown', op.id);
}

function describeOp(op: SessionOpV1, activeGoal: string | null): Readonly<{ kind: ExecutionGraphProductNodeKind; status: ExecutionGraphProductNodeStatus; title: string; summary: string }> {
  const payloadStatus = stringValue(op.payload.status);
  switch (op.kind) {
    case 'session.created': return freeze({ kind: 'goal', status: 'pending', title: safeText(activeGoal ?? op.payload.activeGoal, 'Agent task'), summary: 'Session created.' });
    case 'session.status-changed': return freeze({ kind: 'goal', status: productStatus(payloadStatus), title: safeText(activeGoal, 'Agent task'), summary: safeText(op.payload.reason, `Session ${payloadStatus ?? 'updated'}.`) });
    case 'session.checkpointed': return freeze({ kind: 'goal', status: 'running', title: safeText(activeGoal, 'Agent task'), summary: 'Safe recovery checkpoint saved.' });
    case 'backend.bound': return freeze({ kind: 'goal', status: 'running', title: safeText(activeGoal, 'Agent task'), summary: 'Backend session connected.' });
    case 'backend.detached': return freeze({ kind: 'goal', status: 'waiting', title: safeText(activeGoal, 'Agent task'), summary: 'Backend session disconnected.' });
    case 'turn.started': return freeze({ kind: 'turn', status: 'running', title: safeText(op.payload.title, 'Agent turn'), summary: safeText(op.payload.summary, 'Agent is working on the request.') });
    case 'turn.completed': return freeze({ kind: 'result', status: productStatus(payloadStatus), title: `Turn ${payloadStatus ?? 'completed'}`, summary: safeText(op.payload.summary, 'Agent turn finished.') });
    case 'user.message': return freeze({ kind: 'turn', status: 'running', title: 'User request', summary: 'User supplied additional direction.' });
    case 'assistant.message': return freeze({ kind: 'turn', status: 'running', title: 'Agent response', summary: 'Agent produced a response.' });
    case 'tool-batch.planned': return freeze({ kind: op.nodeId ? 'tool' : 'tool-batch', status: 'pending', title: op.nodeId ? toolTitle(op) : 'Tool batch', summary: op.nodeId ? toolSummary(op) : 'Tool work was planned.' });
    case 'tool-batch.started': return freeze({ kind: 'tool-batch', status: 'running', title: 'Tool batch', summary: 'Independent ready tools are being scheduled.' });
    case 'tool-batch.completed': return freeze({ kind: 'tool-batch', status: productStatus(payloadStatus), title: 'Tool batch', summary: batchSummary(op) });
    case 'tool.started': return freeze({ kind: 'tool', status: 'running', title: toolTitle(op), summary: toolSummary(op) });
    case 'tool.completed': return freeze({ kind: 'tool', status: productStatus(payloadStatus), title: toolTitle(op), summary: safeText(op.payload.summary, `${stringValue(op.payload.toolId) ?? 'Tool'} ${payloadStatus ?? 'completed'}.`) });
    case 'tool.outcome-unknown': return freeze({ kind: 'tool', status: 'outcome-unknown', title: toolTitle(op), summary: safeText(op.payload.reason, 'The effect outcome must be reconciled before retrying.') });
    case 'approval.requested': return freeze({ kind: 'approval', status: 'waiting', title: 'Approval required', summary: safeText(op.payload.reason, safeText(op.payload.toolId, 'A protected action needs approval.')) });
    case 'approval.resolved': return freeze({ kind: 'approval', status: op.payload.denied === true ? 'cancelled' : 'completed', title: 'Approval resolved', summary: `Decision: ${stringValue(op.payload.resolution) ?? 'recorded'}.` });
    case 'question.requested': return freeze({ kind: stringValue(op.payload.barrierKind) === 'plan-review' ? 'plan' : 'question', status: 'waiting', title: barrierTitle(op), summary: safeText(op.payload.reason, 'Agent needs user input.') });
    case 'question.resolved': return freeze({ kind: 'question', status: stringValue(op.payload.resolution) === 'cancelled' ? 'cancelled' : 'completed', title: 'User input received', summary: `Resolution: ${stringValue(op.payload.resolution) ?? 'answered'}.` });
    case 'document.committed': return freeze({ kind: 'transaction', status: 'completed', title: 'Project changes committed', summary: revisionSummary(op) });
    case 'evidence.captured': return freeze({ kind: 'evidence', status: 'completed', title: safeText(op.payload.evidenceType, 'Evidence captured'), summary: safeText(op.payload.summary, `${op.artifactRefs.length} evidence artifact(s).`) });
    case 'evaluation.completed': return freeze({ kind: 'evaluation', status: productStatus(payloadStatus), title: 'Validation result', summary: safeText(op.payload.summary, `Evaluation ${payloadStatus ?? 'completed'}.`) });
    case 'compaction.requested': return freeze({ kind: 'compaction', status: 'pending', title: 'Context compaction', summary: compactionSummary(op) });
    case 'compaction.started': return freeze({ kind: 'compaction', status: 'running', title: 'Context compaction', summary: compactionSummary(op) });
    case 'compaction.summary-created': return freeze({ kind: 'compaction', status: 'running', title: 'Context summary created', summary: compactionSummary(op) });
    case 'compaction.completed': return freeze({ kind: 'compaction', status: 'completed', title: 'Context compacted', summary: compactionSummary(op) });
    case 'compaction.failed': return freeze({ kind: 'compaction', status: 'failed', title: 'Context compaction failed', summary: compactionSummary(op) });
    default: return freeze({ kind: 'unknown', status: 'waiting', title: `Unsupported operation: ${String(op.kind)}`, summary: 'A newer Session operation is present. Update Studio to inspect it.' });
  }
}

function foldNode(node: MutableNode, op: SessionOpV1, descriptor: ReturnType<typeof describeOp>): void {
  node.kind = node.kind === 'unknown' ? descriptor.kind : node.kind;
  node.status = descriptor.status;
  node.title = descriptor.title;
  node.summary = descriptor.summary;
  node.turnId ??= op.turnId;
  node.batchId ??= op.batchId;
  node.sourceNodeId ??= op.nodeId;
  node.sourceOpIds.push(op.id);
  node.artifactRefs.push(...op.artifactRefs);
  if (op.kind === 'tool.started' || op.kind === 'tool-batch.started' || op.kind === 'compaction.started' || op.kind === 'turn.started') node.startedAt = op.timestamp;
  if (node.projectRevisionBefore === null) node.projectRevisionBefore = numberValue(op.payload.beforeRevision) ?? op.projectRevision;
  node.projectRevisionAfter = numberValue(op.payload.afterRevision) ?? op.projectRevision ?? node.projectRevisionAfter;
  if (terminalStatuses.has(descriptor.status) || descriptor.status === 'outcome-unknown') node.completedAt = op.timestamp;
  node.toolId = stringValue(op.payload.toolId) ?? node.toolId;
  node.toolVersion = stringValue(op.payload.toolVersion) ?? node.toolVersion;
  node.executionClass = stringValue(op.payload.executionClass) ?? node.executionClass;
  node.barrierKind = stringValue(op.payload.barrierKind) ?? node.barrierKind;
  node.transactionId = stringValue(op.payload.transactionId) ?? node.transactionId;
  const usage = stringValue(op.payload.usageRecordId); if (usage) node.usageRecordIds.push(usage);
  const cost = stringValue(op.payload.costRecordId); if (cost) node.costRecordIds.push(cost);
  node.diagnostic = stringValue(op.payload.diagnostic) ?? stringValue(op.payload.code) ?? node.diagnostic;
  node.validation = stringValue(op.payload.validation) ?? node.validation;
}

function ensureStructuralParents(op: SessionOpV1, sessionId: M13StableId, rootId: M13StableId, nodes: Map<M13StableId, MutableNode>, edges: Map<M13StableId, MutableEdge>): M13StableId {
  if (!op.turnId) return rootId;
  const turnId = graphId('turn', op.turnId);
  if (!nodes.has(turnId)) nodes.set(turnId, mutableNode({ id: turnId, kind: 'turn', status: 'running', title: 'Agent turn', summary: 'Turn reconstructed from child operations.', turnId: op.turnId, startedAt: op.timestamp }));
  addEdge(edges, 'contains', rootId, turnId, op.id);
  if (!op.batchId || graphNodeIdFor(op, sessionId) === graphId('batch', op.batchId)) return turnId;
  const batchId = graphId('batch', op.batchId);
  if (!nodes.has(batchId)) nodes.set(batchId, mutableNode({ id: batchId, kind: 'tool-batch', status: 'pending', title: 'Tool batch', summary: 'Batch reconstructed from member tools.', turnId: op.turnId, batchId: op.batchId, startedAt: op.timestamp }));
  addEdge(edges, 'contains', turnId, batchId, op.id);
  return batchId;
}

function connectTransaction(op: SessionOpV1, transactionNodeId: M13StableId, nodes: Map<M13StableId, MutableNode>, edges: Map<M13StableId, MutableEdge>, sourceNodeToGraphNode: Map<M13StableId, M13StableId>): void {
  const memberIds = arrayOfStrings(op.payload.memberNodeIds);
  for (const memberId of memberIds) {
    const tool = sourceNodeToGraphNode.get(memberId) ?? graphId('tool', memberId);
    if (nodes.has(tool)) addEdge(edges, 'modified', tool, transactionNodeId, op.id);
  }
}

function connectBarrier(op: SessionOpV1, barrierNodeId: M13StableId, edges: Map<M13StableId, MutableEdge>, sourceNodeToGraphNode: Map<M13StableId, M13StableId>): void {
  const toolCallId = stringValue(op.payload.toolCallId);
  if (!toolCallId) return;
  const tool = sourceNodeToGraphNode.get(toolCallId) ?? graphId('tool', toolCallId);
  addEdge(edges, 'blocked-by', tool, barrierNodeId, op.id);
}

function connectEvidence(op: SessionOpV1, evidenceNodeId: M13StableId, nodes: Map<M13StableId, MutableNode>, edges: Map<M13StableId, MutableEdge>): void {
  const transactionId = stringValue(op.payload.transactionId);
  if (transactionId) {
    const transaction = graphId('transaction', transactionId);
    if (nodes.has(transaction)) addEdge(edges, 'validated-by', transaction, evidenceNodeId, op.id);
  }
  const targetNodeId = stringValue(op.payload.targetNodeId) ?? stringValue(op.payload.toolNodeId);
  if (targetNodeId) {
    const target = graphId('tool', targetNodeId);
    if (nodes.has(target)) addEdge(edges, 'validated-by', target, evidenceNodeId, op.id);
  }
}

function connectCompaction(op: SessionOpV1, compactionNodeId: M13StableId, ops: readonly SessionOpV1[], opToGraphNode: Map<M13StableId, M13StableId>, edges: Map<M13StableId, MutableEdge>): void {
  const record = compactionRecord(op.payload.compaction);
  if (!record) return;
  for (const source of ops) {
    if (source.sequence < record.coveredStartSequence || source.sequence > record.coveredEndSequence) continue;
    const from = opToGraphNode.get(source.id);
    if (from && from !== compactionNodeId) addEdge(edges, 'compacted-into', from, compactionNodeId, op.id);
  }
}

function addReferenceEdge(kind: ExecutionGraphProductEdgeKind, reference: M13StableId, to: M13StableId, op: SessionOpV1, opToGraphNode: Map<M13StableId, M13StableId>, sourceNodeToGraphNode: Map<M13StableId, M13StableId>, edges: Map<M13StableId, MutableEdge>, diagnostics: ExecutionGraphDiagnosticReadModel[]): void {
  const from = opToGraphNode.get(reference) ?? sourceNodeToGraphNode.get(reference);
  if (!from) {
    diagnostics.push(freeze({ code: 'graph.reference-missing', message: `Operation ${op.id} references missing dependency ${reference}.`, sourceOpId: op.id }));
    return;
  }
  if (from !== to) addEdge(edges, kind, from, to, op.id);
}

function connectParallelIntervals(intervals: Map<M13StableId, Readonly<{ batchId: M13StableId; startedAt: number; completedAt: number | null }>>, edges: Map<M13StableId, MutableEdge>): void {
  const entries = [...intervals.entries()];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const [leftId, left] = entries[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [rightId, right] = entries[rightIndex]!;
      if (left.batchId !== right.batchId) continue;
      const leftEnd = left.completedAt ?? Number.POSITIVE_INFINITY;
      const rightEnd = right.completedAt ?? Number.POSITIVE_INFINITY;
      if (left.startedAt < rightEnd && right.startedAt < leftEnd) addEdge(edges, 'parallel-with', leftId, rightId, `parallel:${left.batchId}`);
    }
  }
}

function transcriptItemFor(op: SessionOpV1, graphNodeId: M13StableId, descriptor: ReturnType<typeof describeOp>): ExecutionTranscriptItemReadModel | null {
  let kind: ExecutionTranscriptItemReadModel['kind'] | null = null;
  let role: ExecutionTranscriptItemReadModel['role'] = 'system';
  if (op.kind === 'approval.requested' || op.kind === 'approval.resolved' || op.kind === 'question.requested' || op.kind === 'question.resolved') kind = 'barrier';
  else if (op.kind === 'compaction.completed' || op.kind === 'compaction.failed') kind = 'compaction';
  else if (op.kind === 'tool.outcome-unknown') kind = 'recovery';
  else if (op.kind === 'turn.completed') kind = 'result';
  else if (op.kind === 'session.checkpointed' && op.payload.recoveredAfterRestart === true) kind = 'recovery';
  if (!kind) return null;
  return freeze({ id: graphId('transcript', op.id), kind, role, timestamp: op.timestamp, title: descriptor.title, body: descriptor.summary, status: descriptor.status, sourceOpIds: freeze([op.id]), graphNodeIds: freeze([graphNodeId]), artifactRefs: freeze([...op.artifactRefs]) });
}

function contextModel(pressure: ContextPressureV1 | null, latestCompaction: CompactionRecordV1 | null, nodes: readonly ExecutionGraphNodeReadModel[]): ExecutionGraphContextReadModel {
  const blocker = nodes.find((node) => node.status === 'waiting' || node.status === 'outcome-unknown');
  const running = nodes.find((node) => node.kind === 'tool' || node.kind === 'tool-batch' ? node.status === 'running' : false);
  const compactionBlockedReason = blocker ? `Resolve ${blocker.title} before compacting.` : running ? 'Wait for the active tool batch to reach a safe boundary.' : null;
  return freeze({ pressure, latestCompaction, compactionAvailable: compactionBlockedReason === null && pressure !== null, compactionBlockedReason });
}

function calculateCriticalPath(nodes: readonly ExecutionGraphNodeReadModel[], edges: readonly ExecutionGraphEdgeReadModel[]): M13StableId[] {
  const relevant = new Set<ExecutionGraphProductEdgeKind>(['depends-on', 'contains', 'blocked-by', 'validated-by', 'modified']);
  const incoming = new Map<M13StableId, M13StableId[]>();
  for (const edge of edges) if (relevant.has(edge.kind)) (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to)!).push(edge.from);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const score = new Map<M13StableId, number>();
  const previous = new Map<M13StableId, M13StableId>();
  const visiting = new Set<M13StableId>();
  const visit = (id: M13StableId): number => {
    const cached = score.get(id); if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0; let parent: M13StableId | null = null;
    for (const candidate of incoming.get(id) ?? []) {
      if (!nodeIds.has(candidate)) continue;
      const value = visit(candidate);
      if (value > best) { best = value; parent = candidate; }
    }
    visiting.delete(id);
    const node = nodes.find((item) => item.id === id)!;
    const value = best + Math.max(1, node.durationMs ?? 1);
    score.set(id, value); if (parent) previous.set(id, parent); return value;
  };
  let tail: M13StableId | null = null; let best = -1;
  for (const node of nodes) { const value = visit(node.id); if (value > best || (value === best && node.id.localeCompare(tail ?? '') < 0)) { best = value; tail = node.id; } }
  const path: M13StableId[] = [];
  while (tail) { path.unshift(tail); tail = previous.get(tail) ?? null; }
  return path;
}

function mutableNode(input: Partial<MutableNode> & Pick<MutableNode, 'id' | 'kind' | 'status' | 'title' | 'summary' | 'startedAt'>): MutableNode {
  return { turnId: null, batchId: null, sourceNodeId: null, sourceOpIds: [], artifactRefs: [], projectRevisionBefore: null, projectRevisionAfter: null, completedAt: null, toolId: null, toolVersion: null, executionClass: null, barrierKind: null, transactionId: null, usageRecordIds: [], costRecordIds: [], diagnostic: null, validation: null, ...input };
}

function freezeNode(node: MutableNode): ExecutionGraphNodeReadModel {
  const started = Date.parse(node.startedAt); const completed = node.completedAt ? Date.parse(node.completedAt) : Number.NaN;
  return freeze({
    id: node.id, kind: node.kind, status: node.status, title: safeText(node.title, 'Untitled step'), summary: safeText(node.summary, ''), turnId: node.turnId, batchId: node.batchId, sourceNodeId: node.sourceNodeId,
    sourceOpIds: freeze(unique(node.sourceOpIds).sort()), artifactRefs: freeze(unique(node.artifactRefs).sort()), projectRevisionBefore: node.projectRevisionBefore, projectRevisionAfter: node.projectRevisionAfter,
    startedAt: node.startedAt, completedAt: node.completedAt, durationMs: Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : null,
    detail: freeze({ toolId: node.toolId, toolVersion: node.toolVersion, executionClass: node.executionClass, barrierKind: node.barrierKind, transactionId: node.transactionId, usageRecordIds: freeze(unique(node.usageRecordIds).sort()), costRecordIds: freeze(unique(node.costRecordIds).sort()), diagnostic: node.diagnostic, validation: node.validation }),
  });
}

function addEdge(edges: Map<M13StableId, MutableEdge>, kind: ExecutionGraphProductEdgeKind, from: M13StableId, to: M13StableId, sourceOpId: M13StableId): void {
  if (from === to) return;
  const id = graphId('edge', `${kind}:${from}:${to}`);
  const existing = edges.get(id);
  if (existing) { existing.sourceOpIds.push(sourceOpId); return; }
  edges.set(id, { id, kind, from, to, sourceOpIds: [sourceOpId] });
}

function productStatus(value: string | null): ExecutionGraphProductNodeStatus {
  if (value === 'completed' || value === 'passed' || value === 'success' || value === 'idle') return 'completed';
  if (value === 'failed' || value === 'error' || value === 'blocked') return 'failed';
  if (value === 'cancelled' || value === 'interrupted' || value === 'denied') return 'cancelled';
  if (value === 'waiting' || value === 'waiting-user' || value === 'waiting-approval') return 'waiting';
  if (value === 'running' || value === 'compacting') return 'running';
  return 'completed';
}

function sessionStatus(value: string | undefined, ops: readonly SessionOpV1[]): ExecutionGraphProductNodeStatus {
  if (value) return productStatus(value);
  const lastTurn = [...ops].reverse().find((op) => op.kind === 'turn.completed' || op.kind === 'turn.started');
  if (!lastTurn) return 'pending';
  return lastTurn.kind === 'turn.started' ? 'running' : productStatus(stringValue(lastTurn.payload.status));
}

function compactionRecord(value: unknown): CompactionRecordV1 | null {
  if (!record(value) || typeof value.id !== 'string' || !record(value.before) || !Array.isArray(value.pinnedFactDigests)) return null;
  const before = contextPressure(value.before); const after = value.after === null ? null : contextPressure(value.after);
  if (!before || (value.after !== null && !after)) return null;
  return freeze(value) as unknown as CompactionRecordV1;
}

function contextPressure(value: unknown): ContextPressureV1 | null {
  if (!record(value) || !['normal', 'warning', 'preparing', 'compact-required', 'emergency', 'unknown'].includes(String(value.state))) return null;
  return freeze(value) as unknown as ContextPressureV1;
}

function compactionSummary(op: SessionOpV1): string {
  const value = compactionRecord(op.payload.compaction);
  if (!value) return 'Context compaction record is unavailable.';
  const before = value.before.ratio === null ? 'unknown' : `${Math.round(value.before.ratio * 100)}%`;
  const after = value.after?.ratio === null || value.after === null ? 'unknown' : `${Math.round(value.after.ratio * 100)}%`;
  return `${value.reason}; context ${before} → ${after}; covered operations ${value.coveredStartSequence}–${value.coveredEndSequence}; validation ${value.validation}.`;
}

function batchSummary(op: SessionOpV1): string {
  const completed = numberValue(op.payload.completed) ?? 0; const failed = numberValue(op.payload.failed) ?? 0; const cancelled = numberValue(op.payload.cancelled) ?? 0;
  return `${completed} completed, ${failed} failed, ${cancelled} cancelled.`;
}

function revisionSummary(op: SessionOpV1): string {
  const before = numberValue(op.payload.beforeRevision); const after = numberValue(op.payload.afterRevision);
  return before === null || after === null ? 'A project transaction was committed.' : `Project revision r${before} → r${after}.`;
}

function toolTitle(op: SessionOpV1): string { return safeText(op.payload.toolId, 'Tool'); }
function toolSummary(op: SessionOpV1): string { return `${stringValue(op.payload.executionClass) ?? 'bounded'} · ${arrayOfStrings(op.payload.effects).join(', ') || 'effect unknown'}`; }
function barrierTitle(op: SessionOpV1): string { return stringValue(op.payload.barrierKind) === 'budget-continuation' ? 'Budget continuation' : stringValue(op.payload.barrierKind) === 'plan-review' ? 'Plan review' : 'Agent question'; }
function graphId(prefix: string, value: string): M13StableId { return `${prefix}:${value}`; }
function safeText(value: unknown, fallback: string, max = 2_048): string { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback; }
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function arrayOfStrings(value: unknown): M13StableId[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []; }
function record(value: unknown): value is Readonly<Record<string, unknown>> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function freeze<T>(value: T): Readonly<T> { return Object.freeze(value); }
function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
function compareNodes(left: ExecutionGraphNodeReadModel, right: ExecutionGraphNodeReadModel): number { return left.startedAt.localeCompare(right.startedAt) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id); }
function compareEdges(left: ExecutionGraphEdgeReadModel, right: ExecutionGraphEdgeReadModel): number { return left.kind.localeCompare(right.kind) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to); }

function canonicalStringify(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(object[key]!)}`).join(',')}}`;
}

function sha256Digest(value: string): `sha256:${string}` {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength); data.set(bytes); data[bytes.length] = 0x80;
  const bitLength = bytes.length * 8; const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false); view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const constants = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) { const a = words[index - 15]!; const b = words[index - 2]!; const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3); const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10); words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index += 1) { const s1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25); const choice = (e! & f!) ^ (~e! & g!); const t1 = (h! + s1 + choice + constants[index]! + words[index]!) >>> 0; const s0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22); const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!); const t2 = (s0 + majority) >>> 0; h=g; g=f; f=e; e=(d!+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0; }
    hash[0]=(hash[0]!+a!)>>>0; hash[1]=(hash[1]!+b!)>>>0; hash[2]=(hash[2]!+c!)>>>0; hash[3]=(hash[3]!+d!)>>>0; hash[4]=(hash[4]!+e!)>>>0; hash[5]=(hash[5]!+f!)>>>0; hash[6]=(hash[6]!+g!)>>>0; hash[7]=(hash[7]!+h!)>>>0;
  }
  return `sha256:${[...hash].map((word) => word.toString(16).padStart(8, '0')).join('')}`;
}

function rotate(value: number, bits: number): number { return (value >>> bits) | (value << (32 - bits)); }
