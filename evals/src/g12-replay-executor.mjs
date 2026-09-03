import { deepFreeze } from './canonical.mjs';
import { assertG12SemanticDriverCoverage, G12ReplayProgramError } from './g12-replay-program.mjs';
import { createG12SemanticDriverRegistry, executeG12SemanticDriver } from './g12-semantic-drivers.mjs';

/** Execute a compiled hidden replay against a paused real GamePreviewControl. */
export async function executeG12ReplayProgram(control, program, options = {}) {
  validateControl(control);
  validateProgram(program);
  const registry = options.drivers ?? createG12SemanticDriverRegistry();
  assertG12SemanticDriverCoverage([program], Object.keys(registry));
  const tracker = new GameplaySignalTracker();
  const signal = options.signal;
  const resolveControl = typeof options.resolveControl === 'function' ? options.resolveControl : (value) => value;
  const maxTriggerWaitTicks = integer(options.maxTriggerWaitTicks, 1, 100_000, 3_600);
  const initial = await observe(control.inspect(signal), tracker);
  if (initial.tick !== program.baseTick) throw new G12ReplayProgramError('g12.replay-base-tick-stale', `Compiled replay base tick ${program.baseTick} does not match paused preview tick ${initial.tick}.`);
  const trace = [];

  const tickInputs = program.commands.filter((entry) => entry.kind === 'input' && entry.schedule.kind === 'tick').sort(compareTickCommand);
  for (const command of tickInputs) {
    if (command.schedule.tick <= initial.tick) throw new G12ReplayProgramError('g12.replay-input-in-past', `Input ${command.id} is not after the paused start tick.`);
    const observation = await control.input(inputEvent(command, command.schedule.tick, resolveControl), signal);
    tracker.observe(observation);
    trace.push(event('input-queued', command, observation.tick));
  }

  const fixedDrivers = program.commands.filter((entry) => entry.kind === 'semantic-driver' && entry.schedule.kind === 'tick').sort(compareTickCommand);
  for (const command of fixedDrivers) {
    await advanceTo(control, command.schedule.tick, tracker, signal);
    const result = await executeG12SemanticDriver(registry, command.driverId, control, command.parameters, { signal, resolveControl, onObservation: (value) => tracker.observe(value) });
    trace.push(event('semantic-driver', command, result.afterTick, { result }));
  }

  const triggerGroups = groupTriggerCommands(program.commands);
  for (const group of triggerGroups) {
    const trigger = group.trigger;
    const triggerTick = await awaitG12GameplayTrigger(control, trigger, tracker, { signal, maxWaitTicks: maxTriggerWaitTicks });
    const semantic = group.commands.find((entry) => entry.kind === 'semantic-driver');
    if (semantic) {
      const result = await executeG12SemanticDriver(registry, semantic.driverId, control, semantic.parameters, { signal, resolveControl, onObservation: (value) => tracker.observe(value) });
      trace.push(event('semantic-driver', semantic, result.afterTick, { trigger, triggerTick, result }));
      continue;
    }
    let lastTick = triggerTick;
    for (const command of group.commands) {
      const offset = command.schedule.kind === 'trigger-offset' ? command.schedule.offsetTicks : 0;
      const tick = Math.max(tracker.latestTick + 1, triggerTick + 1 + offset);
      const observation = await control.input(inputEvent(command, tick, resolveControl), signal);
      tracker.observe(observation);
      lastTick = Math.max(lastTick, tick);
      trace.push(event('trigger-input-queued', command, observation.tick, { trigger, triggerTick, scheduledTick: tick }));
    }
    await advanceTo(control, lastTick, tracker, signal);
  }

  const finalObservation = await observe(control.inspect(signal), tracker);
  if (tracker.gameplayRecordCount < 1) throw new G12ReplayProgramError('g12.gameplay-observation-missing', 'Replay completed without authoritative gameplay observations.');
  const capture = options.capture === true ? await control.capture(signal) : null;
  if (capture && capture.tick !== finalObservation.tick) throw new G12ReplayProgramError('g12.replay-capture-tick-mismatch', 'Replay screenshot and final state were not captured at the same fixed tick.');
  return deepFreeze({ schemaVersion: 1, replayProgramVersion: '1.0.0', baseTick: program.baseTick, finalTick: finalObservation.tick, semanticDriverIds: [...new Set(trace.filter((entry) => entry.kind === 'semantic-driver').map((entry) => entry.driverId))].sort(), observedSignals: tracker.signals(), observations: tracker.observations(), trace, finalObservation, capture });
}

export async function awaitG12GameplayTrigger(control, trigger, tracker = new GameplaySignalTracker(), options = {}) {
  if (typeof trigger !== 'string' || !trigger) throw new G12ReplayProgramError('g12.replay-trigger-invalid', 'Replay trigger must be a non-empty string.');
  const maxWaitTicks = integer(options.maxWaitTicks, 1, 100_000, 3_600);
  const initial = await observe(control.inspect(options.signal), tracker);
  const already = tracker.tickFor(trigger);
  if (already !== null) return already;
  const deadline = initial.tick + maxWaitTicks;
  while (tracker.latestTick < deadline) {
    await observe(control.step(1, options.signal), tracker);
    const matched = tracker.tickFor(trigger);
    if (matched !== null) return matched;
  }
  throw new G12ReplayProgramError('g12.replay-trigger-timeout', `Gameplay trigger ${trigger} was not observed within ${maxWaitTicks} ticks.`, { trigger, maxWaitTicks, observedSignals: tracker.signals() });
}

export class GameplaySignalTracker {
  constructor() { this.seen = new Map(); this.latestTick = -1; this.gameplayRecordCount = 0; this.history = []; }

  observe(observation) {
    if (!Number.isSafeInteger(observation?.tick) || observation.tick < 0) throw new G12ReplayProgramError('g12.replay-observation-invalid', 'Replay observation has no valid fixed tick.');
    this.latestTick = Math.max(this.latestTick, observation.tick);
    const runtimeErrors = observation?.value?.runtimeErrorCount;
    if (Number.isFinite(runtimeErrors) && runtimeErrors > 0) throw new G12ReplayProgramError('g12.replay-runtime-error', `Play reported ${runtimeErrors} runtime error(s).`);
    const records = Array.isArray(observation?.value?.gameplay) ? observation.value.gameplay : [];
    this.gameplayRecordCount = Math.max(this.gameplayRecordCount, records.length);
    this.history.push(snapshotObservation(observation));
    for (const record of records) for (const value of signals(record?.value)) this.add(value, observation.tick);
    return observation;
  }

  add(value, tick) {
    const normalized = normalizeSignal(value);
    if (!normalized) return;
    if (!this.seen.has(normalized)) this.seen.set(normalized, tick);
    for (const alias of aliases(normalized)) if (!this.seen.has(alias)) this.seen.set(alias, tick);
  }

  tickFor(value) { return this.seen.get(normalizeSignal(value)) ?? null; }
  signals() { return [...this.seen.keys()].sort(); }
  observations() { return this.history.slice(); }
}

async function advanceTo(control, targetTick, tracker, signal) {
  if (!Number.isSafeInteger(targetTick) || targetTick < 0) throw new G12ReplayProgramError('g12.replay-target-tick-invalid', 'Replay target tick is invalid.');
  while (tracker.latestTick < targetTick) await observe(control.step(1, signal), tracker);
}

async function observe(promise, tracker) { return tracker.observe(await promise); }

function groupTriggerCommands(commands) {
  const groups = new Map();
  for (const command of commands) {
    if (command.schedule.kind !== 'trigger' && command.schedule.kind !== 'trigger-offset') continue;
    const trigger = command.schedule.trigger;
    const key = `${command.ordinal}:${command.sourceStepId}`;
    const group = groups.get(key) ?? { ordinal: command.ordinal, trigger, commands: [] };
    if (group.trigger !== trigger) throw new G12ReplayProgramError('g12.replay-trigger-group-invalid', `Replay step ${command.sourceStepId} mixes trigger names.`);
    group.commands.push(command);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.ordinal - right.ordinal).map((entry) => ({ ...entry, commands: entry.commands.sort((left, right) => triggerOffset(left) - triggerOffset(right)) }));
}

function signals(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const result = [];
  for (const key of ['event', 'status', 'state', 'phase']) if (typeof value[key] === 'string') result.push(value[key]);
  for (const key of ['events', 'triggers']) if (Array.isArray(value[key])) result.push(...value[key].filter((entry) => typeof entry === 'string'));
  if (value.flags && typeof value.flags === 'object' && !Array.isArray(value.flags)) for (const [key, enabled] of Object.entries(value.flags)) if (enabled === true) result.push(key);
  return result;
}

function aliases(value) {
  if (['gameover', 'game-over', 'failed', 'failure', 'defeat', 'lost'].includes(value)) return ['game-over', 'terminal-state'];
  if (['complete', 'completed', 'victory', 'won', 'win'].includes(value)) return ['complete', 'terminal-state'];
  const groups = [
    [['respawned', 'player-respawned'], ['respawn']],
    [['invalid-swap', 'swap-rejected', 'invalid-move', 'swap-reverted', 'invalid-swap-restored'], ['invalid-swap-settled']],
    [['board-stable', 'settled', 'cascade-complete', 'gravity-complete', 'refill-complete', 'board-refilled'], ['board-settled']],
    [['piece-lock', 'piece-locked', 'locked-piece'], ['piece-locked']],
    [['wrong-drop', 'invalid-drop', 'drop-rejected', 'wrong-release'], ['wrong-drop']],
    [['correct-snap', 'piece-snapped', 'piece-locked', 'first-piece-locked'], ['first-piece-locked']],
    [['collision-recovered', 'offtrack-recovered', 'vehicle-recovered', 'recovered'], ['collision-recovered']],
    [['first-kill', 'enemy-killed', 'enemy-defeated', 'kill'], ['first-kill']],
    [['cover-test', 'cover-tested', 'blocked-shot', 'shot-blocked'], ['cover-test']],
  ];
  return groups.filter(([members]) => members.includes(value)).flatMap(([, results]) => results);
}

function normalizeSignal(value) { return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_]+/gu, '-').replace(/[^a-z0-9.:-]/gu, '') : ''; }
function snapshotObservation(observation) {
  return JSON.parse(JSON.stringify({
    tick: observation.tick,
    value: {
      timeMs: observation.value?.timeMs ?? null,
      gameplay: Array.isArray(observation.value?.gameplay) ? observation.value.gameplay : [],
      hud: observation.value?.hud ?? {},
      runtimeErrorCount: observation.value?.runtimeErrorCount ?? 0,
    },
  }));
}
function inputEvent(command, tick = command.schedule.tick, resolveControl = (value) => value) { return { tick, kind: 'action', action: resolveControl(command.control), phase: command.phase, source: 'synthetic' }; }
function compareTickCommand(left, right) { return left.schedule.tick - right.schedule.tick || left.ordinal - right.ordinal || left.id.localeCompare(right.id); }
function triggerOffset(command) { return command.schedule.kind === 'trigger-offset' ? command.schedule.offsetTicks : 0; }
function event(kind, command, tick, details = {}) { return { kind, commandId: command.id, sourceStepId: command.sourceStepId, ...(command.driverId ? { driverId: command.driverId } : {}), tick, ...details }; }
function integer(value, minimum, maximum, fallback) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback; }

function validateControl(value) {
  if (!value || ['input', 'step', 'inspect'].some((key) => typeof value[key] !== 'function')) throw new G12ReplayProgramError('g12.replay-control-invalid', 'Replay execution requires input, step and inspect preview control methods.');
}

function validateProgram(value) {
  if (!value || value.schemaVersion !== 1 || value.clock !== 'fixed-tick-relative-to-paused-start' || !Number.isSafeInteger(value.baseTick) || !Array.isArray(value.commands)) throw new G12ReplayProgramError('g12.replay-program-invalid', 'Compiled replay program is invalid.');
}
