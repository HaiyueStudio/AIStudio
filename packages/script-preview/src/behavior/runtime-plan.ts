import type { BehaviorNodeV1 } from '@haiyue/ai-studio-contracts';
import { createBehaviorSourceBinding, prepareBehaviorInput } from './binding.js';
import { BehaviorContractError } from './canonical.js';
import { instrumentBehaviorScripts } from './instrument.js';
import { parseBehaviorRuntimePlan, type BehaviorRuntimePlan } from './runtime-observer.js';
import { parseBehaviorContract } from './validation.js';

/** An ephemeral compiler/observation index, derived from the same approved text.
 * It is not an authoring model, persisted envelope or additional Play authority. */
export function createBehaviorRuntimePlan(sourceInput: unknown, manifestInput: unknown, selection: Readonly<{
  playId: string; generation: number; scripts: readonly Readonly<{ scriptId: string; emittedText: string }>[];
}>): BehaviorRuntimePlan {
  const source = prepareBehaviorInput(sourceInput), manifest = parseBehaviorContract('behavior-manifest', manifestInput);
  if (manifest.binding.digest !== createBehaviorSourceBinding(source).digest) throw new BehaviorContractError('behavior.stale');
  const selected = new Map(selection.scripts.map(script => [script.scriptId, script.emittedText]));
  if (selected.size !== selection.scripts.length) throw new BehaviorContractError('behavior.runtime-selection');
  const programs = instrumentBehaviorScripts(source, manifest).filter(program => selected.has(program.scriptId)).map(program => {
    if (program.originalEmittedText !== selected.get(program.scriptId)) throw new BehaviorContractError('behavior.runtime-approved-text');
    return { ...program, entityId: source.document.scripts.find(script => script.id === program.scriptId)!.entityId };
  });
  if (programs.length !== selected.size) throw new BehaviorContractError('behavior.runtime-selection');
  const owners = new Map(source.document.entities.flatMap(entity => entity.componentIds.map(id => [id, entity.id] as const)));
  const components = source.document.components.filter(component => component.enabled).map(component => ({
    id: component.id, entityId: owners.get(component.id)!, type: component.type,
    ruleIds: component.type === 'haiyue.gameplay.rules' ? ids(component.value.rules) : [],
    timerIds: component.type === 'haiyue.gameplay.timers' ? ids(component.value.timers) : [],
  }));
  return parseBehaviorRuntimePlan({ playId: selection.playId, generation: selection.generation,
    sourceBindingDigest: manifest.binding.digest, manifestDigest: manifest.digest,
    entityIds: source.document.entities.map(entity => entity.id), programs, components,
    nodes: manifest.nodes.filter(node => node.source.kind !== 'script' || selected.has(node.source.scriptId)).map(runtimeNode),
  });
}
function ids(value: unknown): string[] { return Array.isArray(value) ? value.map(item => String(item.id)) : []; }
function runtimeNode(node: BehaviorNodeV1) {
  return { id: node.id, kind: node.kind, entityId: node.source.entityId,
    scriptId: node.source.kind === 'script' ? node.source.scriptId : null,
    componentId: node.source.kind === 'script' ? null : node.source.componentId,
    // Adapter internals have no executable field marker.
    field: node.source.kind === 'declarative-component' ? node.source.field : null };
}
