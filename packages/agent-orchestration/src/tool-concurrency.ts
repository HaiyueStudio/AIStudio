import type { ToolConcurrencyHintV1 } from '@haiyue/ai-studio-contracts';
import { classifyToolConcurrency, type GameToolDefinition } from '@haiyue/ai-studio-game-authoring-tools';

/** Reuse the scheduler's registry classification; scripts stay exclusive in this first rollout. */
export function toolConcurrencyHint(definition: GameToolDefinition | undefined): ToolConcurrencyHintV1 {
  return Object.freeze({ schemaVersion: 1, mode: definition && !definition.id.startsWith('script.')
    && classifyToolConcurrency(definition, {}).executionClass === 'parallel-read' ? 'parallel-read' : 'exclusive' });
}
export function invocationConcurrencyHint(definitions: readonly GameToolDefinition[]): ToolConcurrencyHintV1 {
  return Object.freeze({ schemaVersion: 1, mode: 'invoke', targets: Object.freeze(definitions
    .filter(definition => toolConcurrencyHint(definition).mode === 'parallel-read')
    .map(definition => Object.freeze({ toolId: definition.id, toolVersion: definition.version }))
    .sort((left, right) => left.toolId.localeCompare(right.toolId))) });
}
