import { enrichExecutionContent } from './execution-content.js';
import type { CompactionRecordV1, ContextPressureV1, JsonValue, M13StableId, SessionOpV1 } from '@haiyue/ai-studio-contracts';
import type { ConversationNodeReadModel, ConversationTaskRunReadModel } from './types.js';
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
  reason: string | null;
  diagnostic: string | null;
  validation: string | null;
  modelExplanation?: string | null;
  actionSummary?: string | null;
  resultSummary?: string | null;
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
  const questionNodes = new Map<string, M13StableId>();
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
    // Resolution events identify the question but need not repeat its barrier kind.
    // Reuse the request coordinate so plan reviews and their answers are one node.
    const questionId = op.kind.startsWith('question.') ? stringValue(op.payload.questionId) ?? op.nodeId ?? op.id : null;
    const graphNodeId = (questionId ? questionNodes.get(questionId) : null) ?? graphNodeIdFor(op, input.sessionId);
    if (questionId && graphNodeId && op.kind === 'question.requested') questionNodes.set(questionId, graphNodeId);
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
        turnNode.reason = node.reason;
        turnNode.diagnostic = node.diagnostic;
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

  // Barrier answers can be appended to an already released turn. Messages are
  // transcript facts; only a subsequent turn.started may reopen that execution.
  const turnLifecycle = new Map(ops.filter(op => op.turnId && (op.kind === 'turn.started' || op.kind === 'turn.completed')).map(op => [op.turnId!, op]));
  for (const [turnId, lifecycle] of turnLifecycle) {
    const node = nodes.get(graphId('turn', turnId));
    if (!node) continue;
    const result = lifecycle.kind === 'turn.completed' ? nodes.get(graphId('result', lifecycle.id)) : null;
    node.status = result?.status ?? 'running';
    node.completedAt = result ? lifecycle.timestamp : null;
    node.reason = result?.reason ?? null;
    node.diagnostic = result?.diagnostic ?? null;
    if (result) node.summary = result.summary;
  }

  projectConfirmationCheckpoints(ops, nodes, edges, opToGraphNode, turnLifecycle, transcript);

  // Preserve authoritative turn/result causes before inserting presentation groups.
  summarizeTerminalReasons(nodes, edges);
  projectModelRounds(ops, nodes, edges, transcript);
  enrichExecutionContent(input, ops, nodes, [...edges.values()], transcript);
  const root = nodes.get(rootId);
  if (root) {
    root.status = sessionStatus(input.status, ops);
    const latestTurn = [...turnLifecycle.values()].at(-1);
    const turnStatus = latestTurn ? nodes.get(graphId('turn', latestTurn.turnId!))?.status : null;
    if (latestTurn?.kind === 'turn.completed' && turnStatus && turnStatus !== productStatus(stringValue(latestTurn.payload.status))) root.status = turnStatus;
  }

  summarizeTerminalReasons(nodes, edges);

  const frozenNodes = freeze([...nodes.values()].map(freezeNode).sort(compareNodes));
  const frozenEdges = freeze([...edges.values()].map((edge) => freeze({ ...edge, sourceOpIds: freeze(unique(edge.sourceOpIds).sort()) })).sort(compareEdges));
  const currentNodeIds = freeze(currentExecutionNodeIds(frozenNodes, frozenEdges));
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

/** A provider turn can contain many tool/response round trips. Keep its lifecycle
 * node, but give each observable model phase its own stable, replayable coordinate.
 * These are product phases, not invented provider request/token records. */
function projectModelRounds(ops: readonly SessionOpV1[], nodes: Map<string, MutableNode>, edges: Map<string, MutableEdge>, transcript: ExecutionTranscriptItemReadModel[]): void {
  const turns = [...nodes.values()].filter(node => node.kind === 'turn');
  for (const turn of turns) {
    const history = ops.filter(op => op.turnId === turn.turnId);
    if (!history.length) continue;
    const children = [...nodes.values()].filter(node => node.turnId === turn.turnId && node.id !== turn.id);
    const byOp = new Map<string, MutableNode>(), byWork = new Map<string, MutableNode>();
    const barrierOwners = new Map<string, MutableNode>();
    const answerSummary = (op: SessionOpV1) => op.payload.denied === true || op.payload.resolution === 'cancelled' ? '确认未通过，本轮未继续执行。' : '用户已确认，本轮处理结果见下方节点。';
    const open = new Set<string>(), rounds: MutableNode[] = [];
    const state: { current: MutableNode | null; last: MutableNode | null } = { current: null, last: null };
    let anchor = history[0]!, closed = false;
    const begin = () => {
      const node = mutableNode({ id: graphId('model', anchor.id), kind: 'model', turnId: turn.turnId,
        status: 'running', title: `模型处理 · 第 ${rounds.length + 1} 轮`, summary: rounds.length ? '根据工具返回结果，生成下一步操作或回复。' : '理解请求，生成方案或工具调用。',
        startedAt: anchor.timestamp, sourceOpIds: [anchor.id], projectRevisionBefore: anchor.projectRevision, projectRevisionAfter: anchor.projectRevision });
      rounds.push(node); nodes.set(node.id, node); addEdge(edges, 'contains', turn.id, node.id, anchor.id);
      state.current = node; state.last = node; return node;
    };
    const finish = (node: MutableNode, op: SessionOpV1) => {
      if (node.status !== 'running') return;
      node.status = 'completed'; node.completedAt = op.timestamp;
      node.projectRevisionAfter = op.projectRevision ?? node.projectRevisionAfter;
    };
    for (const op of history) {
      if (op.kind === 'turn.started') { closed = false; open.clear(); state.current = null; anchor = op; begin(); }
      const barrierKey = stringValue(op.payload.questionId) ?? stringValue(op.payload.approvalId) ?? op.nodeId;
      const answered = op.kind === 'question.resolved' || op.kind === 'approval.resolved';
      const answerOwner = answered && barrierKey ? barrierOwners.get(barrierKey) : null;
      // Late checkpoint answers/messages cannot start another model round.
      if (closed) {
        const owner = answerOwner ?? state.last;
        if (owner) { byOp.set(op.id, owner); owner.sourceOpIds.push(op.id); if (answered) owner.summary = answerSummary(op); }
        continue;
      }
      const work = op.batchId ? `batch:${op.batchId}` : op.kind.startsWith('tool.') && op.nodeId ? `tool:${op.nodeId}` : null;
      const launches = op.kind === 'tool-batch.planned' || op.kind === 'tool-batch.started' || op.kind === 'tool.started';
      if (work && launches && !byWork.has(work)) {
        const model = state.current ?? begin(); byWork.set(work, model); open.add(work);
        finish(model, op); model.summary = '已生成工具调用，执行结果见本轮下方节点。';
      }
      if (op.kind === 'assistant.message' && !state.current && open.size === 0) begin();
      if (op.kind === 'turn.completed' && !state.current && !open.size && !nodes.get(graphId('result', op.id))?.barrierKind) begin();
      if (!state.last) begin();
      const owner = answerOwner ?? (work ? byWork.get(work) : null) ?? state.current ?? state.last!;
      byOp.set(op.id, owner); owner.sourceOpIds.push(op.id);
      if (op.kind === 'assistant.message') {
        owner.artifactRefs.push(...op.artifactRefs);
        owner.summary = '模型正在输出回复。';
      }
      if (op.kind === 'question.requested' || op.kind === 'approval.requested') {
        if (barrierKey) barrierOwners.set(barrierKey, owner);
        finish(owner, op); owner.summary = '已提出确认请求，等待用户处理。';
      }
      if (op.kind === 'tool-batch.completed' || !op.batchId && (op.kind === 'tool.completed' || op.kind === 'tool.outcome-unknown')) {
        finish(owner, op);
        if (work) open.delete(work);
        if (!open.size) { state.current = null; anchor = op; }
      }
      if (answered) {
        owner.summary = answerSummary(op);
        if (!open.size && (owner === state.current || !state.current && owner === state.last)) { state.current = null; anchor = op; }
      }
      if (op.kind === 'turn.completed') {
        if (state.current?.status === 'running') {
          const result = nodes.get(graphId('result', op.id));
          state.current.status = result?.status ?? productStatus(stringValue(op.payload.status));
          state.current.completedAt = state.current.status === 'waiting' ? null : op.timestamp;
          state.current.summary = result?.summary ?? '本轮模型处理已结束。';
          state.current.reason = result?.reason ?? null; state.current.diagnostic = result?.diagnostic ?? null;
        }
        closed = true;
      }
    }
    const activeChildren = children.some(node => activeStatuses.has(node.status));
    if (!closed && turn.status === 'running' && !activeChildren && !state.current) begin();
    // An enclosing terminal/pause state must never leave a synthesized spinner alive.
    for (const model of rounds) if (model.status === 'running' && turn.status !== 'running') {
      model.status = turn.status; model.completedAt = turn.completedAt; model.reason = turn.reason; model.diagnostic = turn.diagnostic;
    }
    for (const child of children) {
      const owner = (child.batchId ? byWork.get(`batch:${child.batchId}`) : null) ?? child.sourceOpIds.map(id => byOp.get(id)).find(Boolean);
      if (!owner) continue;
      for (const [id, edge] of edges) if (edge.kind === 'contains' && edge.from === turn.id && edge.to === child.id) {
        edges.delete(id); for (const source of edge.sourceOpIds) addEdge(edges, 'contains', owner.id, child.id, source);
      }
    }
    for (let i = 0; i < transcript.length; i++) {
      const item = transcript[i]!;
      if (item.kind !== 'message' || item.role !== 'assistant') continue;
      const owner = item.sourceOpIds.map(id => byOp.get(id)).find(Boolean);
      if (owner) transcript[i] = freeze({ ...item, graphNodeIds: freeze([owner.id]) });
    }
    turn.title = '执行阶段';
    turn.summary = `${rounds.length} 轮模型处理 · ${turn.summary}`;
  }
}

/** Show the active frontier, not every enclosing goal/turn. Human barriers take
 * precedence over tools waiting for their resolution. Keep concurrent tools. */
function currentExecutionNodeIds(nodes: readonly Pick<ExecutionGraphNodeReadModel, 'id' | 'status' | 'kind' | 'turnId'>[], edges: readonly Pick<ExecutionGraphEdgeReadModel, 'kind' | 'from' | 'to'>[]): string[] {
  const active = nodes.filter(node => activeStatuses.has(node.status));
  const waitingTurns = new Set(active.filter(node => node.status === 'waiting' && ['approval', 'question', 'plan'].includes(node.kind)).map(node => node.turnId));
  const candidates = new Set(active.filter(node => !waitingTurns.has(node.turnId) || ['approval', 'question', 'plan'].includes(node.kind)).map(node => node.id));
  const parents = new Map<string, string[]>();
  for (const edge of edges) if (edge.kind === 'contains') parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
  for (const node of active) {
    const visited = new Set<string>(); const queue = [...(parents.get(node.id) ?? [])];
    while (queue.length) { const id = queue.pop()!; if (visited.has(id)) continue; visited.add(id); candidates.delete(id); queue.push(...(parents.get(id) ?? [])); }
  }
  return active.filter(node => candidates.has(node.id)).map(node => node.id);
}

/** Provider cancellation at a persisted human checkpoint is a pause in the product.
 * Keep the journal intact, use an explicit checkpoint identity, and support the
 * exact historical host marker only when a matching request exists in this turn. */
function projectConfirmationCheckpoints(ops: readonly SessionOpV1[], nodes: Map<string, MutableNode>, edges: Map<string, MutableEdge>, opNodes: Map<string, string>, lifecycle: Map<string, SessionOpV1>, transcript: ExecutionTranscriptItemReadModel[]): void {
  const kinds = new Map(ops.map(op => [op.id, op.kind]));
  const legacyReason = '已保存用户确认检查点并释放当前调用，确认后可继续；已完成的修改保留。';
  for (const end of ops) {
    if (end.kind !== 'turn.completed' || !end.turnId || !['cancelled', 'interrupted'].includes(String(end.payload.status))) continue;
    const checkpointId = stringValue(end.payload.suspendedBarrierId);
    if (!checkpointId && end.payload.reason !== legacyReason) continue;
    const start = ops.filter(op => op.turnId === end.turnId && op.kind === 'turn.started' && op.sequence < end.sequence).at(-1);
    const request = ops.filter(op => op.turnId === end.turnId && op.sequence > (start?.sequence ?? -1) && op.sequence < end.sequence
      && ['question.requested', 'approval.requested'].includes(op.kind)
      && (!checkpointId || [op.nodeId, op.payload.questionId, op.payload.approvalId].includes(checkpointId))).at(-1);
    const barrier = request ? nodes.get(opNodes.get(request.id)!) : null;
    if (!barrier || !['waiting', 'completed', 'cancelled'].includes(barrier.status)) continue;
    const status = barrier.status;
    const reason = status === 'waiting' ? '等待用户确认，进度已保存；确认后继续执行。'
      : status === 'completed' ? '用户已确认，检查点已释放。' : '用户未确认继续，任务已取消。';
    const changed = new Set<string>();
    const update = (node: MutableNode | undefined) => {
      if (!node) return;
      node.status = status; node.reason = reason; node.diagnostic = null;
      node.barrierKind = barrier.barrierKind;
      node.summary = reason;
      node.completedAt = status === 'waiting' ? null : barrier.completedAt ?? end.timestamp;
      changed.add(node.id);
    };
    const result = nodes.get(graphId('result', end.id));
    update(result);
    if (result) result.title = status === 'waiting' ? '等待用户确认' : status === 'completed' ? '确认已完成' : '用户已取消';
    if (lifecycle.get(end.turnId) === end) update(nodes.get(graphId('turn', end.turnId)));
    for (const op of ops) {
      if (op.kind !== 'tool.completed' || op.turnId !== end.turnId || op.sequence <= (start?.sequence ?? -1) || op.sequence > end.sequence) continue;
      const tool = nodes.get(opNodes.get(op.id)!);
      if (tool?.status === 'cancelled' && tool.diagnostic === 'barrier.waiting-user') update(tool);
    }
    for (const batch of nodes.values()) {
      if (batch.kind !== 'tool-batch' || batch.turnId !== end.turnId || batch.status !== 'cancelled') continue;
      const children = [...edges.values()].filter(edge => edge.kind === 'contains' && edge.from === batch.id).map(edge => nodes.get(edge.to)!);
      if (children.some(child => changed.has(child.id)) && children.every(child => changed.has(child.id) || child.status === 'completed')) update(batch);
    }
    // Transcript summaries are product projections too; raw facts remain in the log.
    for (let i = 0; i < transcript.length; i++) {
      const item = transcript[i]!;
      if (!['turn.completed', 'tool.completed', 'tool-batch.completed'].includes(kinds.get(item.sourceOpIds[0]!) ?? '')) continue;
      const node = nodes.get(item.graphNodeIds[0]!);
      if (node && changed.has(node.id)) transcript[i] = freeze({ ...item, status, title: node.title, body: reason });
    }
  }
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
export function groupExecutionGraphsByTask(graphs: readonly ExecutionGraphReadModel[], tasks: readonly (Pick<ConversationTaskRunReadModel, 'taskId' | 'title' | 'status'> & Partial<Pick<ConversationTaskRunReadModel, 'sessionId' | 'turnId' | 'terminalDiagnostic' | 'timeline' | 'phase'>>)[] = []): readonly ExecutionGraphReadModel[] {
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
    let status = task ? productStatus(task.status) : latest.status;
    if (task?.status === 'blocked') {
      // Acceptance can be blocked while this task's provider turn is still
      // collecting evidence or repairing. Do not borrow activity from other tasks
      // or from an older, unreconciled session.
      const turns = parts.flatMap(part => part.graph.nodes.filter(node => part.nodeIds.includes(node.id) && node.kind === 'turn').map(node => ({ part, node })));
      const current = task.sessionId && task.turnId
        ? turns.find(({ part, node }) => part.graph.sessionId === task.sessionId && node.turnId === task.turnId)
        : turns.sort((a, b) => a.node.startedAt.localeCompare(b.node.startedAt) || a.node.id.localeCompare(b.node.id)).at(-1);
      if (current) {
        const waiting = current.part.graph.nodes.some(node => current.part.nodeIds.includes(node.id) && node.turnId === current.node.turnId && node.status === 'waiting' && ['approval', 'question', 'plan'].includes(node.kind));
        if (waiting) status = 'waiting';
        else if (current.node.status === 'running') status = 'running';
      }
    }
    const pendingAcceptance = task?.status === 'blocked' && task.terminalDiagnostic === 'task.acceptance-evidence-incomplete';
    if (pendingAcceptance && status === 'failed') status = 'outcome-unknown';
    const terminal = status === 'failed' || status === 'cancelled';
    const diagnostic = task?.terminalDiagnostic ?? (terminal ? sourceRoot.detail.diagnostic : null);
    const reason = terminal ? executionFailureReason(diagnostic, task?.timeline?.filter(item => item.status === 'error').at(-1)?.detail ?? sourceRoot.detail.reason ?? null) : status === 'outcome-unknown' && pendingAcceptance ? '当前回合已结束，验收证据尚未补齐，可从检查点继续验收。' : null;
    const title = task?.title ?? (parts[0]!.graph.taskScopes?.length === 1 ? parts[0]!.graph.title : 'Agent task');
    const scopedTurns = parts.flatMap(part => part.graph.nodes.filter(node => part.nodeIds.includes(node.id) && node.kind === 'turn'));
    const currentTurn = scopedTurns.at(-1);
    const nodes: ExecutionGraphNodeReadModel[] = [freeze({ ...sourceRoot, id: rootId, title, status, summary: `${parts.length} 个执行阶段${status === 'running' && (task?.status === 'blocked' || ['playing', 'evaluating', 'repairing'].includes(task?.phase ?? '')) ? ' · 验收处理中' : pendingAcceptance && status === 'outcome-unknown' ? ' · 待继续验收' : ''} · ${safeText(currentTurn?.summary, title, 1000)}`, detail: freeze({ ...sourceRoot.detail, reason, diagnostic, modelExplanation: null, actionSummary: currentTurn?.detail.actionSummary ?? null, resultSummary: currentTurn?.detail.resultSummary ?? null }), startedAt: firstTime(parts[0]!), completedAt: terminalStatuses.has(status) ? sourceRoot.completedAt : null, durationMs: null, sourceOpIds: freeze([]), artifactRefs: freeze([]) })];
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
      nodes: freeze(nodes.sort(compareNodes)), edges: freeze(edges.sort(compareEdges)), criticalPathNodeIds: freeze(critical), currentNodeIds: freeze(currentExecutionNodeIds(nodes, edges)),
      transcript: freeze(transcript.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))), context: latest.context, diagnostics: freeze(diagnostics), throughSequence: latest.throughSequence };
    result.push(deepFreeze({ ...semantic, digest: sha256Digest(canonicalStringify(semantic as unknown as JsonValue)) }));
  }
  return freeze(result.sort(compareExecutionGraphs));
}

/** Display explicit approved-plan progress; do not infer completion from tool counts or text. */
export function withExecutionPlan(graph: ExecutionGraphReadModel, records: readonly ConversationNodeReadModel[]): ExecutionGraphReadModel {
  const sessions = new Set(graph.sourceSessionIds ?? [graph.sessionId]);
  const turns = new Set(graph.nodes.map(node => node.turnId).filter(Boolean));
  const plan = records.filter(node => node.kind === 'plan' && Array.isArray(node.content.items)
    && (node.content.taskId ? node.content.taskId === graph.taskId || graph.taskScopes?.some(scope => scope.taskId === node.content.taskId)
      : sessions.has(node.provenance.sessionId) && turns.has(node.provenance.turnId)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
  const root = graph.nodes.find(node => node.kind === 'goal');
  if (!plan || !root) return graph;
  const items = (plan.content.items as readonly unknown[]).filter(record).filter(item => item.status !== 'rejected' && typeof item.id === 'string' && typeof item.label === 'string').slice(0, 50);
  if (!items.length) return graph;
  const live = graph.status === 'running' || graph.status === 'waiting';
  const approved = plan.content.decision === 'approved';
  const steps: ExecutionGraphNodeReadModel[] = items.map((item, index) => {
    const report = approved && typeof item.executionStatus === 'string' && ['pending', 'in_progress', 'completed', 'blocked'].includes(item.executionStatus) ? item.executionStatus : 'pending';
    const stale = item.executionNeedsSync === true && report === 'in_progress';
    const status: ExecutionGraphProductNodeStatus = stale ? 'pending' : report === 'completed' ? 'completed' : report === 'blocked' ? 'outcome-unknown'
      : report === 'in_progress' ? live ? graph.status === 'waiting' ? 'waiting' : 'running' : graph.status === 'cancelled' ? 'cancelled' : 'outcome-unknown' : 'pending';
    const summary = safeText(item.executionSummary, approved ? '等待 Agent 上报此步骤的执行进度。' : '方案待确认。', 512);
    return freeze({ ...root, id: `plan-step:${plan.id}:${item.id}`, kind: 'plan-step', status,
      title: `第 ${index + 1}/${items.length} 步：${safeText(item.label, '计划步骤', 240)}`,
      summary: stale ? `进度待同步。上次报告：${summary}` : !live && report === 'in_progress' ? `回合已结束，步骤结果待核实。${summary}` : summary,
      sourceNodeId: plan.id, sourceOpIds: freeze([]), artifactRefs: freeze([]), turnId: plan.provenance.turnId, batchId: null,
      startedAt: plan.createdAt, completedAt: null, durationMs: null, projectRevisionBefore: null, projectRevisionAfter: null,
      detail: freeze({ toolId: null, toolVersion: null, executionClass: null, barrierKind: null, transactionId: null, usageRecordIds: freeze([]), costRecordIds: freeze([]), diagnostic: null, validation: null,
        planStep: freeze({ index: index + 1, total: items.length, reportStatus: stale ? 'pending' : report }), actionSummary: safeText(item.details, String(item.label), 1024), resultSummary: typeof item.executionSummary === 'string' ? summary : null,
        reason: report === 'blocked' ? summary : null }),
    });
  });
  const activeSteps = steps.filter(step => step.detail.planStep?.reportStatus === 'in_progress');
  const context = activeSteps.map(step => step.title).join('；').slice(0, 800);
  const nodes = [...graph.nodes.map(node => node.kind === 'model' && node.status === 'running' && live && context
    ? freeze({ ...node, title: `${context} · 模型处理中`, summary: `${activeSteps.map(step => step.summary).join('；')}\n${node.summary}`.slice(0, 2048) }) : node), ...steps];
  const edges = [...graph.edges, ...steps.map(step => freeze({ id: `contains:${root.id}:${step.id}`, kind: 'contains' as const, from: root.id, to: step.id, sourceOpIds: freeze([]) }))];
  const currentNodeIds = [...graph.currentNodeIds, ...steps.filter(step => live && ['running', 'waiting'].includes(step.status)).map(step => step.id)];
  const { digest: _digest, ...original } = graph;
  const semantic = { ...original, nodes: freeze(nodes), edges: freeze(edges), currentNodeIds: freeze(currentNodeIds) };
  return freeze({ ...semantic, digest: sha256Digest(canonicalStringify(semantic as unknown as JsonValue)) });
}

export function executionProgressLabel(graph: ExecutionGraphReadModel): string {
  const steps = graph.nodes.filter(node => node.kind === 'plan-step');
  const completed = steps.filter(node => node.detail.planStep?.reportStatus === 'completed').length;
  if (graph.status === 'completed') return `任务已完成${steps.length ? ` · 已上报 ${completed}/${steps.length} 步完成` : ''}`;
  if (graph.status === 'failed' || graph.status === 'cancelled') return `${graph.status === 'failed' ? '任务执行失败' : '任务已停止'}${steps.length ? ` · 已完成 ${completed}/${steps.length} 步` : ''}`;
  const active = steps.filter(node => node.detail.planStep?.reportStatus === 'in_progress');
  if (active.length) return `${active.map(node => node.title).join('；')}${graph.status === 'waiting' ? ' · 等待确认' : ''} · 已完成 ${completed}/${steps.length}`;
  const blocked = steps.filter(node => node.detail.planStep?.reportStatus === 'blocked');
  if (blocked.length) return `${blocked.map(node => node.title).join('；')} · 等待解决阻塞`;
  if (steps.length) return completed === steps.length ? `已完成 ${completed}/${steps.length} 步 · 等待最终验收结果`
    : `${graph.status === 'waiting' ? '等待确认方案或授权' : '等待 Agent 更新执行步骤'} · 已完成 ${completed}/${steps.length} 步`;
  const current = graph.nodes.filter(node => graph.currentNodeIds.includes(node.id) && !['goal', 'turn', 'model'].includes(node.kind));
  return current.length ? current.map(node => node.title).join('；') : graph.status === 'waiting' ? '等待用户确认' : '正在规划实施步骤';
}

/** Present the actionable cause without relabeling an execution error as missing acceptance. */
export function executionFailureReason(diagnostic: string | null, detail: string | null): string | null {
  if (diagnostic === 'texture.project-unsaved') return '当前项目尚未保存到项目目录，无法保存生成的 PNG 贴图。';
  return detail?.replace(/\s*验收尚未完成。$/u, '') || diagnostic;
}

export function normalizeExecutionGraph(value: unknown): ExecutionGraphReadModel {
  if (!record(value) || value.schemaVersion !== 1 || !stringValue(value.sessionId) || !stringValue(value.digest)) throw new TypeError('Execution Graph envelope is invalid.');
  const serialized = JSON.stringify(value);
  if (serialized.length > 8 * 1024 * 1024) throw new TypeError('Execution Graph exceeds the renderer budget.');
  if (!Array.isArray(value.nodes) || value.nodes.length > 5_000 || !Array.isArray(value.edges) || value.edges.length > 20_000 || !Array.isArray(value.transcript) || value.transcript.length > 10_000 || !Array.isArray(value.diagnostics) || value.diagnostics.length > 1_000) throw new TypeError('Execution Graph collections are invalid.');
  const nodeIds = new Set<M13StableId>();
  for (const node of value.nodes) {
    if (!record(node) || !stringValue(node.id) || nodeIds.has(node.id as string) || !stringValue(node.kind) || !stringValue(node.status) || !stringValue(node.title) || !Array.isArray(node.sourceOpIds) || !Array.isArray(node.artifactRefs) || !record(node.detail)) throw new TypeError('Execution Graph node is invalid.');
    const step = node.detail.planStep;
    if (step !== undefined && (!record(step) || !Number.isSafeInteger(step.index) || !Number.isSafeInteger(step.total) || Number(step.index) < 1 || Number(step.total) > 50 || Number(step.index) > Number(step.total) || !['pending', 'in_progress', 'completed', 'blocked'].includes(String(step.reportStatus)))) throw new TypeError('Execution Graph plan step is invalid.');
    for (const field of ['modelExplanation', 'actionSummary', 'resultSummary']) {
      const content = node.detail[field];
      if (content !== undefined && content !== null && (typeof content !== 'string' || content.length > 2048)) throw new TypeError('Execution Graph node content is invalid.');
    }
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
    case 'user.message': return freeze({ kind: 'turn', status: 'running', title: '模型处理请求', summary: '模型正在生成方案或下一步工具调用。' });
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
  if (op.kind !== 'question.resolved' || node.kind !== 'plan') {
    node.title = descriptor.title;
    node.summary = descriptor.summary;
  }
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
  if (descriptor.status === 'failed' || descriptor.status === 'cancelled' || descriptor.status === 'outcome-unknown') {
    const diagnostic = record(op.payload.diagnostic) ? op.payload.diagnostic : record(op.payload.error) ? op.payload.error : null;
    const compaction = record(op.payload.compaction) ? op.payload.compaction : null;
    node.diagnostic = stringValue(diagnostic?.code) ?? stringValue(compaction?.diagnostic) ?? node.diagnostic;
    node.reason = safeText(op.payload.reason, '') || safeText(diagnostic?.message, '') || safeText(op.payload.message, '') || null;
    // Completion summaries contain the original tool error in older journals.
    if (!node.reason && op.kind === 'tool.completed') node.reason = safeText(op.payload.summary, '') || null;
    if (!node.reason && op.kind === 'approval.resolved') node.reason = `审批未通过（${safeText(op.payload.resolution, 'denied')}），操作未继续。`;
    if (!node.reason && op.kind === 'question.resolved') node.reason = '用户输入流程已取消，操作未继续。';
  } else {
    node.reason = null;
    node.diagnostic = stringValue(op.payload.diagnostic) ?? stringValue(op.payload.code);
  }
  node.validation = stringValue(op.payload.validation) ?? node.validation;
}

/** Aggregate only structural descendants, never unrelated earlier failures in a session. */
function summarizeTerminalReasons(nodes: Map<M13StableId, MutableNode>, edges: Map<M13StableId, MutableEdge>): void {
  const children = new Map<M13StableId, M13StableId[]>();
  for (const edge of edges.values()) if (edge.kind === 'contains') {
    const ids = children.get(edge.from) ?? []; ids.push(edge.to); children.set(edge.from, ids);
  }
  const visited = new Set<M13StableId>();
  const visit = (node: MutableNode): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const descendants = (children.get(node.id) ?? []).map(id => nodes.get(id)!).filter(Boolean);
    for (const child of descendants) visit(child);
    if (!['failed', 'cancelled', 'outcome-unknown'].includes(node.status) || node.reason) return;
    const causes = descendants.filter(child => child.status === node.status && (child.reason || child.diagnostic));
    if (causes.length) node.reason = safeText(causes.slice(0, 3).map(child => `${child.title}：${child.reason ?? child.diagnostic}`).join('；') + (causes.length > 3 ? `；另有 ${causes.length - 3} 项，请查看子节点。` : ''), '');
  };
  for (const node of nodes.values()) visit(node);
  for (const node of nodes.values()) if (node.kind === 'result' && node.turnId && !node.reason) {
    const turn = nodes.get(graphId('turn', node.turnId));
    if (turn?.status === node.status) node.reason = turn.reason;
  }
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
  return { turnId: null, batchId: null, sourceNodeId: null, sourceOpIds: [], artifactRefs: [], projectRevisionBefore: null, projectRevisionAfter: null, completedAt: null, toolId: null, toolVersion: null, executionClass: null, barrierKind: null, transactionId: null, usageRecordIds: [], costRecordIds: [], reason: null, diagnostic: null, validation: null, ...input };
}

function freezeNode(node: MutableNode): ExecutionGraphNodeReadModel {
  const started = Date.parse(node.startedAt); const completed = node.completedAt ? Date.parse(node.completedAt) : Number.NaN;
  return freeze({
    id: node.id, kind: node.kind, status: node.status, title: safeText(node.title, 'Untitled step'), summary: safeText(node.summary, ''), turnId: node.turnId, batchId: node.batchId, sourceNodeId: node.sourceNodeId,
    sourceOpIds: freeze(unique(node.sourceOpIds).sort()), artifactRefs: freeze(unique(node.artifactRefs).sort()), projectRevisionBefore: node.projectRevisionBefore, projectRevisionAfter: node.projectRevisionAfter,
    startedAt: node.startedAt, completedAt: node.completedAt, durationMs: Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : null,
    detail: freeze({ toolId: node.toolId, toolVersion: node.toolVersion, executionClass: node.executionClass, barrierKind: node.barrierKind, transactionId: node.transactionId, usageRecordIds: freeze(unique(node.usageRecordIds).sort()), costRecordIds: freeze(unique(node.costRecordIds).sort()), reason: node.reason, diagnostic: node.diagnostic, validation: node.validation, modelExplanation: node.modelExplanation ?? null, actionSummary: node.actionSummary ?? null, resultSummary: node.resultSummary ?? null }),
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
