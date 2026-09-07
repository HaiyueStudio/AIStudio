import type { BehaviorManifestV1 } from '@haiyue/ai-studio-contracts';
import { BEHAVIOR_ANALYZER_VERSION, bindPreparedInput, prepareBehaviorInput } from './binding.js';
import { behaviorDigest, withDigest } from './canonical.js';
import { analyzeDeclarative } from './declarative.js';
import { BehaviorGraphBuilder } from './graph.js';
import { analyzeScript } from './script.js';
import { parseBehaviorContract } from './validation.js';

/** Synchronous pure projection for controlled headless callers; interactive consumers use the worker service. */
export function analyzeBehavior(input: unknown): BehaviorManifestV1 {
  const prepared = prepareBehaviorInput(input);
  const binding = bindPreparedInput(prepared);
  const graph = new BehaviorGraphBuilder(prepared.config);
  for (const script of [...prepared.document.scripts].sort((a, b) => a.id < b.id ? -1 : 1)) if (script.enabled) analyzeScript(script, graph);
  analyzeDeclarative(prepared, graph);
  return parseBehaviorContract('behavior-manifest', withDigest({ schemaVersion: 1, binding, analyzerVersion: BEHAVIOR_ANALYZER_VERSION,
    analysisConfigDigest: behaviorDigest(prepared.config), nodes: graph.nodes, edges: graph.edges, triggers: graph.triggers, truncation: graph.truncation() }));
}
