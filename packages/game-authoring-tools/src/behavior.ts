import type { BehaviorAnalysisInputV1, BehaviorManifestV1, JsonObject, StableId } from '@haiyue/ai-studio-contracts';
import { BehaviorContractError, BehaviorReadService, createBehaviorSourceBinding, parseBehaviorContract } from '@haiyue/ai-studio-script-preview';
import { canonicalStringify } from '@haiyue/ai-studio-operation-log';
import { GameToolProtocolError } from './types.js';

/** G05's project owner supplies the authoritative snapshot, including admitted adapter versions.
 * Model arguments never supply a project snapshot, registry, adapter or analysis configuration. */
export type GameBehaviorSource = (signal: AbortSignal) => unknown | Promise<unknown>;
export const BEHAVIOR_TOOL_IDS = ['behavior.query', 'behavior.locate', 'behavior.explain'] as const;
type BehaviorToolId = typeof BEHAVIOR_TOOL_IDS[number];
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const nodeId = { type: 'string', pattern: '^node:[A-Za-z0-9._:-]{3,160}$' };
const kinds = ['entry','statement','condition','loop','call','await','fork','join','return','throw','try','catch','finally','trigger','action','driver','unknown'];
const common = { baseRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, manifestDigest: digest, sourceBindingDigest: digest };
export const BEHAVIOR_TOOL_SCHEMAS = freezeSchema<Record<BehaviorToolId, JsonObject>>({
  'behavior.query': { type: 'object', additionalProperties: false, required: ['baseRevision'], properties: { ...common, entityId: { type: 'string', pattern: '^entity:[A-Za-z0-9._:-]{3,160}$' }, kind: { enum: kinds }, offset: { type: 'integer', minimum: 0, maximum: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, anyOf: [{ required: ['manifestDigest', 'sourceBindingDigest'] }, { properties: { offset: { const: 0 } }, not: { anyOf: [{ required: ['manifestDigest'] }, { required: ['sourceBindingDigest'] }] } }] },
  'behavior.locate': { type: 'object', additionalProperties: false, required: ['baseRevision','manifestDigest','sourceBindingDigest','nodeId'], properties: { ...common, nodeId } },
  'behavior.explain': { type: 'object', additionalProperties: false, required: ['baseRevision','manifestDigest','sourceBindingDigest','nodeIds','language'], properties: { ...common, nodeIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: nodeId }, language: { enum: ['en','zh-CN'] } } },
});

export function isBehaviorTool(id: string): id is BehaviorToolId { return (BEHAVIOR_TOOL_IDS as readonly string[]).includes(id); }
const invalid = () => new GameToolProtocolError('tool.arguments-invalid', 'Behavior arguments must match the discovered schema; page continuations require both current digests.');
export function normalizeBehaviorArguments(id: BehaviorToolId, raw: JsonObject): JsonObject {
  const missing = (BEHAVIOR_TOOL_SCHEMAS[id].required as readonly string[]).filter(key => raw[key] === undefined);
  if (missing.length) throw new GameToolProtocolError('tool.arguments-invalid', `Behavior arguments invalid; missing required fields: ${missing.join(', ')}.`);
  const properties = BEHAVIOR_TOOL_SCHEMAS[id].properties as JsonObject;
  if (Object.keys(raw).some(key => !Object.hasOwn(properties, key)) || !Number.isSafeInteger(raw.baseRevision) || Number(raw.baseRevision) < 0) throw invalid();
  const paired = raw.manifestDigest !== undefined || raw.sourceBindingDigest !== undefined;
  if ((id !== 'behavior.query' || paired) && (!matches(raw.manifestDigest, /^sha256:[a-f0-9]{64}$/u) || !matches(raw.sourceBindingDigest, /^sha256:[a-f0-9]{64}$/u))) throw invalid();
  if (id === 'behavior.query') {
    const offset = raw.offset === undefined ? 0 : raw.offset, limit = raw.limit === undefined ? 25 : raw.limit;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 2000 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || (Number(offset) > 0 && !paired)) throw invalid();
    if (raw.entityId !== undefined && !matches(raw.entityId, /^entity:[A-Za-z0-9._:-]{3,160}$/u)) throw invalid();
    if (raw.kind !== undefined && !kinds.includes(raw.kind as string)) throw invalid();
    return Object.freeze({ ...raw, offset, limit });
  }
  if (id === 'behavior.locate' && !matches(raw.nodeId, /^node:[A-Za-z0-9._:-]{3,160}$/u)) throw invalid();
  if (id === 'behavior.explain' && (!['en','zh-CN'].includes(raw.language as string) || !Array.isArray(raw.nodeIds) || raw.nodeIds.length < 1 || raw.nodeIds.length > 100 || new Set(raw.nodeIds).size !== raw.nodeIds.length || raw.nodeIds.some(value => !matches(value, /^node:[A-Za-z0-9._:-]{3,160}$/u)))) throw invalid();
  return Object.freeze({ ...raw });
}

/** Call-scoped G02 readers avoid shared mutable analysis state between requests.
 * This adapter has no project task state, artifact store, model prompts or document writer. */
export class BehaviorToolReader {
  private readonly readers = new Set<BehaviorReadService>();
  private closed = false;
  constructor(private readonly source: GameBehaviorSource | undefined, private readonly current: () => Readonly<{ projectId: StableId; documentId: StableId; revision: number }>) {}

  async execute(id: BehaviorToolId, args: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    if (!this.source) throw new GameToolProtocolError('behavior.unavailable', 'The project behavior source is not connected. Existing authoring tools remain available.');
    try {
      const input = await this.input(signal), binding = createBehaviorSourceBinding(input);
      this.guard(binding.projectId, binding.documentId, binding.documentRevision, args, signal);
      if (args.sourceBindingDigest !== undefined && args.sourceBindingDigest !== binding.digest) throw stale();
      const service = new BehaviorReadService(); this.readers.add(service);
      let value: JsonObject;
      try {
        const manifest = await service.analyze(input, signal);
        if (args.manifestDigest !== undefined && args.manifestDigest !== manifest.digest) throw stale();
        const bound = { schemaVersion: 1, manifestDigest: manifest.digest, sourceBindingDigest: binding.digest };
        if (id === 'behavior.query') value = queryPage(service, manifest, args, bound);
        else if (id === 'behavior.locate') value = { binding: asJson(binding), location: asJson(service.locate({ ...bound, nodeId: args.nodeId })) };
        else value = { binding: asJson(binding), explanation: asJson(service.explain({ ...bound, nodeIds: args.nodeIds, language: args.language })) };
        if (bytes(value) > 64 * 1024) throw new GameToolProtocolError('tool.result-too-large', 'Behavior result exceeds 64 KiB. Request fewer nodes.');
      } finally { await service.dispose(); this.readers.delete(service); }
      // Re-read after worker teardown: same revision with changed components/registry/adapters is stale too.
      const after = await this.input(signal);
      if (createBehaviorSourceBinding(after).digest !== binding.digest || canonicalStringify(asJson(after.config)) !== canonicalStringify(asJson(input.config))) throw stale();
      this.guard(binding.projectId, binding.documentId, binding.documentRevision, args, signal);
      return Object.freeze(value);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new GameToolProtocolError('tool.cancelled', 'Behavior read cancelled.');
      if (error instanceof GameToolProtocolError) throw error;
      // Never echo a source provider's exception (it may contain paths or credentials).
      const code = error instanceof BehaviorContractError && /^behavior\.[a-z-]{1,80}$/u.test(error.code) ? error.code : 'behavior.source-failed';
      throw new GameToolProtocolError(code, `Behavior read failed (${code}).`, code === 'behavior.stale');
    }
  }
  async dispose(): Promise<void> { this.closed = true; await Promise.all([...this.readers].map(reader => reader.dispose())); this.readers.clear(); }
  private async input(signal: AbortSignal): Promise<BehaviorAnalysisInputV1> {
    if (this.closed || signal.aborted) throw new GameToolProtocolError('tool.cancelled', 'Behavior reader is closed or cancelled.');
    let value: unknown;
    try { value = await abortable(() => this.source!(signal), signal); }
    catch { if (signal.aborted) throw signal.reason; throw new GameToolProtocolError('behavior.source-failed', 'The current behavior source could not be read.'); }
    if (this.closed || signal.aborted) throw new GameToolProtocolError('tool.cancelled', 'Behavior reader is closed or cancelled.');
    return parseBehaviorContract('behavior-analysis-input', value);
  }
  private guard(projectId: string, documentId: string, revision: number, args: JsonObject, signal: AbortSignal): void {
    if (this.closed || signal.aborted) throw new GameToolProtocolError('tool.cancelled', 'Behavior reader is closed or cancelled.');
    const current = this.current();
    if (projectId !== current.projectId || documentId !== current.documentId || revision !== current.revision || revision !== args.baseRevision) throw stale();
  }
}
function queryPage(service: BehaviorReadService, manifest: BehaviorManifestV1, args: JsonObject, bound: JsonObject): JsonObject {
  const requested = Number(args.limit);
  for (let limit = requested; limit >= 1; limit = Math.floor(limit / 2)) {
    const page = service.query({ ...bound, offset: args.offset, limit, ...(args.entityId === undefined ? {} : { entityId: args.entityId }), ...(args.kind === undefined ? {} : { kind: args.kind }) });
    const nodes = new Set(page.nodes.map(node => node.id));
    const value: JsonObject = { ...asJson(page), binding: asJson(manifest.binding), analyzerVersion: manifest.analyzerVersion, analysisConfigDigest: manifest.analysisConfigDigest, triggers: manifest.triggers.filter(id => nodes.has(id)), analysisTruncation: asJson(manifest.truncation), pageTruncated: limit < requested };
    if (bytes(value) <= 64 * 1024) return value;
  }
  throw new GameToolProtocolError('tool.result-too-large', 'Behavior binding or one node exceeds 64 KiB. No unbound partial result was returned.');
}
function asJson(value: object): JsonObject { return value as unknown as JsonObject; }
function freezeSchema<T extends object>(value: T): T { for (const child of Object.values(value)) if (child && typeof child === 'object') freezeSchema(child); return Object.freeze(value); }
function bytes(value: JsonObject): number { return new TextEncoder().encode(canonicalStringify(value)).byteLength; }
function matches(value: unknown, pattern: RegExp): boolean { return typeof value === 'string' && pattern.test(value); }
function stale(): GameToolProtocolError { return new GameToolProtocolError('behavior.stale', 'Behavior provenance no longer matches the current project. Query again at the current revision.', true); }
async function abortable(read: () => unknown | Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason ?? new GameToolProtocolError('tool.cancelled', 'Behavior read cancelled.')); signal.addEventListener('abort', abort, { once: true }); });
  try { if (signal.aborted) abort(); return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return read(); }), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
