import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeG12ReplayEvidence } from '../src/index.mjs';

test('snake evidence is derived from the full authoritative trace and correlated screenshot pixels', () => {
  const observations = [
    observation(0, { head: point(2, 2), food: point(4, 2), dir: vector(1, 0), score: 0, length: 3, state: 'playing' }),
    observation(1, { head: point(3, 2), food: point(4, 2), dir: vector(1, 0), score: 0, length: 3, state: 'playing' }),
    observation(2, { head: point(4, 2), food: point(4, 4), dir: vector(1, 0), score: 1, length: 4, state: 'playing' }),
    observation(3, { head: point(4, 3), food: point(4, 4), dir: vector(0, 1), score: 1, length: 4, state: 'playing' }),
    observation(4, { head: point(4, 4), food: point(1, 1), dir: vector(0, 1), score: 2, length: 5, state: 'playing' }),
    observation(5, { head: point(4, 7), food: point(1, 1), dir: vector(0, 1), score: 2, length: 5, state: 'over', events: ['gameover'] }),
    observation(6, { head: point(2, 2), food: point(4, 2), dir: vector(1, 0), score: 0, length: 3, state: 'playing', events: ['restart'] }),
  ];
  const scene = { entities: [
    entity('head', 'SnakeHead', [0.1, 0.95, 0.45, 1]),
    entity('body', 'SnakeBody', [0.15, 0.75, 0.35, 1]),
    entity('food', 'Food', [0.95, 0.2, 0.2, 1]),
  ] };
  const bitmap = coloredBitmap(20, 20, [
    [26, 242, 115], [38, 191, 89], [242, 51, 51], [30, 35, 45], [255, 255, 255],
  ]);
  const analysis = analyzeG12ReplayEvidence({
    genre: 'snake', scene, bitmap, width: 20, height: 20, tickRateHz: 60,
    replay: { observations, observedSignals: ['game-over'], semanticDriverIds: ['scripted-verify-snake'], trace: [{ kind: 'trigger-input-queued', sourceStepId: 'restart' }] },
  });
  assert.deepEqual(Object.fromEntries(Object.entries(analysis.traceSignals).filter(([key]) => key !== 'simulation.speedDriftRatio')), {
    'movement.directionChanged': true,
    'movement.immediateReverseBlocked': true,
    'snake.lengthDelta': 2,
    'score.delta': 2,
    'food.collections': 2,
    'food.respawned': true,
    'terminal.collisionGameOver': true,
    'restart.initialStateRestored': true,
    'restart.inputAccepted': true,
    'hud.scorePresent': true,
  });
  assert.ok(analysis.traceSignals['simulation.speedDriftRatio'] < 1e-9);
  assert.deepEqual(analysis.visualSignals, {
    'visual.pngCaptured': true,
    'visual.rolesDistinct': true,
    'visual.hudReadable': true,
    'visual.foodMatchesState': true,
  });
});

test('snake evidence accepts authoritative XZ coordinates', () => {
  const observations = [
    observation(0, { head: { x: 2, z: 2 }, food: { x: 3, z: 2 }, direction: { x: 1, z: 0 }, score: 0, length: 3, state: 'playing' }),
    observation(1, { head: { x: 3, z: 2 }, food: { x: 4, z: 2 }, direction: { x: 1, z: 0 }, score: 1, length: 4, state: 'playing' }),
  ];
  const analysis = analyzeG12ReplayEvidence({ genre: 'snake', replay: { observations, observedSignals: ['game-over'] }, scene: { entities: [] }, bitmap: Buffer.alloc(4), width: 1, height: 1 });
  assert.equal(analysis.traceSignals['score.delta'], 1);
  assert.equal(analysis.traceSignals['snake.lengthDelta'], 1);
});

test('snake evidence derives enum-backed direction changes from consecutive head positions', () => {
  const observations = [
    observation(0, { head: { x: 2, z: 2 }, food: { x: 4, z: 2 }, dir: 0, score: 0, length: 3, state: 'playing' }),
    observation(1, { head: { x: 3, z: 2 }, food: { x: 4, z: 2 }, dir: 0, score: 0, length: 3, state: 'playing' }),
    observation(2, { head: { x: 3, z: 3 }, food: { x: 4, z: 2 }, dir: 1, score: 0, length: 3, state: 'playing' }),
  ];
  const analysis = analyzeG12ReplayEvidence({ genre: 'snake', replay: { observations }, scene: { entities: [] }, bitmap: Buffer.alloc(4), width: 1, height: 1 });
  assert.equal(analysis.traceSignals['movement.directionChanged'], true);
});

test('snake evidence accepts flat XZ telemetry fields', () => {
  const observations = [
    observation(0, { headX: 2, headZ: 2, foodX: 3, foodZ: 2, dirX: 1, dirZ: 0, score: 0, length: 3, state: 'playing' }),
    observation(1, { headX: 3, headZ: 2, foodX: 5, foodZ: 2, dirX: 1, dirZ: 0, score: 1, length: 4, state: 'playing' }),
  ];
  const analysis = analyzeG12ReplayEvidence({ genre: 'snake', replay: { observations }, scene: { entities: [] }, bitmap: Buffer.alloc(4), width: 1, height: 1 });
  assert.equal(analysis.traceSignals['score.delta'], 1);
  assert.equal(analysis.traceSignals['snake.lengthDelta'], 1);
});

test('snake evidence accepts col-row point aliases', () => {
  const observations = [
    observation(0, { head: { col: 2, row: 2 }, food: { col: 3, row: 2 }, dir: { dc: 1, dr: 0 }, score: 0, length: 3, state: 'playing' }),
    observation(1, { head: { col: 3, row: 2 }, food: { col: 5, row: 2 }, dir: { dc: 1, dr: 0 }, score: 1, length: 4, state: 'playing' }),
  ];
  const analysis = analyzeG12ReplayEvidence({ genre: 'snake', replay: { observations }, scene: { entities: [] }, bitmap: Buffer.alloc(4), width: 1, height: 1 });
  assert.equal(analysis.traceSignals['score.delta'], 1);
  assert.equal(analysis.traceSignals['snake.lengthDelta'], 1);
});

test('snake evidence consumes the shared actors targets metrics telemetry shape', () => {
  const observations = [
    observation(0, canonicalSnake(2, 2, 3, 2, 0, 3)),
    observation(1, canonicalSnake(3, 2, 4, 2, 1, 4)),
  ];
  const analysis = analyzeG12ReplayEvidence({ genre: 'snake', replay: { observations }, scene: { entities: [] }, bitmap: Buffer.alloc(4), width: 1, height: 1 });
  assert.equal(analysis.traceSignals['score.delta'], 1);
  assert.equal(analysis.traceSignals['snake.lengthDelta'], 1);
});

test('snake evidence consumes nested player head, direction and lifecycle telemetry', () => {
  const nested = (headCol, foodCol, score, length, terminal = false) => ({
    schemaVersion: 1,
    state: { status: terminal ? 'over' : 'playing', phase: terminal ? 'game-over' : 'running' },
    space: { kind: 'grid', cols: 10, rows: 18 }, metrics: { score, length },
    actors: [{ id: 'snake', role: 'player', head: { cell: { col: headCol, row: 9 } }, dir: { dx: 1, dy: 0 } }],
    targets: [{ id: 'food', role: 'food', cell: { col: foodCol, row: 9 } }],
  });
  const observations = [observation(0, nested(2, 3, 0, 3)), observation(1, nested(3, 6, 1, 4)), observation(2, nested(4, 6, 1, 4, true))];
  const analysis = analyzeG12ReplayEvidence({ genre: 'snake', replay: { observations, observedSignals: ['game-over'] }, scene: { entities: [] }, bitmap: Buffer.alloc(4), width: 1, height: 1 });
  assert.equal(analysis.traceSignals['score.delta'], 1);
  assert.equal(analysis.traceSignals['snake.lengthDelta'], 1);
  assert.equal(analysis.traceSignals['terminal.collisionGameOver'], true);
});

test('shared trace analyzers derive authoritative signals for every non-snake genre', () => {
  const cases = [
    ['match-3', [
      canonical(0, { score: 0, emptyCells: 0, invalidSwapScoreDelta: 0, clearedCount: 0, maxSettleTicks: 0 }, { canInteract: true }),
      canonical(1, { score: 6, emptyCells: 0, invalidSwapScoreDelta: 0, clearedCount: 6, maxSettleTicks: 40 }, { canInteract: true }, ['invalid-swap-restored', 'board-settled']),
    ], { 'swap.invalidRestored': true, 'match.clearedCount': 6, 'score.delta': 6, 'board.maxSettleTicks': 40 }],
    ['falling-blocks', [
      canonical(0, { level: 1, dropInterval: 20, lockedCount: 0, linesCleared: 0, overlapCellCount: 0, duplicateActivePieces: 0 }, { transformsWithinBoard: true }),
      canonical(1, { level: 2, dropInterval: 15, lockedCount: 4, linesCleared: 1, overlapCellCount: 0, duplicateActivePieces: 0 }, { transformsWithinBoard: true, compactedAfterClear: true }, ['piece-locked', 'line-cleared', 'top-out']),
    ], { 'piece.lockedCount': 4, 'line.clearedCount': 1, 'progression.speedIncreased': true, 'terminal.topOutGameOver': true }],
    ['jigsaw', [
      canonical(0, { lockedCount: 0, wrongLockedCount: 0, visiblePieceCount: 12, draggableCount: 12 }, { dragFollowsPointer: true, activePieceOnTop: true, correctMappingOnly: true }),
      canonical(1, { lockedCount: 12, wrongLockedCount: 0, visiblePieceCount: 12, draggableCount: 12 }, { dragFollowsPointer: true, activePieceOnTop: true, correctMappingOnly: true }, ['piece-locked', 'complete']),
    ], { 'puzzle.lockedCount': 12, 'snap.wrongLockedCount': 0, 'terminal.completed': true }],
    ['platformer', [
      canonical(0, { platformPenetrations: 0, duplicateCollectibleCredits: 0, duplicatePlayers: 0, cameraJitterPixels: 1 }, {}, ['jump', 'landed', 'checkpoint-activated', 'respawned', 'victory']),
    ], { 'player.jumpAndLandObserved': true, 'physics.platformPenetrations': 0, 'respawn.usedActivatedCheckpoint': true, 'terminal.victoryReached': true }],
    ['racing', [
      canonical(0, { speed: 0, boundaryPenetrations: 0, cameraJitterPixels: 2 }, { checkpointOrderValid: true, brakingObserved: true }),
      canonical(1, { speed: 20, boundaryPenetrations: 0, cameraJitterPixels: 2 }, { checkpointOrderValid: true, brakingObserved: true }, ['braking', 'lap-complete', 'collision-recovered']),
    ], { 'vehicle.accelerationObserved': true, 'vehicle.brakingObserved': true, 'lap.completed': true, 'checkpoint.orderValid': true }],
    ['shooter', [
      canonical(0, { aimErrorDegrees: 1, blockedShots: 3, duplicateHitSettlements: 0, staleProjectileCount: 0 }, { movementObserved: true, validHitDamageObserved: true, hitFeedbackObserved: true }, ['shot-fired', 'enemy-hit', 'complete']),
    ], { 'player.movementObserved': true, 'aim.maxAngularErrorDegrees': 1, 'cover.blockedShots': 3, 'terminal.reached': true }],
  ];
  for (const [genre, values, expected] of cases) {
    const observations = values.map((value, tick) => observation(tick, value));
    const analysis = analyzeG12ReplayEvidence({ genre, replay: { observations }, scene: { entities: [] }, bitmap: Buffer.alloc(4), width: 1, height: 1 });
    for (const [key, value] of Object.entries(expected)) assert.equal(analysis.traceSignals[key], value, `${genre}:${key}`);
  }
});

test('falling-block evidence retains cumulative nested metrics and derives board safety across restart', () => {
  const state = (status, phase, metrics, actors, events = []) => ({
    schemaVersion: 1,
    state: { status, phase },
    events,
    space: { type: 'grid', dimensions: { cols: 10, rows: 20 }, bounds: { minCol: 0, maxCol: 9, minRow: 0, maxRow: 19 } },
    metrics,
    actors,
    targets: [],
  });
  const active = (cells) => ({ id: 'active-piece', role: 'active-piece', cells });
  const locked = (cells) => ({ id: 'locked-stack', role: 'locked-stack', cells });
  const observations = [
    observation(0, state('playing', 'falling', { piecesLocked: 0, lines: 0, level: 1, gravityIntervalTicks: 26 }, [active([[4, 18], [5, 18]]), locked([])])),
    observation(1, state('playing', 'falling', { piecesLocked: 1, lines: 0, level: 1, gravityIntervalTicks: 26 }, [active([[3, 18], [4, 18]]), locked([[4, 0, 3], [5, 0, 3]])], ['moved-left', 'rotated', 'piece-locked'])),
    observation(2, state('playing', 'falling', { piecesLocked: 26, lines: 10, level: 2, gravityIntervalTicks: 24 }, [active([[4, 17], [5, 17]]), locked([[0, 0, 1], [1, 0, 1]])], ['row-cleared'])),
    observation(3, state('game-over', 'over', { piecesLocked: 40, lines: 10, level: 2, gravityIntervalTicks: 24 }, [], ['game-over'])),
    observation(4, state('playing', 'falling', { piecesLocked: 0, lines: 0, level: 1, gravityIntervalTicks: 26 }, [active([[4, 18], [5, 18]]), locked([])], ['restarted'])),
  ];
  const colors = [[50, 230, 90], [240, 160, 40], [30, 35, 45], [100, 110, 125], [255, 255, 255]];
  const analysis = analyzeG12ReplayEvidence({
    genre: 'falling-blocks', observations, bitmap: coloredBitmap(20, 20, colors), width: 20, height: 20,
    replay: { observations, trace: [{ kind: 'input-queued', sourceStepId: 'move-rotate' }, { kind: 'trigger-input-queued', sourceStepId: 'restart' }] },
    scene: { entities: [entity('i', 'Tetromino I Cell', rgba(colors[0])), entity('o', 'Tetromino O Cell', rgba(colors[1]))] },
  });
  assert.deepEqual(analysis.traceSignals, {
    'piece.transformsWithinBoard': true,
    'board.overlapCellCount': 0,
    'controls.moveRotateObserved': true,
    'piece.lockedCount': 40,
    'line.clearedCount': 10,
    'board.compactedAfterClear': true,
    'progression.speedIncreased': true,
    'terminal.topOutGameOver': true,
    'restart.initialStateRestored': true,
    'hud.scoreLevelPreviewPresent': false,
    'board.duplicateActivePieces': 0,
  });
  assert.equal(analysis.visualSignals['visual.activeAndLockedDistinct'], true);
});

test('non-snake visual analyzers correlate named scene roles with real bitmap colors', () => {
  const colors = [[230, 40, 40], [40, 220, 80], [40, 100, 230], [35, 40, 50], [255, 255, 255]];
  const bitmap = coloredBitmap(20, 20, colors);
  const cases = [
    ['match-3', [entity('a', 'GemRed', rgba(colors[0])), entity('b', 'GemGreen', rgba(colors[1])), entity('c', 'GemBlue', rgba(colors[2]))], canonical(0, {}, {}), ['visual.boardRolesDistinct']],
    ['falling-blocks', [entity('a', 'ActivePiece', rgba(colors[0])), entity('b', 'LockedStack', rgba(colors[1]))], canonical(0, {}, {}), ['visual.activeAndLockedDistinct']],
    ['jigsaw', [entity('a', 'PuzzlePiece', rgba(colors[0]))], canonical(0, { visiblePieceCount: 12 }, {}), ['visual.pieceBoundariesReadable', 'visual.allPiecesInViewport']],
    ['platformer', [entity('a', 'Player', rgba(colors[0])), entity('b', 'PlatformPath', rgba(colors[1]))], canonical(0, {}, { cameraWithinLevelBounds: true }), ['visual.playerAndForwardPathVisible', 'visual.cameraWithinLevelBounds']],
    ['racing', [entity('a', 'Vehicle', rgba(colors[0])), entity('b', 'RoadTrack', rgba(colors[1])), entity('c', 'ImpactEffect', rgba(colors[2]))], canonical(0, {}, {}, ['collision']), ['visual.vehicleAndRoadVisible', 'visual.collisionFeedbackVisible']],
    ['shooter', [entity('a', 'Player', rgba(colors[0])), entity('b', 'Enemy', rgba(colors[1])), entity('c', 'Projectile', rgba(colors[2]))], canonical(0, {}, {}), ['visual.combatRolesDistinct']],
  ];
  for (const [genre, entities, value, expected] of cases) {
    const observationValue = observation(0, value);
    observationValue.value.hud = [{ text: genre === 'falling-blocks' ? 'Score 0 Level 1 Next I' : 'Score 0 Moves 10' }];
    const analysis = analyzeG12ReplayEvidence({ genre, replay: { observations: [observationValue] }, scene: { entities }, bitmap, width: 20, height: 20 });
    for (const key of expected) assert.equal(analysis.visualSignals[key], true, `${genre}:${key}`);
  }
});

function observation(tick, value) {
  return { tick, value: { timeMs: tick * (1_000 / 60), gameplay: [{ id: 'snake', value }], hud: { score: { text: `SCORE ${value.score}` } } } };
}
function point(c, r) { return { c, r }; }
function vector(dc, dr) { return { dc, dr }; }
function canonicalSnake(headC, headR, foodC, foodR, score, length) {
  return { schemaVersion: 1, state: 'playing', events: [], space: { kind: 'grid', columns: 10, rows: 10 }, metrics: { score, length }, actors: [{ id: 'head', role: 'snake-head', grid: { column: headC, row: headR } }], targets: [{ id: 'food', role: 'food', grid: { column: foodC, row: foodR } }], dir: { dc: 1, dr: 0 } };
}
function canonical(tick, metrics, flags = {}, events = []) {
  return { schemaVersion: 1, state: events.includes('complete') || events.includes('victory') || events.includes('top-out') ? 'complete' : 'playing', events, space: { kind: 'world', bounds: [-10, 10] }, metrics, actors: [], targets: [], ...flags, tick };
}
function entity(id, name, color) { return { id, name, appearance: { color } }; }
function rgba(color) { return [...color.map((value) => value / 255), 1]; }
function coloredBitmap(width, height, colors) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const color = index < 12 ? colors[4] : colors[Math.floor(index / 80) % 4];
    const offset = index * 4;
    bitmap[offset] = color[2]; bitmap[offset + 1] = color[1]; bitmap[offset + 2] = color[0]; bitmap[offset + 3] = 255;
  }
  return bitmap;
}
