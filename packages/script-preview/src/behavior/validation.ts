import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import type { BehaviorAnalysisInputV1, BehaviorExplanationV1, BehaviorManifestV1, BehaviorSourceBindingV1, BehaviorTraceV1, EditorLocationV1, ResourceCatalogEntryV1, ObservationArtifactV2 } from '@haiyue/ai-studio-contracts';
import { BehaviorContractError, checkedJson, freezeProjection, canonicalJson, verifyDigest } from './canonical.js';

interface Contracts {
  'behavior-analysis-input': BehaviorAnalysisInputV1;
  'behavior-source-binding': BehaviorSourceBindingV1;
  'behavior-manifest': BehaviorManifestV1;
  'behavior-explanation': BehaviorExplanationV1;
  'behavior-trace': BehaviorTraceV1;
  'resource-catalog-entry': ResourceCatalogEntryV1;
  'editor-location': EditorLocationV1;
  'observation-artifact': ObservationArtifactV2;
}
const budgets: Record<keyof Contracts, number> = {
  'behavior-analysis-input': 8 * 1024 * 1024, 'behavior-source-binding': 128 * 1024,
  'behavior-manifest': 2 * 1024 * 1024, 'behavior-explanation': 256 * 1024,
  'behavior-trace': 4 * 1024 * 1024, 'resource-catalog-entry': 256 * 1024,
  'editor-location': 4096, 'observation-artifact': 256 * 1024,
};
let ajv: Ajv | undefined;
function validator(): Ajv {
  if (ajv) return ajv;
  const instance = new Ajv({ strict: true, allErrors: false });
  // Only shipped, fixed schema paths are read. Project/model strings never select files.
  const files = ['m12-game-document', 'm12-component-definition', 'm12-capability-id', 'm12-observation-artifact',
    'm14-behavior-analysis-input', 'm14-behavior-source-binding', 'm14-behavior-manifest',
    'm14-behavior-explanation', 'm14-behavior-trace', 'm14-resource-catalog-entry', 'm14-editor-location'];
  for (const file of files) instance.addSchema(JSON.parse(readFileSync(new URL(`../../../../config/contracts/schemas/${file}.schema.json`, import.meta.url), 'utf8')));
  ajv = instance;
  return instance;
}
export function parseBehaviorContract<K extends keyof Contracts>(kind: K, input: unknown): Contracts[K] {
  const value = checkedJson(input, budgets[kind]);
  const valid = validator().getSchema(`haiyue://contracts/${kind}/${kind === 'observation-artifact' ? 'v2' : 'v1'}`);
  if (!valid || !valid(value)) throw new BehaviorContractError(`behavior.invalid-${kind}`);
  const parsed = value as Contracts[K];
  if (kind.startsWith('behavior-') && kind !== 'behavior-analysis-input') verifyDigest(parsed as BehaviorSourceBindingV1);
  if (kind === 'behavior-source-binding') checkBinding(parsed as BehaviorSourceBindingV1);
  if (kind === 'behavior-manifest') checkManifest(parsed as BehaviorManifestV1);
  if (kind === 'behavior-explanation') unique((parsed as BehaviorExplanationV1).entries.map(entry => entry.nodeId));
  if (kind === 'behavior-trace') {
    const trace = parsed as BehaviorTraceV1;
    checkTruncation(trace.truncation);
    let previous = -1;
    for (const event of trace.events) {
      if (event.sequence <= previous || (['node-enter', 'node-exit'].includes(event.kind) && !event.nodeId) || (event.kind === 'error' && !event.error) || (event.kind === 'state-diff' && !event.stateDiff)) throw new BehaviorContractError('behavior.trace-event');
      previous = event.sequence;
    }
  }
  if (kind === 'resource-catalog-entry') checkResource(parsed as ResourceCatalogEntryV1);
  return freezeProjection(parsed);
}
export function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new BehaviorContractError('behavior.duplicate-id');
}
function checkBinding(binding: BehaviorSourceBindingV1): void {
  verifyDigest(binding);
  unique(binding.scripts.map(script => script.id));
  unique(binding.adapters.map(adapter => adapter.id));
  for (const values of [binding.scripts, binding.adapters]) {
    if (canonicalJson(values) !== canonicalJson([...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) throw new BehaviorContractError('behavior.noncanonical-binding');
  }
}
function checkTruncation(value: BehaviorManifestV1['truncation']): void {
  if (value.truncated !== (value.reasons.length > 0) || (!value.truncated && value.omittedAtLeast !== 0) || (value.truncated && value.omittedAtLeast < 1)) throw new BehaviorContractError('behavior.invalid-truncation');
}
function checkManifest(manifest: BehaviorManifestV1): void {
  checkBinding(manifest.binding);
  checkTruncation(manifest.truncation);
  unique(manifest.nodes.map(node => node.id)); unique(manifest.edges.map(edge => edge.id));
  const nodes = new Map(manifest.nodes.map(node => [node.id, node]));
  for (const trigger of manifest.triggers) if (!nodes.has(trigger) || !['entry', 'trigger'].includes(nodes.get(trigger)!.kind)) throw new BehaviorContractError('behavior.invalid-trigger');
  for (const edge of manifest.edges) if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new BehaviorContractError('behavior.dangling-edge');
  for (const source of [...manifest.nodes.map(node => node.source), ...manifest.edges.map(edge => edge.evidence)]) {
    if (source.kind === 'script') {
      const script = manifest.binding.scripts.find(script => script.id === source.scriptId);
      const r = source.range;
      if (!script || source.digest !== script.digest || r.end < r.start || r.endLine < r.startLine || (r.endLine === r.startLine && r.endColumn < r.startColumn)) throw new BehaviorContractError('behavior.source-mismatch');
    } else if (source.kind === 'runtime-adapter' && !manifest.binding.adapters.some(adapter => canonicalJson(adapter) === canonicalJson(source.adapter))) throw new BehaviorContractError('behavior.adapter-mismatch');
  }
}
function checkResource(entry: ResourceCatalogEntryV1): void {
  if (entry.status === 'unavailable' && entry.intents.length) throw new BehaviorContractError('behavior.unavailable-intent');
  if (entry.source === 'unsupported' && entry.status !== 'unavailable') throw new BehaviorContractError('behavior.resource-not-persisted');
  if (entry.kind === 'asset') {
    if (entry.usage.status === 'inapplicable') throw new BehaviorContractError('behavior.asset-usage');
    const expected = entry.usage.status === 'known' ? entry.usage.items.length === 0 ? 'yes' : 'no' : 'unknown';
    if (entry.unused !== expected) throw new BehaviorContractError('behavior.asset-unused');
  }
}
