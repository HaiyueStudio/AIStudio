import type { BehaviorExplanationV1, BehaviorManifestV1, BehaviorNodeV1, BehaviorTraceArtifactV1 } from '@haiyue/ai-studio-contracts';

export interface LogicArtifactReference { readonly kind: 'manifest' | 'explanation' | 'trace'; readonly artifactId: string; readonly digest: string; readonly createdAt: string; readonly documentRevision: number; readonly manifestDigest: string; }
export interface LogicPanelData {
  readonly documentId: string | null; readonly documentRevision: number; readonly entityId: string | null;
  readonly state: 'empty' | 'pending' | 'analyzing' | 'ready' | 'failed'; readonly diagnostic: string | null;
  readonly manifest: BehaviorManifestV1 | null; readonly explanation: BehaviorExplanationV1 | null;
  readonly trace: BehaviorTraceArtifactV1 | null; readonly traceStatus: 'current' | 'historical' | null;
  readonly historicalStructure?: boolean; readonly artifacts: readonly LogicArtifactReference[]; readonly playing: boolean;
}
export type LogicPanelIntent =
  | Readonly<{ type: 'refresh' | 'capture' | 'cancel' }>
  | Readonly<{ type: 'history'; cursor?: string }>
  | Readonly<{ type: 'explain'; manifestDigest: string; nodeIds: readonly string[]; language: 'en' | 'zh-CN' }>
  | Readonly<{ type: 'locate'; manifestDigest: string; nodeId: string }>
  | Readonly<{ type: 'related'; manifestDigest: string; nodeId: string; cursor?: string }>
  | Readonly<{ type: 'read'; kind: LogicArtifactReference['kind']; artifactId: string }>;

/** Presentation projection only. No graph edge or runtime fact is invented by layout. */
export function projectLogicGraph(data: LogicPanelData, options: Readonly<{ group?: string; search?: string; offset?: number; limit?: number }> = {}) {
  const manifest = data.manifest;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.nodes.length > 2000 || manifest.edges.length > 4000) return { nodes: [], edges: [], groups: [], total: 0, overlay: false, current: false };
  const current = !data.historicalStructure && manifest.binding.documentId === data.documentId && manifest.binding.documentRevision === data.documentRevision;
  const owned = manifest.nodes.filter(node => node.source.entityId === data.entityId);
  // Include actual outgoing relationships to other entities (e.g. a rule's
  // target state). Do not infer dependency from entity order or names.
  const ownedIds = new Set(owned.map(node => node.id));
  const targets = new Set(manifest.edges.filter(edge => ownedIds.has(edge.from)).map(edge => edge.to));
  const connected = manifest.nodes.filter(node => ownedIds.has(node.id) || targets.has(node.id));
  const groups = owned.filter(node => manifest.triggers.includes(node.id));
  let reachable: Set<string> | null = null;
  if (options.group) {
    reachable = new Set([options.group]);
    const adjacency = new Map<string, string[]>();
    for (const edge of manifest.edges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    const pending = [options.group];
    while (pending.length) for (const to of adjacency.get(pending.pop()!) ?? []) if (!reachable.has(to)) { reachable.add(to); pending.push(to); }
  }
  const query = (options.search ?? '').slice(0, 128).toLocaleLowerCase();
  const matching = connected.filter(node => (!reachable || reachable.has(node.id)) && (!query || `${node.label} ${node.kind} ${sourceLabel(node)} ${node.id}`.toLocaleLowerCase().includes(query)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0)), limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100)));
  const nodes = matching.slice(offset, offset + limit), ids = new Set(nodes.map(n => n.id));
  const edges = manifest.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  const trace = data.trace?.trace;
  const overlay = !!trace && trace.manifestDigest === manifest.digest && trace.sourceBindingDigest === manifest.binding.digest;
  return { nodes, edges, groups, total: matching.length, overlay, current };
}
export function sourceLabel(node: BehaviorNodeV1): string {
  const source = node.source;
  return source.kind === 'script' ? `${source.path}:${source.range.startLine}:${source.range.startColumn}`
    : source.kind === 'declarative-component' ? `${source.componentType} ${source.field || '/'}` : `${source.adapter.id}@${source.adapter.version}`;
}

/** A bounded visual arrangement. Positions are not evidence of concurrency;
 * only explicit edge kinds carry that meaning. */
export function layoutLogicGraph(nodes: readonly BehaviorNodeV1[], edges: NonNullable<LogicPanelData['manifest']>['edges']) {
  const incoming = new Set(edges.filter(edge => !['loop-back','exception','finally'].includes(edge.kind)).map(edge => edge.to));
  const depth = new Map<string, number>(), queue = nodes.filter(node => !incoming.has(node.id)).map(node => node.id);
  queue.forEach(id => depth.set(id, 0));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) if (edge.kind !== 'loop-back') adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  for (let index = 0; index < queue.length; index++) for (const id of adjacency.get(queue[index]) ?? []) if (!depth.has(id)) { depth.set(id, Math.min(7, depth.get(queue[index])! + 1)); queue.push(id); }
  const rows = new Map<number, number>();
  return nodes.map(node => { const column = depth.get(node.id) ?? 0, row = rows.get(column) ?? 0; rows.set(column, row + 1); return { node, x: 20 + column * 222, y: 28 + row * 92 }; });
}
