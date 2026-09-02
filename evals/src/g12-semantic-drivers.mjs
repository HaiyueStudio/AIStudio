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
    driver('scripted-verify-snake', 1_200, verifySnake),
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
  const session = new DriverSession(control, definition.maxTicks, options.signal, options.onObservation, options.resolveControl);
  const before = await session.inspect();
  await definition.run(session, deepCloneRecord(parameters));
  const after = await session.inspect();
  return deepFreeze({ driverId, maxTicks: definition.maxTicks, ticksConsumed: after.tick - before.tick, beforeTick: before.tick, afterTick: after.tick, inputs: session.inputs, observations: session.observations });
}

function driver(id, maxTicks, run) { return Object.freeze({ id, version: '1.0.0', maxTicks, run }); }

class DriverSession {
  constructor(control, maxTicks, signal, onObservation, resolveControl) {
    if (!control || typeof control.input !== 'function' || typeof control.step !== 'function' || typeof control.inspect !== 'function') throw new G12ReplayProgramError('g12.semantic-driver-control-invalid', 'Semantic drivers require input, step and inspect preview control methods.');
    this.control = control;
    this.maxTicks = maxTicks;
    this.signal = signal;
    this.onObservation = typeof onObservation === 'function' ? onObservation : null;
    this.resolveControl = typeof resolveControl === 'function' ? resolveControl : (value) => value;
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
    await this.inject({ tick, kind: 'action', action: this.resolveControl(control), phase: 'down', source: 'synthetic' });
    await this.inject({ tick: tick + durationTicks, kind: 'action', action: this.resolveControl(control), phase: 'up', source: 'synthetic' });
    return this.step(durationTicks + 1);
  }

  async chord(controls, durationTicks) {
    const current = await this.inspect();
    const tick = current.tick + 1;
    for (const control of controls) await this.inject({ tick, kind: 'action', action: this.resolveControl(control), phase: 'down', source: 'synthetic' });
    for (const control of [...controls].reverse()) await this.inject({ tick: tick + durationTicks, kind: 'action', action: this.resolveControl(control), phase: 'up', source: 'synthetic' });
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

async function verifySnake(session, parameters) {
  const targetCollections = integer(parameters.collections, 2, 8, 2);
  let observation = await session.inspect();
  let state = snakeState(observation);
  if (!state) throw new G12ReplayProgramError('g12.semantic-snake-state-missing', 'Snake verification requires authoritative numeric head, food, score and length fields.');
  state = await normalizeSnakeRunState(session, state);
  if (!state.direction) {
    observation = await waitForSnakeMovement(session, state.head, 40);
    state = snakeStateWithPrior(observation, state);
    if (!state?.direction) throw new G12ReplayProgramError('g12.semantic-snake-direction-unobservable', 'Snake direction was neither published as a vector nor observable from consecutive head positions.');
  }
  const initialScore = state.score;
  const initialDirection = state.direction;
  const opposite = directionName(-initialDirection.dc, -initialDirection.dr, state.axis);
  if (opposite) {
    const afterReverse = await moveSnakeWithAction(session, state, opposite);
    if (!afterReverse || afterReverse.direction.dc !== initialDirection.dc || afterReverse.direction.dr !== initialDirection.dr) {
      throw new G12ReplayProgramError('g12.semantic-snake-reverse-accepted', 'Snake accepted an immediate reverse direction input.');
    }
    state = afterReverse;
  }

  while (state.score - initialScore < targetCollections) {
    const desired = chooseSnakeDirection(state);
    if (!desired) throw new G12ReplayProgramError('g12.semantic-snake-route-missing', 'Snake verification could not derive a safe route to the authoritative food coordinate.');
    state = await moveSnakeWithAction(session, state, desired);
    if (!state) throw new G12ReplayProgramError('g12.semantic-snake-state-lost', 'Snake stopped publishing authoritative state while collecting food.');
    if (state.terminal) throw new G12ReplayProgramError('g12.semantic-snake-early-terminal', 'Snake reached a terminal state before collecting the required food.');
  }

  for (let index = 0; index < 400 && !state.terminal; index += 1) {
    observation = await session.step(1);
    state = snakeStateWithPrior(observation, state) ?? state;
  }
  if (!state.terminal) throw new G12ReplayProgramError('g12.semantic-snake-terminal-missing', 'Snake did not reach a collision terminal state within the bounded verification run.');
}

async function normalizeSnakeRunState(session, state) {
  let current = state;
  if (current.terminal) {
    const observation = await session.action('KeyR', 1);
    current = snakeState(observation);
    if (!current || current.terminal) throw new G12ReplayProgramError('g12.semantic-snake-restart-failed', 'Snake remained terminal after the authoritative restart input.');
  }
  if (isSnakeWaitingToStart(current)) {
    const control = current.direction
      ? directionName(current.direction.dc, current.direction.dr, current.axis)
      : directionTowardFood(current);
    if (!control) throw new G12ReplayProgramError('g12.semantic-snake-start-direction-missing', 'Snake verification could not derive a safe start direction.');
    current = await moveSnakeWithAction(session, current, control);
    if (!current || current.terminal) throw new G12ReplayProgramError('g12.semantic-snake-start-failed', 'Snake did not enter a playable state after the start direction input.');
  }
  return current;
}

function isSnakeWaitingToStart(state) {
  return ['ready', 'idle', 'waiting', 'wait', 'start', 'stopped'].includes(state.phase);
}

function directionTowardFood(state) {
  const dc = Math.sign(state.food.c - state.head.c);
  const dr = Math.sign(state.food.r - state.head.r);
  return dc !== 0 ? directionName(dc, 0, state.axis) : directionName(0, dr, state.axis);
}

async function moveSnakeWithAction(session, state, control) {
  let observation = await session.action(control, 1);
  let next = snakeStateWithPrior(observation, state);
  if (next && (next.terminal || next.head.c !== state.head.c || next.head.r !== state.head.r)) return next;
  observation = await waitForSnakeMovement(session, state.head, 40);
  return snakeStateWithPrior(observation, state);
}

async function waitForSnakeMovement(session, before, maxTicks) {
  for (let index = 0; index < maxTicks; index += 1) {
    const observation = await session.step(1);
    const state = snakeState(observation);
    if (!state || state.terminal || state.head.c !== before.c || state.head.r !== before.r) return observation;
  }
  throw new G12ReplayProgramError('g12.semantic-snake-movement-timeout', 'Snake head did not move after a bounded direction input.');
}

function chooseSnakeDirection(state) {
  const dx = state.food.c - state.head.c;
  const dr = state.food.r - state.head.r;
  const candidates = [];
  if (dx !== 0) candidates.push(directionName(Math.sign(dx), 0, state.axis));
  if (dr !== 0) candidates.push(directionName(0, Math.sign(dr), state.axis));
  const opposite = directionName(-state.direction.dc, -state.direction.dr, state.axis);
  const direct = candidates.find((entry) => entry && entry !== opposite);
  if (direct) return direct;
  const detour = state.head.r > 0 ? 'ArrowDown' : 'ArrowUp';
  return detour === opposite ? (state.head.c > 0 ? 'ArrowLeft' : 'ArrowRight') : detour;
}

function snakeState(observation) {
  const records = Array.isArray(observation?.value?.gameplay) ? observation.value.gameplay : [];
  for (const record of records) {
    const value = record?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const head = gridPoint(value.head), food = gridPoint(value.food), direction = gridDirection(value.dir ?? value.direction);
    const score = finite(value.score), length = finite(value.length);
    if (!head || !food || score === null || length === null) continue;
    const phase = String(value.state ?? value.status ?? '').toLowerCase();
    const terminal = ['over', 'gameover', 'game-over', 'failed', 'lost'].includes(phase);
    const axis = head.axis === 'z' || food.axis === 'z' || direction?.axis === 'z' ? 'z' : 'row';
    return { head, food, direction, score, length, terminal, phase, axis };
  }
  return null;
}

function snakeStateWithPrior(observation, prior) {
  const next = snakeState(observation);
  if (!next || next.direction) return next;
  if (prior && (next.head.c !== prior.head.c || next.head.r !== prior.head.r)) {
    return { ...next, direction: { dc: Math.sign(next.head.c - prior.head.c), dr: Math.sign(next.head.r - prior.head.r), axis: next.axis } };
  }
  return prior?.direction ? { ...next, direction: prior.direction } : next;
}

function gridPoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usesZ = value.r === undefined && value.row === undefined && value.y === undefined && value.z !== undefined;
  const c = finite(value.c ?? value.column ?? value.x), r = finite(value.r ?? value.row ?? value.y ?? value.z);
  return c === null || r === null ? null : { c, r, axis: usesZ ? 'z' : 'row' };
}
function gridDirection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usesZ = value.dr === undefined && value.y === undefined && value.z !== undefined;
  const dc = finite(value.dc ?? value.x), dr = finite(value.dr ?? value.y ?? value.z);
  return dc === null || dr === null ? null : { dc, dr, axis: usesZ ? 'z' : 'row' };
}
function directionName(dc, dr, axis = 'row') {
  if (dc === 1 && dr === 0) return 'ArrowRight';
  if (dc === -1 && dr === 0) return 'ArrowLeft';
  if (dc === 0 && dr === 1) return axis === 'z' ? 'ArrowDown' : 'ArrowUp';
  if (dc === 0 && dr === -1) return axis === 'z' ? 'ArrowUp' : 'ArrowDown';
  return null;
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

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
