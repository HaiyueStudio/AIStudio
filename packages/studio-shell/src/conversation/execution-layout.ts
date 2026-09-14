import type { M13StableId } from '@haiyue/ai-studio-contracts';
import type {
  ExecutionGraphLayoutNodeReadModel,
  ExecutionGraphLayoutReadModel,
  ExecutionGraphNodeReadModel,
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
  const rowById = calculateBranchRows(graph, visibleNodes, layerById);
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
    values.sort((left, right) => rowById.get(left.id)! - rowById.get(right.id)!);
    for (const [order, node] of values.entries()) {
      const row = rowById.get(node.id)!;
      maximumRows = Math.max(maximumRows, row + 1);
      layoutNodes.push(Object.freeze({ id: node.id, x: margin + layer * (nodeWidth + horizontalGap), y: margin + row * (nodeHeight + verticalGap), width: nodeWidth, height: nodeHeight, layer, order, hidden: false }));
    }
  }
  const maximumLayer = Math.max(0, ...layoutNodes.map((node) => node.layer));
  return Object.freeze({
    nodes: Object.freeze(layoutNodes),
    width: margin * 2 + (maximumLayer + 1) * nodeWidth + maximumLayer * horizontalGap,
    height: margin * 2 + maximumRows * nodeHeight + Math.max(0, maximumRows - 1) * verticalGap,
    visibleNodeIds: Object.freeze(layoutNodes.map((node) => node.id)),
  });
}

/** Reserve rows for whole branches, aligning each parent with its first child. */
function calculateBranchRows(graph: ExecutionGraphReadModel, nodes: readonly ExecutionGraphNodeReadModel[], layers: ReadonlyMap<M13StableId, number>): Map<M13StableId, number> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const compare = (left: ExecutionGraphNodeReadModel, right: ExecutionGraphNodeReadModel) => statusPriority(left.status) - statusPriority(right.status) || left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id);
  const parents = new Map<M13StableId, { id: M13StableId; contains: boolean }>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to) || !isLayerEdge(edge.kind) || layers.get(edge.from)! >= layers.get(edge.to)!) continue;
    const candidate = { id: edge.from, contains: edge.kind === 'contains' };
    const previous = parents.get(edge.to);
    // Containment owns the visual branch; additional dependencies remain edges,
    // rather than duplicating shared nodes or moving tools out of their batch.
    if (!previous || Number(candidate.contains) > Number(previous.contains)
      || candidate.contains === previous.contains && (layers.get(candidate.id)! > layers.get(previous.id)!
        || layers.get(candidate.id) === layers.get(previous.id) && compare(byId.get(candidate.id)!, byId.get(previous.id)!) < 0)) parents.set(edge.to, candidate);
  }
  const children = new Map<M13StableId, ExecutionGraphNodeReadModel[]>();
  const roots: ExecutionGraphNodeReadModel[] = [];
  for (const node of nodes) {
    const parent = parents.get(node.id);
    if (!parent) roots.push(node);
    else { const siblings = children.get(parent.id) ?? []; siblings.push(node); children.set(parent.id, siblings); }
  }
  for (const siblings of children.values()) siblings.sort(compare);
  const pending = roots.sort(compare).reverse();
  const rows = new Map<M13StableId, number>();
  let row = 0;
  // Strictly increasing layers form a forest even when diagnostic input has a cycle.
  while (pending.length) {
    const node = pending.pop()!;
    rows.set(node.id, row);
    const descendants = children.get(node.id);
    if (descendants?.length) for (let index = descendants.length - 1; index >= 0; index--) pending.push(descendants[index]!);
    else row++;
  }
  return rows;
}

function isLayerEdge(kind: ExecutionGraphReadModel['edges'][number]['kind']): boolean {
  return kind !== 'parallel-with' && kind !== 'retried-from' && kind !== 'supersedes';
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
    if (!keep.has(edge.from) || !keep.has(edge.to) || !isLayerEdge(edge.kind)) continue;
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
