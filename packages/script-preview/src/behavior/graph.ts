import type { BehaviorAnalysisConfigV1, BehaviorEdgeV1, BehaviorNodeKindV1, BehaviorNodeV1, BehaviorSourceV1, BehaviorTruncationV1, BehaviorUnknownReasonV1 } from '@haiyue/ai-studio-contracts';
import { behaviorDigest, canonicalJson } from './canonical.js';

export class BehaviorGraphBuilder {
  readonly nodes: BehaviorNodeV1[] = [];
  readonly edges: BehaviorEdgeV1[] = [];
  readonly triggers: string[] = [];
  private readonly reasons = new Set<BehaviorTruncationV1['reasons'][number]>();
  private omitted = 0;
  private bytes = 0;
  private readonly identities = new Set<string>();
  private context = '';
  constructor(readonly config: BehaviorAnalysisConfigV1) {}
  truncate(reason: BehaviorTruncationV1['reasons'][number]): void { this.reasons.add(reason); this.omitted++; }
  node(kind: BehaviorNodeKindV1, source: BehaviorSourceV1, label = kind as string, unknown: BehaviorUnknownReasonV1 | null = null): string | null {
    const id = `node:${behaviorDigest({ kind, source, label, context: this.context }).slice(7, 39)}`;
    if (this.identities.has(id)) return id;
    if (this.nodes.length >= this.config.maxNodes) { this.truncate('nodes'); return null; }
    const node: BehaviorNodeV1 = { id, kind, label, source, unknown };
    if (!this.takeBytes(node)) return null;
    this.nodes.push(node); this.identities.add(id);
    if (kind === 'entry' || kind === 'trigger') this.triggers.push(id);
    return id;
  }
  edge(from: string | null, to: string | null, kind: BehaviorEdgeV1['kind'], evidence: BehaviorSourceV1): void {
    if (!from || !to) return;
    const id = `edge:${behaviorDigest({ from, to, kind, evidence }).slice(7, 39)}`;
    if (this.identities.has(id)) return;
    if (this.edges.length >= this.config.maxEdges) { this.truncate('edges'); return; }
    const edge = { id, from, to, kind, evidence };
    if (!this.takeBytes(edge)) return;
    this.edges.push(edge); this.identities.add(id);
  }
  truncation(): BehaviorTruncationV1 { return { truncated: this.reasons.size > 0, reasons: [...this.reasons].sort(), omittedAtLeast: this.omitted }; }
  withContext<T>(key: string, run: () => T): T {
    const previous = this.context; this.context = `${previous}/${key}`;
    try { return run(); } finally { this.context = previous; }
  }
  private takeBytes(value: unknown): boolean {
    const size = Buffer.byteLength(canonicalJson(value));
    // Leave 512 KiB for binding/envelope and JSON separators.
    if (this.bytes + size > 1536 * 1024) { this.truncate('bytes'); return false; }
    this.bytes += size; return true;
  }
}
