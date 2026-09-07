import { Worker } from 'node:worker_threads';
import type { BehaviorAnalysisInputV1, BehaviorExplanationV1, BehaviorManifestV1, BehaviorQueryResultV1, EditorLocationV1 } from '@haiyue/ai-studio-contracts';
import { bindPreparedInput, prepareBehaviorInput } from './binding.js';
import { BehaviorContractError, canonicalJson, checkedJson, freezeProjection, withDigest } from './canonical.js';
import { parseBehaviorContract } from './validation.js';

const abortError = () => new BehaviorContractError('behavior.cancelled');
function request(input: unknown, keys: readonly string[], maxBytes = 16384): Record<string, unknown> {
  const value = checkedJson(input, maxBytes);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new BehaviorContractError('behavior.invalid-request');
  return value as Record<string, unknown>;
}
/** One project projection and one worker at a time. The existing root scope owns dispose(). */
export class BehaviorReadService {
  private current: { input: BehaviorAnalysisInputV1; manifest: BehaviorManifestV1 } | null = null;
  private generation = 0;
  private closed = false;
  private pending: { abort: () => void; done: Promise<void> } | null = null;

  async analyze(input: unknown, signal?: AbortSignal): Promise<BehaviorManifestV1> {
    if (this.closed) throw new BehaviorContractError('behavior.disposed');
    if (signal?.aborted) throw abortError();
    this.current = null;
    const generation = ++this.generation;
    const previous = this.pending;
    previous?.abort();
    if (previous) await previous.done;
    if (this.closed || generation !== this.generation || signal?.aborted) throw abortError();
    const prepared = prepareBehaviorInput(input);
    const expectedBinding = bindPreparedInput(prepared);
    const worker = new Worker(new URL('./worker.js', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 } });
    let finishDone!: () => void;
    const done = new Promise<void>(resolve => { finishDone = resolve; });
    return new Promise<BehaviorManifestV1>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
      const finish = (error?: Error, manifest?: BehaviorManifestV1) => {
        if (settled) return;
        settled = true; cleanup();
        void worker.terminate().then(() => {
          worker.removeAllListeners();
          if (this.pending?.done === done) this.pending = null;
          finishDone();
          if (error) reject(error);
          else if (this.closed || generation !== this.generation || signal?.aborted) reject(abortError());
          else { this.current = { input: prepared, manifest: manifest! }; resolve(manifest!); }
        }, () => { finishDone(); reject(new BehaviorContractError('behavior.worker-teardown')); });
      };
      const abort = () => finish(abortError());
      const timeout = setTimeout(() => finish(new BehaviorContractError('behavior.analysis-timeout')), 15000);
      this.pending = { abort, done };
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', (value: unknown) => {
        try {
          const reply = request(value, ['ok', 'manifest', 'code'], 2 * 1024 * 1024 + 4096);
          if (reply.ok !== true) throw new BehaviorContractError(typeof reply.code === 'string' && /^behavior\.[a-z-]+$/u.test(reply.code) ? reply.code : 'behavior.worker-result');
          const manifest = parseBehaviorContract('behavior-manifest', reply.manifest);
          if (manifest.binding.digest !== expectedBinding.digest) throw new BehaviorContractError('behavior.worker-binding');
          finish(undefined, manifest);
        } catch (error) { finish(error instanceof BehaviorContractError ? error : new BehaviorContractError('behavior.worker-result')); }
      });
      worker.once('error', () => finish(new BehaviorContractError('behavior.worker-failed')));
      worker.once('exit', code => { if (!settled) finish(new BehaviorContractError(code ? 'behavior.worker-failed' : 'behavior.worker-empty')); });
      if (signal?.aborted) abort(); else worker.postMessage(prepared);
    });
  }
  query(input: unknown): BehaviorQueryResultV1 {
    const query = request(input, ['schemaVersion', 'manifestDigest', 'sourceBindingDigest', 'entityId', 'kind', 'offset', 'limit']);
    const { manifest } = this.bound(query);
    if (!Number.isSafeInteger(query.offset) || (query.offset as number) < 0 || !Number.isSafeInteger(query.limit) || (query.limit as number) < 1 || (query.limit as number) > 100 || (query.entityId !== undefined && typeof query.entityId !== 'string') || (query.kind !== undefined && !['entry','statement','condition','loop','call','await','fork','join','return','throw','try','catch','finally','trigger','action','driver','unknown'].includes(query.kind as string))) throw new BehaviorContractError('behavior.query-budget');
    const matching = manifest.nodes.filter(node => (query.entityId === undefined || node.source.entityId === query.entityId) && (query.kind === undefined || node.kind === query.kind));
    const offset = query.offset as number, limit = query.limit as number;
    const nodes = matching.slice(offset, offset + limit), ids = new Set(nodes.map(node => node.id));
    // Page-local edges never point at an absent node. Full graph remains available from analyze().
    return freezeProjection({ manifestDigest: manifest.digest, nodes, edges: manifest.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), nextOffset: offset + limit < matching.length ? offset + limit : null });
  }
  locate(input: unknown): EditorLocationV1 {
    const query = request(input, ['schemaVersion', 'manifestDigest', 'sourceBindingDigest', 'nodeId']);
    const { manifest } = this.bound(query);
    const node = manifest.nodes.find(node => node.id === query.nodeId);
    if (!node) throw new BehaviorContractError('behavior.node-missing');
    const binding = manifest.binding;
    return parseBehaviorContract('editor-location', { schemaVersion: 1, projectId: binding.projectId, documentId: binding.documentId, documentRevision: binding.documentRevision, sourceBindingDigest: binding.digest,
      target: { kind: 'behavior-node', manifestDigest: manifest.digest, nodeId: node.id, source: node.source } });
  }
  resolveLocation(input: unknown): Readonly<{ status: 'current' | 'historical'; location: EditorLocationV1 }> {
    const location = parseBehaviorContract('editor-location', input), current = this.current;
    if (!current || location.projectId !== current.manifest.binding.projectId || location.documentId !== current.manifest.binding.documentId || location.documentRevision !== current.manifest.binding.documentRevision || location.sourceBindingDigest !== current.manifest.binding.digest) return freezeProjection({ status: 'historical', location });
    const target = location.target, document = current.input.document;
    let found = false;
    if (target.kind === 'behavior-node') found = target.manifestDigest === current.manifest.digest && current.manifest.nodes.some(node => node.id === target.nodeId && canonicalJson(node.source) === canonicalJson(target.source));
    if (target.kind === 'entity') found = document.entities.some(entity => entity.id === target.entityId);
    if (target.kind === 'component') {
      const component = document.components.find(component => component.id === target.componentId && component.version === target.componentVersion);
      found = !!component && document.entities.some(entity => entity.id === target.entityId && entity.componentIds.includes(target.componentId)) && hasPointer(component.value, target.field);
    }
    if (target.kind === 'script') {
      const script = document.scripts.find(script => script.id === target.source.scriptId && script.entityId === target.source.entityId && script.digest === target.source.digest && script.sourcePath === target.source.path);
      if (script) {
        const range = target.source.range;
        const coordinate = (offset: number) => { const prefix = script.source.slice(0, offset); const lines = prefix.split(/\r\n|\n|\r/u); return [lines.length, lines.at(-1)!.length + 1]; };
        found = range.end >= range.start && range.end <= script.source.length && canonicalJson(coordinate(range.start)) === canonicalJson([range.startLine, range.startColumn]) && canonicalJson(coordinate(range.end)) === canonicalJson([range.endLine, range.endColumn]);
      }
    }
    if (target.kind === 'resource') {
      const ref = target.ref;
      if (ref.kind === 'asset') found = document.assets.some(asset => asset.id === ref.assetId && asset.digest === ref.digest && asset.source === ref.source);
      if (ref.kind === 'instance') found = ref.projectId === current.input.projectId && ref.documentRevision === document.revision && document.entities.some(entity => entity.id === ref.entityId && (!ref.componentId || entity.componentIds.includes(ref.componentId)));
      // Template/preset persistence and artifact authority are injected by G05/G06, never guessed here.
    }
    return freezeProjection({ status: found ? 'current' : 'historical', location });
  }
  explain(input: unknown): BehaviorExplanationV1 {
    const query = request(input, ['schemaVersion', 'manifestDigest', 'sourceBindingDigest', 'nodeIds', 'language']);
    const { manifest } = this.bound(query);
    if (!['en', 'zh-CN'].includes(query.language as string) || !Array.isArray(query.nodeIds) || query.nodeIds.length > 100 || new Set(query.nodeIds).size !== query.nodeIds.length) throw new BehaviorContractError('behavior.explanation-request');
    const entries = query.nodeIds.map(id => {
      const node = manifest.nodes.find(node => node.id === id); if (!node) throw new BehaviorContractError('behavior.node-missing');
      const text = query.language === 'zh-CN'
        ? `来源类型：${node.source.kind}；结构：${node.label}。${node.unknown ? `尚不能确认：${node.unknown}。` : '此项仅描述静态结构。'}是否执行需核对运行观测。`
        : `Source: ${node.source.kind}; structure: ${node.label}. ${node.unknown ? `Unresolved: ${node.unknown}.` : 'This describes static structure only.'} Execution requires runtime evidence.`;
      return { nodeId: node.id, text, evidence: [node.source] };
    });
    return parseBehaviorContract('behavior-explanation', withDigest({ schemaVersion: 1, manifestDigest: manifest.digest, language: query.language, producerVersion: '1.0.0', producer: { kind: 'verified-structure', templateVersion: '1.0.0' }, entries }));
  }
  invalidate(): void { ++this.generation; this.current = null; this.pending?.abort(); }
  async dispose(): Promise<void> { this.closed = true; const pending = this.pending; this.invalidate(); if (pending) await pending.done; }
  private bound(query: Record<string, unknown>): NonNullable<BehaviorReadService['current']> {
    if (this.closed) throw new BehaviorContractError('behavior.disposed');
    if (query.schemaVersion !== 1) throw new BehaviorContractError('behavior.request-version');
    if (!this.current || query.manifestDigest !== this.current.manifest.digest || query.sourceBindingDigest !== this.current.manifest.binding.digest) throw new BehaviorContractError('behavior.stale');
    return this.current;
  }
}
function hasPointer(value: unknown, pointer: string): boolean {
  if (!pointer) return true;
  let current = value;
  for (const key of pointer.slice(1).split('/').map(key => key.replace(/~1/gu, '/').replace(/~0/gu, '~'))) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}
