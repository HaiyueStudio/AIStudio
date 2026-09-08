import type { BehaviorNodeKindV1, BehaviorTraceV1, M12JsonValue } from '@haiyue/ai-studio-contracts';
import type { ScriptCompiler, ScriptCompiledFunction } from '@haiyue/engine/components';
import type { BehaviorScriptProgram } from './instrument.js';
import { checkedJson, canonicalJson, freezeProjection, utf8Bytes } from './json.js';

/** Browser-safe admission for existing declarative gameplay. An empty scene still
 * follows the existing missing-script UX; configured gameplay needs no fake script. */
export function hasDeclarativeGameplay(components: readonly Readonly<{ type: string; enabled: boolean }>[]): boolean {
  return components.some(component => component.enabled && ['haiyue.gameplay.state', 'haiyue.gameplay.timers', 'haiyue.gameplay.rules', 'haiyue.gameplay.pool', 'haiyue.ui.hud'].includes(component.type));
}

type TraceEvent = BehaviorTraceV1['events'][number];
interface Owner { readonly entityId: string; readonly componentId: string | null; readonly scriptId: string | null; }
interface RuntimeNode extends Owner { readonly id: string; readonly kind: BehaviorNodeKindV1; readonly field: string | null; }
interface RuntimeComponent { readonly id: string; readonly entityId: string; readonly type: string; readonly ruleIds: readonly string[]; readonly timerIds: readonly string[]; }
export interface BehaviorRuntimePlan {
  readonly playId: string; readonly generation: number; readonly sourceBindingDigest: string; readonly manifestDigest: string;
  readonly entityIds: readonly string[]; readonly nodes: readonly RuntimeNode[];
  readonly programs: readonly (BehaviorScriptProgram & Readonly<{ entityId: string }>)[];
  readonly components: readonly RuntimeComponent[];
}
/** Captured data uses the existing trace fields; the digest is sealed by the
 * trusted ingress after source/Play ownership and the bounded payload are checked. */
export type BehaviorRuntimeCapture = Omit<BehaviorTraceV1, 'digest'> & Readonly<{ tick: number; frame: number; closed: boolean }>;

export function parseBehaviorRuntimePlan(input: unknown): BehaviorRuntimePlan {
  const p = checkedJson(input, 8 * 1024 * 1024);
  if (!record(p) || !exact(p, ['playId','generation','sourceBindingDigest','manifestDigest','entityIds','nodes','programs','components'])
    || !id(p.playId) || !integer(p.generation, 1) || !digest(p.sourceBindingDigest) || !digest(p.manifestDigest)
    || !uniqueIds(p.entityIds, 10000) || !Array.isArray(p.nodes) || p.nodes.length > 2000 || !Array.isArray(p.programs) || p.programs.length > 128
    || !Array.isArray(p.components) || p.components.length > 10000) throw new Error('behavior.runtime-plan');
  const entities = new Set(p.entityIds), nodes = new Map<string, RuntimeNode>(), components = new Map<string, RuntimeComponent>();
  const kinds = ['entry','statement','condition','loop','call','await','fork','join','return','throw','try','catch','finally','trigger','action','driver','unknown'];
  for (const c of p.components) {
    if (!record(c) || !exact(c, ['id','entityId','type','ruleIds','timerIds']) || !id(c.id) || components.has(c.id)
      || !id(c.entityId) || !entities.has(c.entityId) || typeof c.type !== 'string' || c.type.length > 256 || !uniqueStrings(c.ruleIds, 512) || !uniqueStrings(c.timerIds, 512)) throw new Error('behavior.runtime-component');
    components.set(c.id, c as unknown as RuntimeComponent);
  }
  for (const n of p.nodes) {
    if (!record(n) || !exact(n, ['id','kind','entityId','componentId','scriptId','field']) || !id(n.id) || nodes.has(n.id) || !id(n.entityId) || !entities.has(n.entityId)
      || !kinds.includes(String(n.kind)) || !(n.scriptId === null || id(n.scriptId)) || !(n.componentId === null || id(n.componentId))
      || (n.scriptId === null) === (n.componentId === null) || !(n.field === null || typeof n.field === 'string' && n.field.length <= 4096)
      || (n.componentId !== null && components.get(n.componentId as string)?.entityId !== n.entityId)) throw new Error('behavior.runtime-node');
    nodes.set(n.id, n as unknown as RuntimeNode);
  }
  const scripts = new Set<string>();
  for (const s of p.programs) {
    if (!record(s) || !exact(s, ['scriptId','entityId','sourceDigest','originalEmittedText','instrumentedText','callbackName','entryNodeId','instrumentedNodeIds'])
      || !id(s.scriptId) || scripts.has(s.scriptId) || !id(s.entityId) || !entities.has(s.entityId) || !digest(s.sourceDigest)
      || typeof s.originalEmittedText !== 'string' || s.originalEmittedText.length > 1024 * 1024 || typeof s.instrumentedText !== 'string' || s.instrumentedText.length > 2 * 1024 * 1024
      || typeof s.callbackName !== 'string' || !/^__haiyueBehavior_[a-f0-9]{16}_*$/u.test(s.callbackName) || !uniqueIds(s.instrumentedNodeIds, 2000)
      || !(s.entryNodeId === null || id(s.entryNodeId))) throw new Error('behavior.runtime-program');
    for (const nodeId of [...s.instrumentedNodeIds, ...(s.entryNodeId ? [s.entryNodeId] : [])]) {
      const n = nodes.get(nodeId); if (n?.scriptId !== s.scriptId || n.entityId !== s.entityId || (nodeId === s.entryNodeId && n.kind !== 'entry')) throw new Error('behavior.runtime-program-node');
    }
    scripts.add(s.scriptId);
  }
  for (const n of nodes.values()) if (n.scriptId !== null && !scripts.has(n.scriptId)) throw new Error('behavior.runtime-script-owner');
  return freezeProjection(p as unknown as BehaviorRuntimePlan);
}

/** One recorder per real Play realm. Hooks observe executions without owning the
 * engine, input clock, promises, component state or project mutation. */
export class BehaviorRuntimeRecorder {
  readonly plan: BehaviorRuntimePlan;
  private readonly nodes: Map<string, RuntimeNode>;
  private readonly components: Map<string, RuntimeComponent>;
  private readonly fields = new Map<string, RuntimeNode[]>();
  private readonly events: TraceEvent[] = [];
  private readonly previousState = new Map<string, Record<string, M12JsonValue>>();
  private readonly stateBytes = new Map<string, number>();
  private totalStateBytes = 0;
  private readonly reasons = new Set<'events' | 'bytes'>();
  private omitted = 0;
  private bytes = 0;
  private sequence = 0;
  private tick = 0;
  private frame = 0;
  private closed = false;
  constructor(input: unknown, private readonly now: () => number = () => performance.now()) {
    this.plan = parseBehaviorRuntimePlan(input); this.nodes = new Map(this.plan.nodes.map(n => [n.id, n]));
    this.components = new Map(this.plan.components.map(c => [c.id, c]));
    for (const n of this.plan.nodes) if (n.componentId && n.field !== null) { const key = `${n.componentId}:${n.field}`; this.fields.set(key, [...(this.fields.get(key) ?? []), n]); }
  }
  beginTick(tick: number, frame: number): void {
    if (this.closed) return;
    if (!integer(tick) || !integer(frame) || tick < this.tick || frame < this.frame) { this.close('clock-reset'); return; }
    this.tick = tick; this.frame = frame;
  }
  /** Install via Engine's public ScriptComponent compiler seam. Exact original
   * emitted text is mandatory; a hot reload invalidates the whole old overlay. */
  compiler(resolveScript: (component: Parameters<ScriptCompiler>[1]['component']) => string | undefined): ScriptCompiler {
    const recorder = this;
    return (code, context) => {
      const scriptId = resolveScript(context.component), program = this.plan.programs.find(p => p.scriptId === scriptId);
      if (this.closed || !program || code !== program.originalEmittedText) {
        if (!this.closed) this.close('source-changed');
        return new Function('entity','component','world','time','delta','event','api', `${code}\n//# sourceURL=${context.sourceUrl}`) as ScriptCompiledFunction;
      }
      const starts = new Map<string, { time: number; ambiguous: boolean }[]>(), owner: Owner = { entityId: program.entityId, scriptId: program.scriptId, componentId: null };
      const enter = (nodeId: string) => {
        if (this.closed) return;
        const n = this.nodes.get(nodeId); if (!n || n.scriptId !== program.scriptId) return;
        if (this.reasons.size) { this.emit(owner, nodeId, 'node-enter'); return; }
        // A thrown expression may lack an exit; cap unfinished timing scopes.
        const stack = starts.get(nodeId) ?? [];
        // Overlapping async invocations may resume out of order. There is no
        // per-invocation token in the fixed trace contract, so omit those times.
        if (stack.length) for (const active of stack) active.ambiguous = true;
        if (stack.length < 256) stack.push({ time: this.now(), ambiguous: stack.length > 0 }); starts.set(nodeId, stack);
        this.emit(owner, nodeId, 'node-enter');
      };
      const exit = <T>(nodeId: string, value: T): T => {
        if (!this.closed) {
          const n = this.nodes.get(nodeId); if (!n || n.scriptId !== program.scriptId) return value;
          if (this.reasons.size) { this.emit(owner, nodeId, 'node-exit'); return value; }
          const start = starts.get(nodeId)?.pop();
          const duration = !start || start.ambiguous ? null : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round((this.now() - start.time) * 1000)));
          this.emit(owner, nodeId, 'node-exit', null, duration, (n.kind === 'condition' || n.kind === 'loop') ? { truthy: Boolean(value), nullish: value === null || value === undefined } : null);
        }
        return value;
      };
      const hooks = Object.freeze({ enter, exit, value: <T>(nodeId: string, value: T): T => { enter(nodeId); return exit(nodeId, value); } });
      // Keep the original seven-argument function and directive prologue intact.
      const compiled = new Function(program.callbackName, `return function(entity,component,world,time,delta,event,api) {\n${program.instrumentedText}\n//# sourceURL=${context.sourceUrl}\n}`)(hooks) as ScriptCompiledFunction;
      return function(this: unknown, ...args: Parameters<ScriptCompiledFunction>) {
        if (program.entryNodeId) enter(program.entryNodeId);
        try { const result = Reflect.apply(compiled, this, args); return program.entryNodeId ? exit(program.entryNodeId, result) : result; }
        catch (error) { recorder.emit(owner, null, 'error', 'script-throw', null, null, 'behavior.script-error'); throw error; }
      };
      // The wrapper never awaits or adds Promise handlers; it records only the
      // synchronous call's return. Await-expression markers observe real resumes.
    };
  }
  captureDeclarative(input: unknown, advanced: boolean): void {
    if (this.closed) return;
    // Runtime values may contain project strings. Validate before copying them;
    // a rejected observation must never abort the actual simulation.
    let snapshot: Record<string, unknown>;
    try {
      const value = checkedJson(input, 256 * 1024);
      if (!record(value) || !integer(value.tick) || value.tick !== this.tick || !Array.isArray(value.observations)) return;
      snapshot = value;
    } catch { this.redactedState(); return; }
    // Snapshot serialization order is not execution order. Timers advance before
    // rules; final state is sampled after the complete rule batch in the runtime.
    const observations = [...snapshot.observations as unknown[]].sort((a, b) => this.observationPhase(a) - this.observationPhase(b));
    for (const item of observations) {
      if (!record(item) || !record(item.owner) || !record(item.value)) continue;
      const c = this.components.get(String(item.owner.scriptId));
      if (!c || c.entityId !== item.owner.entityId) continue;
      const owner: Owner = { entityId: c.entityId, componentId: c.id, scriptId: null }, value = item.value;
      if (advanced && c.type === 'haiyue.gameplay.timers' && Array.isArray(value.timers)) {
        value.timers.forEach((timer, i) => { if (record(timer) && timer.fired === true && timer.id === c.timerIds[i]) this.componentOccurrence(owner, `/timers/${i}`, 'trigger', 'timer-fired'); });
      }
      if (advanced && c.type === 'haiyue.gameplay.rules' && Array.isArray(value.firedRules)) {
        for (const ruleId of value.firedRules) {
          const i = c.ruleIds.indexOf(String(ruleId)); if (i < 0) continue;
          this.componentOccurrence(owner, `/rules/${i}/when`, 'trigger', 'rule-fired');
          const actions = this.plan.nodes.filter(n => n.componentId === c.id && n.kind === 'action' && n.field?.startsWith(`/rules/${i}/actions/`)).sort((a,b) => Number(a.field!.split('/').at(-1)) - Number(b.field!.split('/').at(-1)));
          // The production runtime publishes firedRules only after every action
          // succeeds. This establishes completion, not invented action durations.
          for (const action of actions) this.emit(owner, action.id, 'event', 'action-completed');
        }
      }
      if (c.type === 'haiyue.gameplay.state') this.stateChanges(owner, value);
    }
  }
  capturePhysics(input: unknown): void {
    if (this.closed) return;
    let events: unknown;
    try { events = checkedJson(input, 64 * 1024); } catch { this.redactedState(); return; }
    if (!Array.isArray(events)) return;
    for (const event of events) {
      if (!record(event) || !['collision','trigger'].includes(String(event.kind)) || !['enter','stay','exit'].includes(String(event.phase))) continue;
      for (const entityId of new Set([event.entityAId, event.entityBId])) if (typeof entityId === 'string' && this.plan.entityIds.includes(entityId)) {
        this.emit({ entityId, componentId: null, scriptId: null }, null, 'event', `physics-${event.kind}-${event.phase}`);
      }
    }
  }
  recordError(scriptId: string | null): void {
    const script = scriptId === null ? null : this.plan.programs.find(program => program.scriptId === scriptId);
    const entityId = script?.entityId ?? (scriptId === null ? this.plan.entityIds[0] : undefined);
    if (entityId) this.emit({ entityId, componentId: null, scriptId: script?.scriptId ?? null }, null, 'error', 'runtime-error', null, null, 'behavior.runtime-error');
  }
  close(reason: 'stop' | 'restart' | 'clock-reset' | 'source-changed' | 'project-changed' = 'stop'): void {
    if (this.closed) return;
    const entityId = this.plan.entityIds[0]; if (entityId) this.emit({ entityId, scriptId: null, componentId: null }, null, 'cancel', reason);
    this.closed = true; this.previousState.clear(); this.stateBytes.clear(); this.totalStateBytes = 0;
  }
  snapshot(): BehaviorRuntimeCapture {
    return freezeProjection({ schemaVersion: 1, sourceBindingDigest: this.plan.sourceBindingDigest as BehaviorTraceV1['sourceBindingDigest'], manifestDigest: this.plan.manifestDigest as BehaviorTraceV1['manifestDigest'], playId: this.plan.playId, generation: this.plan.generation,
      events: [...this.events], truncation: { truncated: this.reasons.size > 0, reasons: [...this.reasons], omittedAtLeast: this.omitted }, tick: this.tick, frame: this.frame, closed: this.closed });
  }
  private componentOccurrence(owner: Owner, field: string, kind: BehaviorNodeKindV1, event: string): void {
    for (const node of this.fields.get(`${owner.componentId}:${field}`) ?? []) if (node.kind === kind) this.emit(owner, node.id, 'event', event);
  }
  private stateChanges(owner: Owner, value: Record<string, unknown>): void {
    const next: Record<string, M12JsonValue> = {};
    for (const field of ['state','score','health','maxHealth','checkpoint','counters','flags','events']) if (field in value) next[field] = value[field] as M12JsonValue;
    const key = owner.componentId!, bytes = utf8Bytes(canonicalJson(next)), total = this.totalStateBytes - (this.stateBytes.get(key) ?? 0) + bytes;
    if (bytes > 8192 || total > 512 * 1024) { this.redactedState(); return; }
    const before = this.previousState.get(key); this.previousState.set(key, next); this.stateBytes.set(key, bytes); this.totalStateBytes = total;
    if (!before) return;
    for (const [field, after] of Object.entries(next)) if (canonicalJson(before[field] ?? null) !== canonicalJson(after)) {
      const node = this.fields.get(`${key}:/${field}`)?.find(n => n.kind === 'statement');
      this.emit(owner, node?.id ?? null, 'state-diff', 'component-state', null, { field, before: before[field] ?? null, after });
    }
  }
  private observationPhase(item: unknown): number {
    const type = record(item) && record(item.owner) ? this.components.get(String(item.owner.scriptId))?.type : '';
    return type === 'haiyue.gameplay.timers' ? 0 : type === 'haiyue.gameplay.rules' ? 1 : 2;
  }
  private redactedState(): void {
    const entityId = this.plan.entityIds[0];
    if (entityId) this.emit({ entityId, componentId: null, scriptId: null }, null, 'error', 'observation-rejected', null, null, 'behavior.state-redacted-or-bounded');
  }
  private emit(owner: Owner, nodeId: string | null, kind: TraceEvent['kind'], event: string | null = null, durationMicros: number | null = null, stateDiff: TraceEvent['stateDiff'] = null, error: string | null = null): void {
    if (this.closed) return;
    if (this.reasons.size) { this.sequence++; this.omitted++; return; }
    const row = { sequence: this.sequence++, ...owner, nodeId, kind, event, tick: this.tick, frame: this.frame, durationMicros, stateDiff, error };
    const bytes = utf8Bytes(canonicalJson(row));
    if (this.events.length >= 10000) this.reasons.add('events');
    if (this.bytes + bytes > 4 * 1024 * 1024 - 8192) this.reasons.add('bytes');
    if (this.reasons.size) { this.omitted++; return; }
    this.bytes += bytes; this.events.push(freezeProjection(row));
  }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value); }
function digest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && Number(value) >= min; }
function uniqueIds(value: unknown, max: number): value is string[] { return Array.isArray(value) && value.length <= max && value.every(id) && new Set(value).size === value.length; }
function uniqueStrings(value: unknown, max: number): value is string[] { return Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length <= 256) && new Set(value).size === value.length; }
