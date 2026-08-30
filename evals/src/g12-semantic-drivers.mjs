import { deepFreeze } from './canonical.mjs';
import { G12_SEMANTIC_REPLAY_ACTIONS, G12ReplayProgramError } from './g12-replay-program.mjs';

const POINTER_ID = 12;

/**
 * Reviewed, bounded black-box input drivers for the hidden G12 replay suite.
 * Published replay targets may guide coordinates, but never count as outcome
 * evidence; completion still requires an independently observed state/event.
 */
export function createG12SemanticDriverRegistry() {
  const definitions = [
    driver('scripted-swap', 16, swap),
    driver('scripted-repeat-valid-swaps', 90, repeatValidSwaps),
    driver('scripted-place-pieces', 720, placePieces),
    driver('scripted-drag-piece', 20, dragPiece),
    driver('scripted-complete-jigsaw', 360, completeJigsaw),
    driver('scripted-steer', 240, steer),
    driver('scripted-complete-level', 1_800, completeLevel),
    driver('scripted-follow-centerline', 600, followCenterline),
    driver('scripted-complete-lap', 1_800, completeLap),
    driver('scripted-aim-and-fire', 180, aimAndFire),
    driver('scripted-fire-at-covered-enemy', 90, fireAtCoveredEnemy),
    driver('scripted-resolve-combat', 1_200, resolveCombat),
  ];
  const registry = Object.freeze(Object.fromEntries(definitions.map((entry) => [entry.id, entry])));
  const actual = Object.keys(registry).sort();
  const expected = [...G12_SEMANTIC_REPLAY_ACTIONS].sort();
  if (actual.join('|') !== expected.join('|')) throw new G12ReplayProgramError('g12.semantic-driver-registry-invalid', 'Reviewed semantic driver registry does not exactly cover the suite actions.', { actual, expected });
  return registry;
}

export const G12_SEMANTIC_DRIVER_IDS = deepFreeze(Object.keys(createG12SemanticDriverRegistry()).sort());

export async function executeG12SemanticDriver(registry, driverId, control, parameters = {}, options = {}) {
  const definition = registry?.[driverId];
  if (!definition || typeof definition.run !== 'function') throw new G12ReplayProgramError('g12.semantic-driver-missing', `Semantic driver ${driverId} is not registered.`);
  const session = new DriverSession(control, definition.maxTicks, options.signal, options.onObservation);
  const before = await session.inspect();
  await definition.run(session, deepCloneRecord(parameters));
  const after = await session.inspect();
  return deepFreeze({ driverId, maxTicks: definition.maxTicks, ticksConsumed: after.tick - before.tick, beforeTick: before.tick, afterTick: after.tick, inputs: session.inputs, observations: session.observations });
}

function driver(id, maxTicks, run) { return Object.freeze({ id, version: '1.0.0', maxTicks, run }); }

class DriverSession {
  constructor(control, maxTicks, signal, onObservation) {
    if (!control || typeof control.input !== 'function' || typeof control.step !== 'function' || typeof control.inspect !== 'function') throw new G12ReplayProgramError('g12.semantic-driver-control-invalid', 'Semantic drivers require input, step and inspect preview control methods.');
    this.control = control;
    this.maxTicks = maxTicks;
    this.signal = signal;
    this.onObservation = typeof onObservation === 'function' ? onObservation : null;
    this.startTick = null;
    this.inputs = 0;
    this.observations = 0;
  }

  async inspect() {
    const value = await this.control.inspect(this.signal);
    this.observations += 1;
    this.onObservation?.(value);
    if (!Number.isSafeInteger(value?.tick) || value.tick < 0) throw new G12ReplayProgramError('g12.semantic-driver-observation-invalid', 'Preview inspection has no valid fixed tick.');
    if (this.startTick === null) this.startTick = value.tick;
    return value;
  }

  async step(count) {
    if (!Number.isSafeInteger(count) || count < 1) throw new G12ReplayProgramError('g12.semantic-driver-step-invalid', 'Driver step count must be a positive integer.');
    const current = await this.inspect();
    if (current.tick + count - this.startTick > this.maxTicks) throw new G12ReplayProgramError('g12.semantic-driver-budget-exceeded', `Semantic driver exceeded its ${this.maxTicks} tick budget.`);
    const value = await this.control.step(count, this.signal);
    this.observations += 1;
    this.onObservation?.(value);
    return value;
  }

  async action(control, durationTicks = 1) {
    const current = await this.inspect();
    const tick = current.tick + 1;
    await this.inject({ tick, kind: 'action', action: control, phase: 'down', source: 'synthetic' });
    await this.inject({ tick: tick + durationTicks, kind: 'action', action: control, phase: 'up', source: 'synthetic' });
    return this.step(durationTicks + 1);
  }

  async chord(controls, durationTicks) {
    const current = await this.inspect();
    const tick = current.tick + 1;
    for (const control of controls) await this.inject({ tick, kind: 'action', action: control, phase: 'down', source: 'synthetic' });
    for (const control of [...controls].reverse()) await this.inject({ tick: tick + durationTicks, kind: 'action', action: control, phase: 'up', source: 'synthetic' });
    return this.step(durationTicks + 1);
  }

  async drag(from, to, durationTicks = 2) {
    const current = await this.inspect();
    const tick = current.tick + 1;
    await this.inject(pointer(tick, 'move', from));
    await this.inject(pointer(tick + 1, 'down', from, 0));
    await this.inject(pointer(tick + durationTicks, 'move', to));
    await this.inject(pointer(tick + durationTicks + 1, 'up', to, 0));
    return this.step(durationTicks + 2);
  }

  async click(point) {
    const current = await this.inspect();
    const tick = current.tick + 1;
    await this.inject(pointer(tick, 'move', point));
    await this.inject(pointer(tick + 1, 'down', point, 0));
    await this.inject(pointer(tick + 2, 'up', point, 0));
    return this.step(3);
  }

  async target(criteria, fallback) {
    const observation = await this.inspect();
    return findTarget(observation, criteria) ?? fallback;
  }

  async inject(event) { const observation = await this.control.input(event, this.signal); this.inputs += 1; this.onObservation?.(observation); }
}

async function swap(session, parameters) {
  const kind = string(parameters.kind) ?? 'creates-match';
  const from = await session.target({ role: 'from', kind }, kind === 'non-matching-adjacent' ? point(0.28, 0.28) : point(0.42, 0.42));
  const to = await session.target({ role: 'to', kind }, kind === 'non-matching-adjacent' ? point(0.36, 0.28) : point(0.50, 0.42));
  await session.drag(from, to, 3);
  await session.step(8);
}

async function repeatValidSwaps(session, parameters) {
  const count = integer(parameters.count, 1, 12, 5);
  for (let index = 0; index < count; index += 1) {
    const row = index % 4, column = (index * 3) % 5;
    const from = await session.target({ role: 'from', kind: 'creates-match', index }, point(0.30 + column * 0.08, 0.30 + row * 0.09));
    const to = await session.target({ role: 'to', kind: 'creates-match', index }, point(from.x + 0.08, from.y));
    await session.drag(from, to, 3);
    await session.step(8);
  }
}

async function placePieces(session) {
  const placements = [
    ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'], ['ArrowLeft'], ['ArrowRight'],
    ['ArrowUp', 'ArrowLeft'], ['ArrowUp', 'ArrowRight'], [], ['ArrowUp'],
  ];
  for (let index = 0; index < 24; index += 1) {
    for (const control of placements[index % placements.length]) await session.action(control, 1);
    await session.action('Space', 1);
    await session.step(3);
  }
}

async function dragPiece(session, parameters) {
  const destination = string(parameters.destination) ?? 'near-correct-slot';
  const from = await session.target({ role: 'piece', destination }, point(0.22, destination === 'wrong-slot' ? 0.72 : 0.62));
  const fallback = destination === 'wrong-slot' ? point(0.78, 0.78) : point(0.55, 0.40);
  const to = await session.target({ role: 'destination', destination }, fallback);
  await session.drag(from, to, 4);
  await session.step(4);
}

async function completeJigsaw(session) {
  for (let index = 0; index < 12; index += 1) {
    const column = index % 4, row = Math.floor(index / 4);
    const from = await session.target({ role: 'piece', index }, point(0.12 + column * 0.11, 0.70 + row * 0.08));
    const to = await session.target({ role: 'destination', index }, point(0.43 + column * 0.09, 0.28 + row * 0.12));
    await session.drag(from, to, 4);
    await session.step(3);
  }
}

async function steer(session, parameters) {
  const goal = string(parameters.goal) ?? 'touch-barrier-once';
  if (goal === 'touch-hazard-once') await session.chord(['ArrowRight'], 150);
  else await session.chord(['ArrowUp', 'ArrowLeft'], 180);
}

async function completeLevel(session) {
  for (let index = 0; index < 8; index += 1) {
    await session.chord(['ArrowRight'], 120);
    await session.chord(['ArrowRight', 'Space'], 18);
  }
}

async function followCenterline(session, parameters) {
  const duration = integer(parameters.durationTicks, 30, 500, 300);
  let remaining = duration;
  let left = true;
  while (remaining > 0) {
    const slice = Math.min(45, remaining);
    await session.chord(['ArrowUp', left ? 'ArrowLeft' : 'ArrowRight'], slice);
    remaining -= slice;
    left = !left;
  }
}

async function completeLap(session) {
  for (let index = 0; index < 12; index += 1) await session.chord(['ArrowUp', index % 3 === 0 ? 'ArrowLeft' : 'ArrowRight'], 120);
}

async function aimAndFire(session, parameters) {
  const shots = integer(parameters.shots, 1, 32, 8);
  for (let index = 0; index < shots; index += 1) {
    const fallback = point(0.2 + (index % 3) * 0.3, 0.25 + (Math.floor(index / 3) % 3) * 0.25);
    await session.click(await session.target({ role: 'enemy', index, visibility: 'visible' }, fallback));
    await session.step(2);
  }
}

async function fireAtCoveredEnemy(session, parameters) {
  const shots = integer(parameters.shots, 1, 12, 3);
  for (let index = 0; index < shots; index += 1) {
    await session.click(await session.target({ role: 'enemy', index, visibility: 'covered' }, point(0.75, 0.35)));
    await session.step(2);
  }
}

async function resolveCombat(session) {
  for (let wave = 0; wave < 10; wave += 1) {
    await session.chord([wave % 2 === 0 ? 'KeyW' : 'KeyS', wave % 3 === 0 ? 'KeyA' : 'KeyD'], 24);
    await aimAndFire(session, { shots: 6 });
  }
}

function findTarget(observation, criteria) {
  const records = Array.isArray(observation?.value?.gameplay) ? observation.value.gameplay : [];
  for (const record of records) {
    const value = record?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const collection of [value.replayTargets, value.interactionTargets]) {
      if (!Array.isArray(collection)) continue;
      for (const target of collection) {
        if (!target || typeof target !== 'object' || Array.isArray(target)) continue;
        if (Object.entries(criteria).some(([key, expected]) => target[key] !== expected)) continue;
        const candidate = normalizedPoint(target);
        if (candidate) return candidate;
      }
    }
  }
  return null;
}

function pointer(tick, phase, value, button) { return { tick, kind: 'pointer', phase, source: 'synthetic', pointerId: POINTER_ID, x: value.x, y: value.y, ...(button === undefined ? {} : { button }) }; }
function point(x, y) { return Object.freeze({ x, y }); }
function normalizedPoint(value) { return Number.isFinite(value?.x) && value.x >= 0 && value.x <= 1 && Number.isFinite(value?.y) && value.y >= 0 && value.y <= 1 ? point(value.x, value.y) : null; }
function string(value) { return typeof value === 'string' && value ? value : null; }
function integer(value, minimum, maximum, fallback) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback; }
function deepCloneRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : {}; }
