import assert from 'node:assert/strict';
import test from 'node:test';
import { G12_SEMANTIC_DRIVER_IDS, G12_SEMANTIC_REPLAY_ACTIONS, createG12SemanticDriverRegistry, executeG12SemanticDriver } from '../src/index.mjs';

test('reviewed semantic registry exactly covers every hidden replay action', () => {
  assert.deepEqual(G12_SEMANTIC_DRIVER_IDS, [...G12_SEMANTIC_REPLAY_ACTIONS]);
  const registry = createG12SemanticDriverRegistry();
  assert.ok(Object.values(registry).every((entry) => entry.version === '1.0.0' && Number.isSafeInteger(entry.maxTicks) && entry.maxTicks > 0));
});

test('every semantic driver executes bounded real preview-control operations', async () => {
  const registry = createG12SemanticDriverRegistry();
  for (const driverId of G12_SEMANTIC_DRIVER_IDS) {
    const control = driverId === 'scripted-verify-snake' ? snakePreviewControl() : previewControl();
    const result = await executeG12SemanticDriver(registry, driverId, control, parameters(driverId));
    assert.ok(result.inputs > 0, `${driverId} issued no input`);
    assert.ok(result.ticksConsumed > 0 && result.ticksConsumed <= result.maxTicks, `${driverId} exceeded tick budget`);
    assert.equal(control.events.every((event) => event.tick > 5 && event.source === 'synthetic'), true, `${driverId} emitted invalid input`);
  }
});

test('semantic pointer drivers consume only normalized, exact-role replay targets', async () => {
  const control = previewControl([
    { driverId: 'scripted-swap', role: 'from', kind: 'creates-match', x: 0.11, y: 0.22 },
    { driverId: 'scripted-swap', role: 'to', kind: 'creates-match', x: 0.33, y: 0.44 },
  ]);
  await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-swap', control, { kind: 'creates-match' });
  const pointers = control.events.filter((event) => event.kind === 'pointer');
  assert.deepEqual([pointers[0].x, pointers[0].y, pointers.at(-1).x, pointers.at(-1).y], [0.11, 0.22, 0.33, 0.44]);
});

test('wrong jigsaw drop injects a bounded pointer cancel before later recovery checks', async () => {
  const control = previewControl();
  await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-drag-piece', control, { destination: 'wrong-slot' });
  assert.equal(control.events.some((event) => event.kind === 'pointer' && event.phase === 'cancel'), true);
});

test('falling-block driver retains a same-tick active-and-locked visual checkpoint', async () => {
  const control = previewControl();
  const result = await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-place-pieces', control, {});
  assert.equal(result.checkpoints.length, 1);
  assert.equal(result.checkpoints[0].label, 'active-and-locked');
  assert.equal(result.checkpoints[0].tick, result.checkpoints[0].capture.tick);
});

test('semantic drivers fail closed for missing registration and tick-budget overflow', async () => {
  await assert.rejects(() => executeG12SemanticDriver({}, 'scripted-swap', previewControl(), {}), (error) => error.code === 'g12.semantic-driver-missing');
  const registry = { 'scripted-swap': { id: 'scripted-swap', maxTicks: 1, async run(session) { await session.action('Space', 2); } } };
  await assert.rejects(() => executeG12SemanticDriver(registry, 'scripted-swap', previewControl(), {}), (error) => error.code === 'g12.semantic-driver-budget-exceeded');
});

test('snake verification accepts XZ gameplay state and maps vertical direction semantics', async () => {
  const control = snakePreviewControl('xz', 'index');
  const result = await executeG12SemanticDriver(
    createG12SemanticDriverRegistry(),
    'scripted-verify-snake',
    control,
    { collections: 2 },
    { resolveControl: (value) => ({ ArrowUp: 'MoveUp', ArrowDown: 'MoveDown', ArrowLeft: 'MoveLeft', ArrowRight: 'MoveRight' })[value] ?? value },
  );
  assert.ok(result.inputs > 0);
  assert.ok(control.events.some((event) => event.action === 'MoveDown'));
});

test('snake verification starts a ready game before testing reverse input', async () => {
  const control = snakePreviewControl('row', 'vector', 'ready');
  await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-verify-snake', control, { collections: 2 });
  assert.equal(control.events.some((event) => event.action === 'ArrowRight'), true);
});

test('snake verification restarts a terminal handoff before replay', async () => {
  const control = snakePreviewControl('row', 'vector', 'over');
  await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-verify-snake', control, { collections: 2 });
  assert.equal(control.events.some((event) => event.action === 'KeyR'), true);
});

test('snake verification maps increasing board rows to the down control', async () => {
  const control = snakePreviewControl('row', 'vector', 'playing', { c: 2, r: 3 });
  await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-verify-snake', control, { collections: 2 });
  assert.equal(control.events.some((event) => event.action === 'ArrowDown'), true);
});

test('snake verification accepts flat XZ telemetry fields', async () => {
  const control = snakePreviewControl('xz', 'vector', 'playing', null, 'flat');
  const result = await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-verify-snake', control, { collections: 2 });
  assert.ok(result.inputs > 0);
});

test('snake verification accepts col-row point aliases', async () => {
  const control = snakePreviewControl('row', 'vector', 'playing', null, 'col-row');
  const result = await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-verify-snake', control, { collections: 2 });
  assert.ok(result.inputs > 0);
});

test('snake verification consumes the shared actors targets metrics telemetry shape', async () => {
  const control = snakePreviewControl('row', 'vector', 'playing', null, 'canonical');
  const result = await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-verify-snake', control, { collections: 2 });
  assert.ok(result.inputs > 0);
});

test('snake verification consumes nested player head, direction and lifecycle telemetry', async () => {
  const control = snakePreviewControl('row', 'vector', 'playing', null, 'nested-player');
  const result = await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-verify-snake', control, { collections: 2 });
  assert.ok(result.inputs > 0);
});

test('snake verification calibrates cell XY controls instead of assuming row sign', async () => {
  const control = snakePreviewControl('row', 'omitted', 'playing', null, 'cell-xy-inverted');
  const result = await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-verify-snake', control, { collections: 2 });
  assert.ok(result.inputs > 0);
  assert.equal(control.events.some((event) => event.action === 'ArrowUp'), true);
});

function previewControl(replayTargets = []) {
  let tick = 5;
  const events = [];
  const observation = () => ({ tick, value: { gameplay: [{ scriptId: 'script:test', entityId: 'entity:test', id: 'game', value: { replayTargets } }] } });
  return {
    events,
    async inspect() { return observation(); },
    async input(event) { events.push(event); return observation(); },
    async step(count) { tick += count; return observation(); },
    async capture() { return { tick, base64: '' }; },
  };
}

function snakePreviewControl(axis = 'row', directionMode = 'vector', initialState = 'playing', initialFood = null, telemetryShape = 'nested') {
  let tick = 5;
  let head = telemetryShape === 'cell-xy-inverted' ? { c: 2, r: 5 } : { c: 2, r: 1 };
  let food = initialFood ?? (telemetryShape === 'cell-xy-inverted' ? { c: 6, r: 5 } : axis === 'xz' ? { c: 2, r: 3 } : { c: 6, r: 1 });
  let direction = { dc: 1, dr: 0 };
  let score = 0;
  let length = 3;
  let phase = initialState;
  let terminal = phase === 'over';
  const events = [];
  const external = (value) => axis === 'xz' ? { x: value.c ?? value.dc, z: value.r ?? value.dr } : value;
  const encodedDirection = () => directionMode === 'omitted' ? undefined : directionMode === 'index'
    ? [{ dc: 1, dr: 0 }, { dc: 0, dr: 1 }, { dc: -1, dr: 0 }, { dc: 0, dr: -1 }].findIndex((entry) => entry.dc === direction.dc && entry.dr === direction.dr)
    : external(direction);
  const gameplayValue = () => telemetryShape === 'flat'
    ? { state: terminal ? 'over' : phase, headX: head.c, headZ: head.r, foodX: food.c, foodZ: food.r, dirX: direction.dc, dirZ: direction.dr, score, length, events: terminal ? ['gameover'] : [] }
    : telemetryShape === 'col-row'
      ? { state: terminal ? 'over' : phase, head: { col: head.c, row: head.r }, food: { col: food.c, row: food.r }, dir: encodedDirection(), score, length, events: terminal ? ['gameover'] : [] }
    : telemetryShape === 'canonical'
      ? { schemaVersion: 1, state: terminal ? 'over' : phase, space: { kind: 'grid', columns: 11, rows: 11 }, metrics: { score, length }, actors: [{ id: 'snake-head', role: 'snake-head', grid: { column: head.c, row: head.r } }], targets: [{ id: 'food', role: 'food', grid: { column: food.c, row: food.r } }], dir: encodedDirection(), events: terminal ? ['gameover'] : [] }
    : telemetryShape === 'nested-player'
      ? { schemaVersion: 1, state: { status: terminal ? 'over' : 'playing', phase: terminal ? 'game-over' : phase }, space: { kind: 'grid', columns: 11, rows: 11 }, metrics: { score, length }, actors: [{ id: 'snake', role: 'player', head: { cell: { col: head.c, row: head.r } }, dir: encodedDirection() }], targets: [{ id: 'food', role: 'food', cell: { col: food.c, row: food.r } }], events: terminal ? ['gameover'] : [] }
    : telemetryShape === 'cell-xy-inverted'
      ? { schemaVersion: 1, state: { status: terminal ? 'over' : 'playing', phase: terminal ? 'game-over' : phase }, space: { grid: { cols: 11, rows: 11 }, axes: ['x', 'z'] }, metrics: { score, length }, actors: [{ id: 'snake-head', role: 'head', cell: { x: head.c, y: head.r }, world: { x: head.c, z: head.r } }], targets: [{ id: 'food', role: 'food', cell: { x: food.c, y: food.r }, world: { x: food.c, z: food.r } }], events: terminal ? ['gameover'] : [] }
    : { state: terminal ? 'over' : phase, head: external(head), food: external(food), dir: encodedDirection(), score, length, events: terminal ? ['gameover'] : [] };
  const observation = () => ({ tick, value: { timeMs: tick * (1_000 / 60), gameplay: [{ scriptId: 'script:test', entityId: 'entity:test', id: 'snake', value: gameplayValue() }] } });
  const advance = () => {
    tick += 1;
    for (const event of events.filter((entry) => entry.tick === tick && entry.phase === 'down')) {
      const action = ({ MoveUp: 'ArrowUp', MoveDown: 'ArrowDown', MoveLeft: 'ArrowLeft', MoveRight: 'ArrowRight' })[event.action] ?? event.action;
      if (action === 'KeyR' && terminal) {
        head = { c: 2, r: 1 }; direction = { dc: 1, dr: 0 }; score = 0; length = 3; terminal = false; phase = 'ready';
        continue;
      }
      const invertedVertical = telemetryShape === 'cell-xy-inverted';
      const requested = action === 'ArrowRight' ? { dc: 1, dr: 0 } : action === 'ArrowLeft' ? { dc: -1, dr: 0 } : action === 'ArrowUp' ? { dc: 0, dr: invertedVertical ? 1 : -1 } : action === 'ArrowDown' ? { dc: 0, dr: invertedVertical ? -1 : 1 } : direction;
      if (requested.dc !== -direction.dc || requested.dr !== -direction.dr) { direction = requested; phase = 'playing'; }
    }
    if (terminal || phase !== 'playing') return;
    head = { c: head.c + direction.dc, r: head.r + direction.dr };
    if (head.c === food.c && head.r === food.r) { score += 1; length += 1; food = score === 1 ? (axis === 'xz' ? { c: 5, r: 1 } : { c: 8, r: 1 }) : { c: 0, r: 0 }; }
    if (head.c > 10 || head.c < 0 || head.r < 0 || head.r > 10) { terminal = true; phase = 'over'; }
  };
  return {
    events,
    async inspect() { return observation(); },
    async input(event) { events.push(event); return observation(); },
    async step(count) { for (let index = 0; index < count; index += 1) advance(); return observation(); },
  };
}

function parameters(driverId) {
  if (driverId === 'scripted-swap') return { kind: 'creates-match' };
  if (driverId === 'scripted-repeat-valid-swaps') return { count: 2 };
  if (driverId === 'scripted-drag-piece') return { destination: 'near-correct-slot' };
  if (driverId === 'scripted-follow-centerline') return { durationTicks: 60 };
  if (driverId === 'scripted-aim-and-fire' || driverId === 'scripted-fire-at-covered-enemy') return { shots: 2 };
  return {};
}
