import type { GameplayObservationValue } from './gameplay-observation-store.js';

export interface DeclarativeSceneComponent {
  readonly id: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface DeclarativeSceneEntity {
  readonly id: string;
  readonly components?: readonly DeclarativeSceneComponent[];
}

export interface DeclarativeGameplayObservation {
  readonly owner: Readonly<{ scriptId: string; entityId: string }>;
  readonly id: string;
  readonly value: GameplayObservationValue;
}

export type DeclarativeHudPosition = 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
export interface DeclarativeHudItem {
  readonly owner: Readonly<{ componentId: string; entityId: string }>;
  readonly id: string;
  readonly kind: 'text' | 'image' | 'button';
  readonly text: string;
  readonly assetId: string;
  readonly action: string;
  readonly position: DeclarativeHudPosition;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly color: string;
  readonly backgroundColor: string;
  readonly fontSize: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
}

export interface DeclarativeAudioListener {
  readonly componentId: string;
  readonly entityId: string;
  readonly spatial: boolean;
  readonly masterGain: number;
  readonly dopplerFactor: number;
  readonly speedOfSound: number;
}

export interface DeclarativePlaySnapshot {
  readonly tick: number;
  readonly observations: readonly DeclarativeGameplayObservation[];
  readonly hud: readonly DeclarativeHudItem[];
  readonly pools: readonly DeclarativePoolSnapshot[];
  readonly audioListener: DeclarativeAudioListener | null;
}

export interface DeclarativePlaySignals {
  readonly pressedActions?: readonly string[];
  readonly heldActions?: readonly string[];
  readonly physicsEvents?: readonly Readonly<{ kind: 'collision' | 'trigger'; phase: 'enter' | 'stay' | 'exit'; entityAId: string; entityBId: string }>[];
}

export interface DeclarativePoolSnapshot {
  readonly componentId: string;
  readonly entityId: string;
  readonly observationId: string;
  readonly templateEntityId: string;
  readonly capacity: number;
  readonly activeCount: number;
  readonly spawns: readonly Readonly<{ position: Readonly<{ x: number; y: number; z: number }>; rotationDegrees: Readonly<{ x: number; y: number; z: number }>; scale: Readonly<{ x: number; y: number; z: number }>; color: readonly [number, number, number, number] }>[];
}

interface GameplayStateSource {
  readonly componentId: string;
  readonly entityId: string;
  readonly observationId: string;
  state: string;
  score: number;
  health: number;
  readonly maxHealth: number;
  checkpoint: string;
  readonly counters: Map<string, number>;
  readonly flags: Map<string, boolean>;
  readonly baseEvents: readonly Readonly<{ id: string; value: string }>[];
  emittedEvents: ReadonlyArray<Readonly<{ id: string; value: string }>>;
}

interface GameplayTimersSource {
  readonly componentId: string;
  readonly entityId: string;
  readonly observationId: string;
  readonly timers: readonly Readonly<{ id: string; durationTicks: number; startDelayTicks: number; repeat: boolean; running: boolean; event: string }>[];
}

interface GameplayRuleSource {
  readonly componentId: string;
  readonly entityId: string;
  readonly rules: readonly GameplayRule[];
}
interface GameplayRule {
  readonly id: string;
  readonly once: boolean;
  readonly when: Readonly<{ source: 'input-pressed' | 'input-held' | 'timer-event' | 'collision' | 'trigger'; value: string; entityAId: string; entityBId: string; phase: 'enter' | 'stay' | 'exit' }>;
  readonly actions: readonly GameplayAction[];
}
interface GameplayAction { readonly kind: 'set-state' | 'add-score' | 'set-health' | 'add-health' | 'set-checkpoint' | 'set-counter' | 'add-counter' | 'set-flag' | 'emit-event' | 'set-pool-count'; readonly targetObservationId: string; readonly key: string; readonly numberValue: number; readonly textValue: string; readonly booleanValue: boolean; }
interface GameplayPoolSource extends DeclarativePoolSnapshot { activeCount: number; }

const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u;
const HUD_POSITIONS = new Set<DeclarativeHudPosition>(['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right']);
const COLORS = /^#[0-9a-f]{3,8}$/iu;
const MAX_STATE_COMPONENTS = 32;
const MAX_TIMER_COMPONENTS = 32;
const MAX_RULE_COMPONENTS = 16;
const MAX_POOL_COMPONENTS = 32;
const MAX_HUD_ITEMS = 32;

/** Deterministic, DOM-free projection for registry-validated declarative Play components. */
export class DeclarativePlayRuntime {
  private readonly states: readonly GameplayStateSource[];
  private readonly timers: readonly GameplayTimersSource[];
  private readonly rules: readonly GameplayRuleSource[];
  private readonly pools: readonly GameplayPoolSource[];
  private readonly hudItems: readonly DeclarativeHudItem[];
  private readonly listener: DeclarativeAudioListener | null;
  private readonly firedOnceRules = new Set<string>();
  private lastAdvancedTick = -1;
  private firedRules: readonly Readonly<{ componentId: string; ruleId: string }>[] = Object.freeze([]);

  constructor(entities: readonly DeclarativeSceneEntity[]) {
    const states: GameplayStateSource[] = [];
    const timers: GameplayTimersSource[] = [];
    const rules: GameplayRuleSource[] = [];
    const pools: GameplayPoolSource[] = [];
    const hudItems: DeclarativeHudItem[] = [];
    const listeners: DeclarativeAudioListener[] = [];
    const hudIds = new Set<string>();
    for (const entity of [...entities].sort((left, right) => left.id.localeCompare(right.id))) {
      for (const component of [...(entity.components ?? [])].filter((item) => item.enabled).sort((left, right) => left.id.localeCompare(right.id))) {
        if (component.type === 'haiyue.gameplay.state') states.push(readState(entity.id, component));
        else if (component.type === 'haiyue.gameplay.timers') timers.push(readTimers(entity.id, component));
        else if (component.type === 'haiyue.gameplay.rules') rules.push(readRules(entity.id, component));
        else if (component.type === 'haiyue.gameplay.pool') pools.push(readPool(entity.id, component));
        else if (component.type === 'haiyue.ui.hud') {
          for (const item of readHud(entity.id, component)) {
            if (hudIds.has(item.id)) throw new Error(`declarative.hud-id-duplicate: ${item.id}.`);
            hudIds.add(item.id); hudItems.push(item);
          }
        } else if (component.type === 'haiyue.audio.listener' && component.value.active === true) listeners.push(readListener(entity.id, component));
      }
    }
    if (states.length > MAX_STATE_COMPONENTS) throw new Error(`declarative.gameplay-state-limit: at most ${MAX_STATE_COMPONENTS} enabled state components are allowed.`);
    if (timers.length > MAX_TIMER_COMPONENTS) throw new Error(`declarative.gameplay-timer-limit: at most ${MAX_TIMER_COMPONENTS} enabled timer components are allowed.`);
    if (rules.length > MAX_RULE_COMPONENTS) throw new Error(`declarative.gameplay-rule-limit: at most ${MAX_RULE_COMPONENTS} enabled rule components are allowed.`);
    if (pools.length > MAX_POOL_COMPONENTS) throw new Error(`declarative.gameplay-pool-limit: at most ${MAX_POOL_COMPONENTS} enabled pool components are allowed.`);
    if (new Set(states.map((item) => item.observationId)).size !== states.length) throw new Error('declarative.gameplay-state-id-duplicate: observation ids must be unique.');
    if (new Set(pools.map((item) => item.observationId)).size !== pools.length) throw new Error('declarative.gameplay-pool-id-duplicate: observation ids must be unique.');
    if (hudItems.length > MAX_HUD_ITEMS) throw new Error(`declarative.hud-item-limit: at most ${MAX_HUD_ITEMS} HUD items are allowed.`);
    if (listeners.length > 1) throw new Error('declarative.audio-listener-conflict: only one active audio listener is allowed.');
    this.states = Object.freeze(states);
    this.timers = Object.freeze(timers);
    this.rules = Object.freeze(rules);
    this.pools = Object.freeze(pools);
    this.hudItems = Object.freeze(hudItems);
    this.listener = listeners[0] ?? null;
  }

  snapshot(tick: number): DeclarativePlaySnapshot {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('Declarative Play tick must be a non-negative integer.');
    const observations: DeclarativeGameplayObservation[] = [];
    for (const source of this.states) observations.push(observation(source.componentId, source.entityId, source.observationId, stateValue(source)));
    for (const source of this.timers) observations.push(observation(source.componentId, source.entityId, source.observationId, timerValue(source, tick)));
    for (const source of this.pools) observations.push(observation(source.componentId, source.entityId, source.observationId, { templateEntityId: source.templateEntityId, capacity: source.capacity, activeCount: source.activeCount }));
    for (const source of this.rules) observations.push(observation(source.componentId, source.entityId, 'rules', { tick, firedRules: this.firedRules.filter((entry) => entry.componentId === source.componentId).map((entry) => entry.ruleId) }));
    if (this.listener) observations.push(observation(this.listener.componentId, this.listener.entityId, 'audio-listener', {
      active: true, spatial: this.listener.spatial, masterGain: this.listener.masterGain, dopplerFactor: this.listener.dopplerFactor, speedOfSound: this.listener.speedOfSound,
    }));
    const variables = this.states[0] ? templateValues(this.states[0]) : Object.freeze({});
    const hud = this.hudItems.map((item) => Object.freeze({ ...item, text: interpolate(item.text, variables) }));
    const pools = this.pools.map((pool) => freezePool(pool));
    return Object.freeze({ tick, observations: Object.freeze(observations), hud: Object.freeze(hud), pools: Object.freeze(pools), audioListener: this.listener });
  }

  inputActions(): readonly string[] {
    return Object.freeze([...new Set(this.rules.flatMap((source) => source.rules.flatMap((rule) => rule.when.source === 'input-pressed' || rule.when.source === 'input-held' ? [rule.when.value] : [])))].sort());
  }

  advance(tick: number, signals: DeclarativePlaySignals = {}): DeclarativePlaySnapshot {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('Declarative Play tick must be a non-negative integer.');
    if (tick <= this.lastAdvancedTick) throw new Error(`declarative.tick-order-invalid: ${tick} must be greater than ${this.lastAdvancedTick}.`);
    this.lastAdvancedTick = tick;
    for (const state of this.states) state.emittedEvents = Object.freeze([]);
    const timerEvents = this.timers.flatMap((source) => {
      const value = timerValue(source, tick);
      return isRecord(value) && Array.isArray(value.firedEvents) ? value.firedEvents.filter((item): item is string => typeof item === 'string') : [];
    });
    const fired: Array<Readonly<{ componentId: string; ruleId: string }>> = [];
    for (const source of this.rules) for (const rule of source.rules) {
      const key = `${source.componentId}\u0000${rule.id}`;
      if (rule.once && this.firedOnceRules.has(key)) continue;
      if (!matchesRule(rule, signals, timerEvents)) continue;
      for (const action of rule.actions) this.applyAction(action);
      if (rule.once) this.firedOnceRules.add(key);
      fired.push(Object.freeze({ componentId: source.componentId, ruleId: rule.id }));
    }
    this.firedRules = Object.freeze(fired);
    return this.snapshot(tick);
  }

  private applyAction(action: GameplayAction): void {
    if (action.kind === 'set-pool-count') {
      const pool = this.pools.find((candidate) => candidate.observationId === action.targetObservationId);
      if (!pool) throw new Error(`declarative.rule-target-missing: pool ${action.targetObservationId}.`);
      const count = Math.trunc(action.numberValue);
      if (count < 0 || count > pool.capacity || count > pool.spawns.length) throw new Error(`declarative.pool-count-invalid: ${count}.`);
      pool.activeCount = count; return;
    }
    const state = this.states.find((candidate) => candidate.observationId === action.targetObservationId);
    if (!state) throw new Error(`declarative.rule-target-missing: state ${action.targetObservationId}.`);
    if (action.kind === 'set-state') state.state = requiredId(action.textValue, 'state action');
    else if (action.kind === 'add-score') state.score = boundedGameplayNumber(state.score + action.numberValue, 'score');
    else if (action.kind === 'set-health') state.health = boundedGameplayNumber(action.numberValue, 'health');
    else if (action.kind === 'add-health') state.health = boundedGameplayNumber(state.health + action.numberValue, 'health');
    else if (action.kind === 'set-checkpoint') state.checkpoint = boundedString(action.textValue, 256, 'checkpoint');
    else if (action.kind === 'set-counter') state.counters.set(requiredId(action.key, 'counter action'), action.numberValue);
    else if (action.kind === 'add-counter') { const key = requiredId(action.key, 'counter action'); state.counters.set(key, boundedGameplayNumber((state.counters.get(key) ?? 0) + action.numberValue, 'counter')); }
    else if (action.kind === 'set-flag') state.flags.set(requiredId(action.key, 'flag action'), action.booleanValue);
    else if (action.kind === 'emit-event') state.emittedEvents = Object.freeze([...state.emittedEvents, Object.freeze({ id: requiredId(action.key, 'event action'), value: boundedString(action.textValue, 512, 'event value') })].slice(-64));
  }
}

function readState(entityId: string, component: DeclarativeSceneComponent): GameplayStateSource {
  const value = component.value;
  const observationId = requiredId(value.observationId, 'gameplay observation id', 63);
  const state = requiredId(value.state, 'gameplay state');
  const score = finite(value.score, -1_000_000_000, 1_000_000_000, 'score');
  const health = finite(value.health, -1_000_000_000, 1_000_000_000, 'health');
  const maxHealth = finite(value.maxHealth, 0, 1_000_000_000, 'maxHealth');
  const checkpoint = boundedString(value.checkpoint, 256, 'checkpoint');
  const counters = keyedNumberArray(value.counters, 'counter');
  const flags = keyedBooleanArray(value.flags, 'flag');
  const events = keyedStringArray(value.events, 'event', 512);
  return { componentId: component.id, entityId, observationId, state, score, health, maxHealth, checkpoint, counters: new Map(counters.map((item) => [item.id, item.value])), flags: new Map(flags.map((item) => [item.id, item.value])), baseEvents: events, emittedEvents: Object.freeze([]) };
}

function readTimers(entityId: string, component: DeclarativeSceneComponent): GameplayTimersSource {
  const observationId = requiredId(component.value.observationId, 'timer observation id', 63);
  if (!Array.isArray(component.value.timers) || component.value.timers.length < 1 || component.value.timers.length > 32) throw new Error('declarative.timer-list-invalid: timers must contain 1-32 entries.');
  const ids = new Set<string>();
  const timers = component.value.timers.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('declarative.timer-invalid: timer must be an object.');
    const id = requiredId(candidate.id, 'timer id', 63);
    if (ids.has(id)) throw new Error(`declarative.timer-id-duplicate: ${id}.`); ids.add(id);
    return Object.freeze({ id, durationTicks: integer(candidate.durationTicks, 1, 10_000_000, 'durationTicks'), startDelayTicks: integer(candidate.startDelayTicks, 0, 10_000_000, 'startDelayTicks'), repeat: boolean(candidate.repeat, 'repeat'), running: boolean(candidate.running, 'running'), event: requiredId(candidate.event, 'timer event', 63) });
  });
  return Object.freeze({ componentId: component.id, entityId, observationId, timers: Object.freeze(timers) });
}

function readRules(entityId: string, component: DeclarativeSceneComponent): GameplayRuleSource {
  if (!Array.isArray(component.value.rules) || component.value.rules.length > 128) throw new Error('declarative.rule-list-invalid: rules must contain at most 128 entries.');
  const ids = new Set<string>();
  const rules = component.value.rules.map((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.when) || !Array.isArray(candidate.actions) || candidate.actions.length < 1 || candidate.actions.length > 16) throw new Error('declarative.rule-invalid: rule shape is invalid.');
    const id = requiredId(candidate.id, 'rule id', 63); if (ids.has(id)) throw new Error(`declarative.rule-id-duplicate: ${id}.`); ids.add(id);
    const source = candidate.when.source;
    if (source !== 'input-pressed' && source !== 'input-held' && source !== 'timer-event' && source !== 'collision' && source !== 'trigger') throw new Error('declarative.rule-source-invalid: rule trigger source is invalid.');
    const phase = candidate.when.phase; if (phase !== 'enter' && phase !== 'stay' && phase !== 'exit') throw new Error('declarative.rule-phase-invalid: rule phase is invalid.');
    const when = Object.freeze({ source, value: requiredId(candidate.when.value, 'rule trigger value'), entityAId: entityIdOrEmpty(candidate.when.entityAId, 'entityAId'), entityBId: entityIdOrEmpty(candidate.when.entityBId, 'entityBId'), phase });
    const actions = candidate.actions.map((value) => readAction(value));
    return Object.freeze({ id, once: boolean(candidate.once, 'rule once'), when, actions: Object.freeze(actions) });
  });
  return Object.freeze({ componentId: component.id, entityId, rules: Object.freeze(rules) });
}

function readAction(candidate: unknown): GameplayAction {
  if (!isRecord(candidate)) throw new Error('declarative.rule-action-invalid: action must be an object.');
  const kind = candidate.kind;
  if (!['set-state', 'add-score', 'set-health', 'add-health', 'set-checkpoint', 'set-counter', 'add-counter', 'set-flag', 'emit-event', 'set-pool-count'].includes(String(kind))) throw new Error('declarative.rule-action-kind-invalid: action kind is invalid.');
  return Object.freeze({ kind: kind as GameplayAction['kind'], targetObservationId: requiredId(candidate.targetObservationId, 'action target', 63), key: boundedString(candidate.key, 96, 'action key'), numberValue: finite(candidate.numberValue, -1_000_000_000, 1_000_000_000, 'action number'), textValue: boundedString(candidate.textValue, 512, 'action text'), booleanValue: boolean(candidate.booleanValue, 'action boolean') });
}

function readPool(entityId: string, component: DeclarativeSceneComponent): GameplayPoolSource {
  const observationId = requiredId(component.value.observationId, 'pool observation id', 63);
  const templateEntityId = entityIdOrEmpty(component.value.templateEntityId, 'templateEntityId');
  if (!templateEntityId) throw new Error('declarative.pool-template-invalid: templateEntityId is required.');
  const capacity = integer(component.value.capacity, 1, 4_096, 'pool capacity');
  const activeCount = integer(component.value.activeCount, 0, capacity, 'pool activeCount');
  if (!Array.isArray(component.value.spawns) || component.value.spawns.length < 1 || component.value.spawns.length > 128 || component.value.spawns.length > capacity) throw new Error('declarative.pool-spawns-invalid: spawns must fit capacity and contain 1-128 entries.');
  if (activeCount > component.value.spawns.length) throw new Error('declarative.pool-active-count-invalid: activeCount exceeds authored spawn transforms.');
  const spawns = component.value.spawns.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('declarative.pool-spawn-invalid: spawn must be an object.');
    const colorValue = candidate.color;
    if (!Array.isArray(colorValue) || colorValue.length !== 4) throw new Error('declarative.pool-color-invalid: color must contain four channels.');
    return Object.freeze({ position: readVec3(candidate.position, 'pool position'), rotationDegrees: readVec3(candidate.rotationDegrees, 'pool rotation'), scale: readPositiveVec3(candidate.scale, 'pool scale'), color: Object.freeze(colorValue.map((item, index) => finite(item, 0, 1, `pool color[${index}]`))) as unknown as readonly [number, number, number, number] });
  });
  return { componentId: component.id, entityId, observationId, templateEntityId, capacity, activeCount, spawns: Object.freeze(spawns) };
}

function readHud(entityId: string, component: DeclarativeSceneComponent): readonly DeclarativeHudItem[] {
  if (!Array.isArray(component.value.items) || component.value.items.length < 1 || component.value.items.length > 32) throw new Error('declarative.hud-list-invalid: items must contain 1-32 entries.');
  return Object.freeze(component.value.items.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('declarative.hud-item-invalid: HUD item must be an object.');
    const kind = candidate.kind;
    if (kind !== 'text' && kind !== 'image' && kind !== 'button') throw new Error('declarative.hud-kind-invalid: unsupported HUD item kind.');
    const position = candidate.position;
    if (typeof position !== 'string' || !HUD_POSITIONS.has(position as DeclarativeHudPosition)) throw new Error('declarative.hud-position-invalid: unsupported HUD position.');
    const assetId = boundedString(candidate.assetId, 126, 'assetId');
    if (assetId && !/^asset:[A-Za-z0-9._:-]{3,120}$/u.test(assetId)) throw new Error('declarative.hud-asset-invalid: image asset id is invalid.');
    const action = boundedString(candidate.action, 96, 'action');
    if (action && !ID.test(action)) throw new Error('declarative.hud-action-invalid: action id is invalid.');
    return Object.freeze({
      owner: Object.freeze({ componentId: component.id, entityId }), id: requiredId(candidate.id, 'HUD item id', 63), kind,
      text: boundedString(candidate.text, 512, 'text'), assetId, action, position: position as DeclarativeHudPosition,
      offsetX: finite(candidate.offsetX, -2_048, 2_048, 'offsetX'), offsetY: finite(candidate.offsetY, -2_048, 2_048, 'offsetY'),
      color: color(candidate.color, 'color'), backgroundColor: color(candidate.backgroundColor, 'backgroundColor'), fontSize: finite(candidate.fontSize, 8, 96, 'fontSize'),
      width: finite(candidate.width, 1, 2_048, 'width'), height: finite(candidate.height, 1, 2_048, 'height'), visible: boolean(candidate.visible, 'visible'),
    });
  }));
}

function readListener(entityId: string, component: DeclarativeSceneComponent): DeclarativeAudioListener {
  return Object.freeze({ componentId: component.id, entityId, spatial: boolean(component.value.spatial, 'spatial'), masterGain: finite(component.value.masterGain, 0, 1, 'masterGain'), dopplerFactor: finite(component.value.dopplerFactor, 0, 10, 'dopplerFactor'), speedOfSound: finite(component.value.speedOfSound, 1, 100_000, 'speedOfSound') });
}

function timerValue(source: GameplayTimersSource, tick: number): GameplayObservationValue {
  const firedEvents: string[] = [];
  const timers = source.timers.map((timer) => {
    if (!timer.running || tick <= timer.startDelayTicks) return Object.freeze({ id: timer.id, running: timer.running, repeat: timer.repeat, remainingTicks: timer.durationTicks, cycle: 0, completed: false, fired: false, event: timer.event });
    const elapsed = tick - timer.startDelayTicks;
    const cycle = Math.floor(elapsed / timer.durationTicks);
    const exactBoundary = elapsed % timer.durationTicks === 0;
    const completed = !timer.repeat && elapsed >= timer.durationTicks;
    const fired = exactBoundary && (timer.repeat || elapsed === timer.durationTicks);
    if (fired) firedEvents.push(timer.event);
    const remainingTicks = completed ? 0 : exactBoundary ? 0 : timer.durationTicks - (elapsed % timer.durationTicks);
    return Object.freeze({ id: timer.id, running: !completed, repeat: timer.repeat, remainingTicks, cycle, completed, fired, event: timer.event });
  });
  return Object.freeze({ tick, timers: Object.freeze(timers), firedEvents: Object.freeze(firedEvents) });
}

function stateValue(source: GameplayStateSource): GameplayObservationValue {
  return Object.freeze({
    state: source.state, score: source.score, health: source.health, maxHealth: source.maxHealth, checkpoint: source.checkpoint,
    counters: Object.freeze([...source.counters].sort((left, right) => left[0].localeCompare(right[0])).map(([id, value]) => Object.freeze({ id, value }))),
    flags: Object.freeze([...source.flags].sort((left, right) => left[0].localeCompare(right[0])).map(([id, value]) => Object.freeze({ id, value }))),
    events: Object.freeze([...source.baseEvents, ...source.emittedEvents]),
  });
}

function templateValues(source: GameplayStateSource): Readonly<Record<string, string>> {
  const values: Record<string, string> = { state: source.state, score: String(source.score), health: String(source.health), maxHealth: String(source.maxHealth), checkpoint: source.checkpoint };
  for (const [id, value] of source.counters) values[`counter:${id}`] = String(value);
  for (const [id, value] of source.flags) values[`flag:${id}`] = String(value);
  return Object.freeze(values);
}

function freezePool(source: GameplayPoolSource): DeclarativePoolSnapshot {
  return Object.freeze({ componentId: source.componentId, entityId: source.entityId, observationId: source.observationId, templateEntityId: source.templateEntityId, capacity: source.capacity, activeCount: source.activeCount, spawns: source.spawns });
}

function matchesRule(rule: GameplayRule, signals: DeclarativePlaySignals, timerEvents: readonly string[]): boolean {
  const trigger = rule.when;
  if (trigger.source === 'input-pressed') return (signals.pressedActions ?? []).includes(trigger.value);
  if (trigger.source === 'input-held') return (signals.heldActions ?? []).includes(trigger.value);
  if (trigger.source === 'timer-event') return timerEvents.includes(trigger.value);
  return (signals.physicsEvents ?? []).some((event) => event.kind === trigger.source && event.phase === trigger.phase
    && (!trigger.entityAId || event.entityAId === trigger.entityAId || event.entityBId === trigger.entityAId)
    && (!trigger.entityBId || event.entityAId === trigger.entityBId || event.entityBId === trigger.entityBId));
}

function boundedGameplayNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < -1_000_000_000 || value > 1_000_000_000) throw new Error(`declarative.${label}-overflow: gameplay values must stay bounded.`);
  return value;
}

function entityIdOrEmpty(value: unknown, label: string): string {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^entity:[A-Za-z0-9._:-]{3,120}$/u.test(value)) throw new Error(`declarative.${label}-invalid: expected a stable entity id or empty string.`);
  return value;
}

function readVec3(value: unknown, label: string): Readonly<{ x: number; y: number; z: number }> {
  if (!isRecord(value)) throw new Error(`declarative.${label}-invalid: expected a vector.`);
  return Object.freeze({ x: finite(value.x, -1e12, 1e12, `${label}.x`), y: finite(value.y, -1e12, 1e12, `${label}.y`), z: finite(value.z, -1e12, 1e12, `${label}.z`) });
}
function readPositiveVec3(value: unknown, label: string): Readonly<{ x: number; y: number; z: number }> {
  if (!isRecord(value)) throw new Error(`declarative.${label}-invalid: expected a vector.`);
  return Object.freeze({ x: finite(value.x, 0.000001, 1e12, `${label}.x`), y: finite(value.y, 0.000001, 1e12, `${label}.y`), z: finite(value.z, 0.000001, 1e12, `${label}.z`) });
}

function observation(componentId: string, entityId: string, id: string, value: GameplayObservationValue): DeclarativeGameplayObservation {
  return Object.freeze({ owner: Object.freeze({ scriptId: componentId, entityId }), id, value });
}

function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9._:-]{0,95})\}/gu, (match, key: string) => values[key] ?? match);
}

function keyedNumberArray(value: unknown, label: string): readonly Readonly<{ id: string; value: number }>[] {
  return keyedArray(value, label, (candidate) => finite(candidate.value, -1_000_000_000, 1_000_000_000, `${label} value`));
}
function keyedBooleanArray(value: unknown, label: string): readonly Readonly<{ id: string; value: boolean }>[] { return keyedArray(value, label, (candidate) => boolean(candidate.value, `${label} value`)); }
function keyedStringArray(value: unknown, label: string, maximum: number): readonly Readonly<{ id: string; value: string }>[] { return keyedArray(value, label, (candidate) => boundedString(candidate.value, maximum, `${label} value`)); }
function keyedArray<T>(value: unknown, label: string, convert: (candidate: Record<string, unknown>) => T): readonly Readonly<{ id: string; value: T }>[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`declarative.${label}-list-invalid: expected at most 64 entries.`);
  const ids = new Set<string>();
  return Object.freeze(value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`declarative.${label}-invalid: entry must be an object.`);
    const id = requiredId(candidate.id, `${label} id`, 63);
    if (ids.has(id)) throw new Error(`declarative.${label}-id-duplicate: ${id}.`); ids.add(id);
    return Object.freeze({ id, value: convert(candidate) });
  }));
}
function requiredId(value: unknown, label: string, maximum = 95): string { if (typeof value !== 'string' || value.length > maximum + 1 || !ID.test(value)) throw new Error(`declarative.${label.replaceAll(' ', '-')}-invalid: ${label} is invalid.`); return value; }
function boundedString(value: unknown, maximum: number, label: string): string { if (typeof value !== 'string' || value.length > maximum) throw new Error(`declarative.${label}-invalid: expected at most ${maximum} characters.`); return value; }
function finite(value: unknown, minimum: number, maximum: number, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`declarative.${label}-invalid: expected a finite number from ${minimum} to ${maximum}.`); return value; }
function integer(value: unknown, minimum: number, maximum: number, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`declarative.${label}-invalid: expected an integer from ${minimum} to ${maximum}.`); return Number(value); }
function boolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new Error(`declarative.${label}-invalid: expected a boolean.`); return value; }
function color(value: unknown, label: string): string { if (typeof value !== 'string' || !COLORS.test(value)) throw new Error(`declarative.${label}-invalid: expected a hexadecimal color.`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
