import type { BehaviorAnalysisInputV1, BehaviorSourceV1, GameComponentInstanceV2, M12JsonValue } from '@haiyue/ai-studio-contracts';
import { BUILTIN_COMPONENT_DEFINITIONS } from '@haiyue/ai-studio-editor-plugins/components';
import { canonicalJson } from './canonical.js';
import { BehaviorGraphBuilder } from './graph.js';

type RecordValue = Readonly<Record<string, M12JsonValue>>;
const record = (value: M12JsonValue): RecordValue => value as RecordValue;
const array = (value: M12JsonValue): readonly M12JsonValue[] => value as readonly M12JsonValue[];
/** Field semantics come from the reviewed built-in schemas; unknown replacements are never guessed. */
export function analyzeDeclarative(input: BehaviorAnalysisInputV1, graph: BehaviorGraphBuilder): void {
  const owners = new Map(input.document.entities.flatMap(entity => entity.componentIds.map(id => [id, entity.id] as const)));
  const components = [...input.document.components].filter(component => component.enabled).sort((a, b) => a.id < b.id ? -1 : 1);
  const definitions = new Map(input.registry.definitions.map(definition => [`${definition.type}@${definition.version}`, definition]));
  const builtin = new Map(BUILTIN_COMPONENT_DEFINITIONS.map(definition => [`${definition.type}@${definition.version}`, definition]));
  const adapters = new Map(input.adapters.map(adapter => [adapter.id, adapter]));
  const source = (component: GameComponentInstanceV2, field = ''): BehaviorSourceV1 => ({ kind: 'declarative-component', entityId: owners.get(component.id)!, componentId: component.id, componentType: component.type, componentVersion: component.version, field });
  const recognized = (component: GameComponentInstanceV2): boolean => {
    const key = `${component.type}@${component.version}`;
    return !!builtin.get(key) && canonicalJson(definitions.get(key)) === canonicalJson(builtin.get(key));
  };
  const timers: { event: M12JsonValue; id: string | null; source: BehaviorSourceV1 }[] = [];
  const targets = components.filter(component => recognized(component) && ['haiyue.gameplay.state', 'haiyue.gameplay.pool'].includes(component.type));
  for (const component of components) {
    const definition = definitions.get(`${component.type}@${component.version}`)!;
    if (!recognized(component)) { graph.node('unknown', source(component), 'component-semantics', 'unsupported-syntax'); continue; }
    if (component.type === 'haiyue.gameplay.timers') {
      array(component.value.timers).forEach((value, i) => {
        const timer = record(value), ref = source(component, `/timers/${i}`);
        const id = graph.node(timer.running ? 'trigger' : 'statement', ref, timer.running ? 'timer-event' : 'timer-stopped');
        if (timer.running) timers.push({ event: timer.event, id, source: ref });
      });
    }
    if (definition.runtimeAdapter) {
      const adapter = adapters.get(definition.runtimeAdapter);
      if (!adapter) { graph.node('unknown', source(component), 'adapter-unavailable', 'unregistered-adapter'); continue; }
      const adapterSource: BehaviorSourceV1 = { kind: 'runtime-adapter', entityId: owners.get(component.id)!, componentId: component.id, adapter, field: '/runtimeAdapter' };
      const configuration = graph.node('statement', source(component), 'component-configuration');
      const driver = graph.node('driver', adapterSource, 'registered-component-driver');
      // This proves only the registry's component-to-adapter association, never a collision or animation result.
      graph.edge(configuration, driver, 'drives', adapterSource);
      graph.node('unknown', adapterSource, 'runtime-driver-internals', 'adapter-internals');
    }
  }
  for (const component of components) {
    if (!recognized(component) || component.type !== 'haiyue.gameplay.rules') continue;
    array(component.value.rules).forEach((value, i) => {
      const rule = record(value), when = record(rule.when), ref = source(component, `/rules/${i}/when`);
      const trigger = graph.node('trigger', ref, String(when.source));
      if (when.source === 'timer-event') {
        const matches = timers.filter(timer => timer.event === when.value);
        for (const timer of matches) graph.edge(timer.id, trigger, 'trigger', ref);
        if (!matches.length) graph.node('unknown', ref, 'timer-source', 'unresolved-reference');
      }
      if (when.source === 'collision' || when.source === 'trigger') graph.node('unknown', ref, 'contact-occurrence', 'adapter-internals');
      let previous = trigger;
      array(rule.actions).forEach((value, j) => {
        const action = record(value), actionSource = source(component, `/rules/${i}/actions/${j}`);
        const id = graph.node('action', actionSource, String(action.kind));
        graph.edge(previous, id, previous === trigger ? 'trigger' : 'sequence', actionSource); previous = id;
        const matched = targets.filter(target => target.value.observationId === action.targetObservationId && (action.kind === 'set-pool-count' ? target.type === 'haiyue.gameplay.pool' : target.type === 'haiyue.gameplay.state'));
        if (matched.length !== 1) graph.node('unknown', actionSource, 'action-target', 'unresolved-reference');
        else {
          const fields: Record<string, string> = { 'set-state': '/state', 'add-score': '/score', 'set-health': '/health', 'add-health': '/health', 'set-checkpoint': '/checkpoint', 'set-counter': '/counters', 'add-counter': '/counters', 'set-flag': '/flags', 'emit-event': '/events', 'set-pool-count': '/activeCount' };
          const targetSource = source(matched[0], fields[String(action.kind)]);
          const target = graph.node('statement', targetSource, 'action-target-field');
          graph.edge(id, target, 'drives', actionSource);
        }
      });
    });
  }
}
