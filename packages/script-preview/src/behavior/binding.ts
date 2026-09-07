import { asStableId, type BehaviorAnalysisInputV1, type BehaviorSourceBindingV1 } from '@haiyue/ai-studio-contracts';
import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins/components';
import { GameDocumentStore } from '@haiyue/ai-studio-editor-plugins/project';
import { BehaviorContractError, behaviorDigest, freezeProjection, sourceTextDigest, withDigest } from './canonical.js';
import { parseBehaviorContract, unique } from './validation.js';

export const DEFAULT_BEHAVIOR_CONFIG = Object.freeze({ schemaVersion: 1, maxNodes: 2000, maxEdges: 4000, maxAstNodes: 100000, maxAstDepth: 128 } as const);
export const BEHAVIOR_ANALYZER_VERSION = '1.0.0';
export function prepareBehaviorInput(input: unknown): BehaviorAnalysisInputV1 {
  const parsed = parseBehaviorContract('behavior-analysis-input', input);
  if (parsed.document.scripts.length > 200 || parsed.document.entities.length > 10000) throw new BehaviorContractError('behavior.input-budget');
  unique(parsed.adapters.map(adapter => adapter.id));
  const registry = new ComponentRegistry(parsed.registry.definitions);
  for (const script of parsed.document.scripts) {
    if (script.digest !== sourceTextDigest(script.source)) throw new BehaviorContractError('behavior.script-digest');
    if (!/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*[\\:])[A-Za-z0-9._ /-]+\.tsx?$/u.test(script.sourcePath)) throw new BehaviorContractError('behavior.source-path');
  }
  // Reuse the document owner's relationship and registered component validation without applying operations.
  new GameDocumentStore(asStableId(parsed.document.id), parsed.document, registry);
  return parsed;
}
const byId = <T extends { readonly id: string }>(values: readonly T[]): T[] => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function createBehaviorSourceBinding(input: unknown): BehaviorSourceBindingV1 {
  return bindPreparedInput(prepareBehaviorInput(input));
}
export function bindPreparedInput(input: BehaviorAnalysisInputV1): BehaviorSourceBindingV1 {
  const document = input.document;
  const definitions = [...input.registry.definitions].sort((a, b) => `${a.type}@${a.version}` < `${b.type}@${b.version}` ? -1 : 1);
  const structuralDocument = {
    id: document.id, revision: document.revision,
    scenes: byId(document.scenes), entities: byId(document.entities), components: byId(document.components),
    scripts: byId(document.scripts).map(({ source: _source, ...script }) => script), assets: byId(document.assets), settings: document.settings,
  };
  return freezeProjection(withDigest({
    schemaVersion: 1 as const, projectId: input.projectId, documentId: document.id, documentRevision: document.revision,
    documentDigest: behaviorDigest(structuralDocument),
    scripts: byId(document.scripts).map(({ id, digest, textRevision, enabled }) => ({ id, digest, textRevision, enabled })),
    componentsDigest: behaviorDigest(byId(document.components)), dependenciesDigest: behaviorDigest({ assets: byId(document.assets), settings: document.settings }),
    registry: { version: input.registry.version, digest: behaviorDigest(definitions) }, adapters: byId(input.adapters),
  }));
}
