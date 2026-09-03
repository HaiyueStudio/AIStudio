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
  const analysis = analyzeG12ReplayEvidence({ genre: 'snake', replay: { observations }, scene: { entities: [] }, bitmap: Buffer.alloc(4), width: 1, height: 1 });
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

function observation(tick, value) {
  return { tick, value: { timeMs: tick * (1_000 / 60), gameplay: [{ id: 'snake', value }], hud: { score: { text: `SCORE ${value.score}` } } } };
}
function point(c, r) { return { c, r }; }
function vector(dc, dr) { return { dc, dr }; }
function entity(id, name, color) { return { id, name, appearance: { color } }; }
function coloredBitmap(width, height, colors) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const color = index < 12 ? colors[4] : colors[Math.floor(index / 80) % 4];
    const offset = index * 4;
    bitmap[offset] = color[2]; bitmap[offset + 1] = color[1]; bitmap[offset + 2] = color[0]; bitmap[offset + 3] = 255;
  }
  return bitmap;
}
