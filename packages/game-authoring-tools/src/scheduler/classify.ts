import type { JsonObject, ToolBatchNodeV1, ToolEffectV1, ToolExecutionClassV1 } from '@haiyue/ai-studio-contracts';
import { sha256 } from '@haiyue/ai-studio-operation-log';
import type { GameToolDefinition } from '../types.js';

export interface ToolConcurrencyClassification {
  readonly executionClass: ToolExecutionClassV1;
  readonly effects: readonly ToolEffectV1[];
  readonly effectKeys: readonly string[];
}

const RUNTIME_STATE_TOOL_IDS = new Set(['preview.validate', 'preview.start', 'preview.stop', 'play.start', 'play.stop', 'play.step', 'play.input', 'play.physics-query', 'play.inspect', 'play.capture']);

/** Derives trusted scheduling metadata exclusively from the registered definition and bounded arguments. */
export function classifyToolConcurrency(definition: GameToolDefinition | undefined, args: JsonObject): ToolConcurrencyClassification {
  if (!definition) return frozen('unknown-exclusive', ['unknown'], ['tool-registry:unknown']);
  try {
    const approval = definition.requiresApproval ? ['approval' as const] : [];
    if (RUNTIME_STATE_TOOL_IDS.has(definition.id)) return frozen('runtime-barrier', unique(['runtime-control', ...approval]), ['runtime:preview']);
    if (definition.effect === 'trusted-code') return frozen('trusted-code-barrier', unique(['trusted-code', ...(definition.id === 'script.apply' ? ['document-mutation' as const] : []), ...approval]), effectKeys(args, 'script'));
    if (definition.effect === 'runtime-start') return frozen('runtime-barrier', unique(['runtime-control', ...approval]), ['runtime:preview']);
    if (definition.effect === 'reversible-edit') return frozen(definition.requiresApproval ? 'approval-barrier' : 'exclusive-mutation', unique(['document-mutation', ...approval]), effectKeys(args, 'document'));
    if (definition.effect === 'observe' && definition.concurrencySafe === true) return frozen('parallel-read', ['observe'], effectKeys(args, 'read'));
    return frozen('unknown-exclusive', ['unknown'], [`tool:${definition.id}`]);
  } catch {
    return frozen('unknown-exclusive', ['unknown'], [`tool:${definition.id}`]);
  }
}

export function classificationMatches(node: ToolBatchNodeV1, trusted: ToolConcurrencyClassification): boolean {
  return node.executionClass === trusted.executionClass
    && same(node.effects, trusted.effects)
    && same(node.effectKeys, trusted.effectKeys);
}

function effectKeys(args: JsonObject, fallback: string): readonly string[] {
  const keys: string[] = [];
  for (const field of ['entityId', 'parentId', 'componentId', 'scriptId', 'assetId', 'proposalId', 'planId'] as const) {
    const value = args[field];
    if (typeof value === 'string' && value.length > 0 && value.length <= 65_536) keys.push(stableEffectKey(value));
  }
  const entityIds = args.entityIds;
  if (Array.isArray(entityIds)) for (const value of entityIds.slice(0, 128)) if (typeof value === 'string' && value.length > 0 && value.length <= 65_536) keys.push(stableEffectKey(value));
  const transforms = args.transforms;
  if (Array.isArray(transforms)) for (const assignment of transforms.slice(0, 128)) {
    const value = assignment && typeof assignment === 'object' && !Array.isArray(assignment) ? (assignment as JsonObject).entityId : undefined;
    if (typeof value === 'string' && value.length > 0 && value.length <= 65_536) keys.push(stableEffectKey(value));
  }
  if (keys.length === 0) keys.push(`${fallback}:current`);
  return Object.freeze([...new Set(keys)].sort());
}

function stableEffectKey(value: string): string { return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value) ? value : `ref:${sha256(value)}`; }

function unique(values: readonly ToolEffectV1[]): readonly ToolEffectV1[] { return Object.freeze([...new Set(values)]); }
function same(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function frozen(executionClass: ToolExecutionClassV1, effects: readonly ToolEffectV1[], effectKeys: readonly string[]): ToolConcurrencyClassification {
  return Object.freeze({ executionClass, effects: Object.freeze([...effects]), effectKeys: Object.freeze([...effectKeys]) });
}
