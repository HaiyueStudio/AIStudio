import type { M13StableId } from '@haiyue/ai-studio-contracts';
import type {
  ExecutionGraphLayoutNodeReadModel,
  ExecutionGraphLayoutReadModel,
  ExecutionGraphProductNodeKind,
  ExecutionGraphProductNodeStatus,
  ExecutionGraphReadModel,
} from './execution-graph-types.js';

export interface ExecutionGraphLayoutOptions {
  readonly mode?: 'overview' | 'expanded';
  readonly query?: string;
  readonly statuses?: readonly ExecutionGraphProductNodeStatus[];
  readonly kinds?: readonly ExecutionGraphProductNodeKind[];
  readonly costUnknown?: boolean;
  readonly expandedBatchIds?: readonly M13StableId[];
  readonly maxCompletedToolsPerBatch?: number;
}

const importantStatuses = new Set<ExecutionGraphProductNodeStatus>(['running', 'waiting', 'failed', 'outcome-unknown']);

/**
 * Deterministic, renderer-safe layered layout. It never mutates graph truth and
 * only reduces completed low-information tool detail in overview mode.
 */
export function layoutExecutionGraph(graph: ExecutionGraphReadModel, options: ExecutionGraphLayoutOptions = {}): ExecutionGraphLayoutReadModel {
  const mode = options.mode ?? 'overview';
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  const statuses = options.statuses ? new Set(options.statuses) : null;
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const expanded = new Set(options.expandedBatchIds ?? []);
  const maxCompleted = Math.max(0, Math.min(500, options.maxCompletedToolsPerBatch ?? 24));
  const critical = new Set(graph.criticalPathNodeIds);
  const transcriptLinked = new Set(graph.transcript.flatMap((item) => item.graphNodeIds));
  const keep = new Set<M13StableId>();
  const completedByBatch = new Map<M13StableId, M13StableId[]>();

  for (const node of graph.nodes) {
    const matchesQuery = !query || `${node.title}\n${node.summary}\n${node.detail.toolId ?? ''}\n${node.detail.diagnostic ?? ''}`.toLocaleLowerCase().includes(query);
    const matchesStatus = !statuses || statuses.has(node.status);
    const matchesKind = !kinds || kinds.has(node.kind);
    const matchesCost = options.costUnknown !== true || node.detail.costRecordIds.length === 0;
    if (!matchesQuery || !matchesStatus || !matchesKind || !matchesCost) continue;
    const always = importantStatuses.has(node.status) || node.kind !== 'tool' || critical.has(node.id) || transcriptLinked.has(node.id);
    if (mode === 'expanded' || always || (node.batchId && expanded.has(`batch:${node.batchId}`))) { keep.add(node.id); continue; }
    if (node.batchId) {
      const list = completedByBatch.get(node.batchId) ?? [];
      list.push(node.id); completedByBatch.set(node.batchId, list);
    } else keep.add(node.id);
  }
  for (const ids of completedByBatch.values()) for (const id of ids.slice(-maxCompleted)) keep.add(id);
  preserveConnectingNodes(graph, keep);

  const visibleNodes = graph.nodes.filter((node) => keep.has(node.id));
  const layerById = calculateLayers(graph, keep);
  const byLayer = new Map<number, typeof visibleNodes>();
  for (const node of visibleNodes) {
    const layer = layerById.get(node.id) ?? 0;
    const values = byLayer.get(layer) ?? [];
    values.push(node); byLayer.set(layer, values);
  }
  const horizontalGap = 88; const verticalGap = 28; const nodeWidth = 224; const nodeHeight = 88; const margin = 32;
  const layoutNodes: ExecutionGraphLayoutNodeReadModel[] = [];
  let maximumRows = 0;
  for (const [layer, values] of [...byLayer.entries()].sort((left, right) => left[0] - right[0])) {
    values.sort((left, right) => statusPriority(left.status) - statusPriority(right.status) || left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
    maximumRows = Math.max(maximumRows, values.length);
    for (const [order, node] of values.entries()) layoutNodes.push(Object.freeze({ id: node.id, x: margin + layer * (nodeWidth + horizontalGap), y: margin + order * (nodeHeight + verticalGap), width: nodeWidth, height: nodeHeight, layer, order, hidden: false }));
  }
  const maximumLayer = Math.max(0, ...layoutNodes.map((node) => node.layer));
  return Object.freeze({
    nodes: Object.freeze(layoutNodes),
    width: margin * 2 + (maximumLayer + 1) * nodeWidth + maximumLayer * horizontalGap,
    height: margin * 2 + maximumRows * nodeHeight + Math.max(0, maximumRows - 1) * verticalGap,
    visibleNodeIds: Object.freeze(layoutNodes.map((node) => node.id)),
  });
}

function preserveConnectingNodes(graph: ExecutionGraphReadModel, keep: Set<M13StableId>): void {
  if (keep.size === 0) return;
  const parentByChild = new Map<M13StableId, M13StableId[]>();
  for (const edge of graph.edges) if (edge.kind === 'contains' || edge.kind === 'depends-on') {
    const list = parentByChild.get(edge.to) ?? [];
    list.push(edge.from); parentByChild.set(edge.to, list);
  }
  const pending = [...keep];
  while (pending.length) {
    const id = pending.pop()!;
    for (const parent of parentByChild.get(id) ?? []) if (!keep.has(parent)) { keep.add(parent); pending.push(parent); }
  }
}

function calculateLayers(graph: ExecutionGraphReadModel, keep: ReadonlySet<M13StableId>): Map<M13StableId, number> {
  const predecessors = new Map<M13StableId, M13StableId[]>();
  for (const edge of graph.edges) {
    if (!keep.has(edge.from) || !keep.has(edge.to) || edge.kind === 'parallel-with' || edge.kind === 'retried-from' || edge.kind === 'supersedes') continue;
    const values = predecessors.get(edge.to) ?? [];
    values.push(edge.from); predecessors.set(edge.to, values);
  }
  const layers = new Map<M13StableId, number>();
  const visiting = new Set<M13StableId>();
  const visit = (id: M13StableId): number => {
    const cached = layers.get(id); if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let layer = 0;
    for (const predecessor of predecessors.get(id) ?? []) layer = Math.max(layer, visit(predecessor) + 1);
    visiting.delete(id); layers.set(id, layer); return layer;
  };
  for (const id of keep) visit(id);
  return layers;
}

function statusPriority(status: ExecutionGraphProductNodeStatus): number {
  return ({ waiting: 0, 'outcome-unknown': 1, failed: 2, running: 3, pending: 4, cancelled: 5, completed: 6 } as const)[status];
}
