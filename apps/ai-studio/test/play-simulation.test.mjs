import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaySimulation } from '../dist/play-simulation.js';

const replayEvents = Object.freeze([
  { kind: 'action', tick: 2, order: 0, source: 'synthetic', action: 'MoveX', phase: 'down', value: 1 },
  { kind: 'pointer', tick: 4, order: 1, source: 'synthetic', phase: 'move', pointerId: 1, x: 0.25, y: 0.5 },
  { kind: 'pointer', tick: 5, order: 2, source: 'synthetic', phase: 'down', pointerId: 1, x: 0.25, y: 0.5, button: 0 },
  { kind: 'action', tick: 8, order: 3, source: 'synthetic', action: 'Jump', phase: 'down' },
  { kind: 'action', tick: 9, order: 4, source: 'synthetic', action: 'Jump', phase: 'up' },
  { kind: 'pointer', tick: 12, order: 5, source: 'synthetic', phase: 'move', pointerId: 1, x: 0.8, y: 0.4 },
  { kind: 'action', tick: 14, order: 6, source: 'synthetic', action: 'Fire', phase: 'down' },
  { kind: 'action', tick: 15, order: 7, source: 'synthetic', action: 'Fire', phase: 'up' },
  { kind: 'action', tick: 20, order: 8, source: 'synthetic', action: 'MoveX', phase: 'up' },
  { kind: 'pointer', tick: 22, order: 9, source: 'synthetic', phase: 'up', pointerId: 1, x: 0.8, y: 0.4, button: 0 },
]);

function runCadence(deltas) {
  const state = { x: 0, jumps: 0, shots: 0, dragDistance: 0 };
  const simulation = new PlaySimulation({
    tickRateHz: 60,
    seed: 'g06-cadence',
    onTick: (_step, input) => {
      state.x += input.actions.find((entry) => entry.action === 'MoveX')?.value ?? 0;
      if (input.actions.find((entry) => entry.action === 'Jump')?.down) state.jumps += 1;
      if (input.actions.find((entry) => entry.action === 'Fire')?.down) state.shots += 1;
      const pointer = input.pointers[0];
      if (pointer?.dragging) state.dragDistance += Math.hypot(pointer.deltaX, pointer.deltaY);
    },
    readState: () => state,
  });
  for (const event of replayEvents) simulation.inject(event);
  for (const delta of deltas) simulation.advanceDisplayFrame(delta);
  return { state, snapshot: simulation.snapshot() };
}

test('30/60/120 Hz and variable display cadence produce the same tick trace and state hashes', () => {
  const cadences = [
    Array.from({ length: 60 }, () => 1_000 / 30),
    Array.from({ length: 120 }, () => 1_000 / 60),
    Array.from({ length: 240 }, () => 1_000 / 120),
    Array.from({ length: 20 }, () => [5, 11, 23, 7, 31, 13, 10]).flat(),
  ].map(runCadence);
  for (const result of cadences) {
    assert.equal(result.snapshot.tick, 120);
    assert.deepEqual(result.state, { x: 18, jumps: 1, shots: 1, dragDistance: Math.hypot(0.55, -0.1) });
  }
  const expected = cadences[0].snapshot.trace;
  for (const result of cadences.slice(1)) assert.deepEqual(result.snapshot.trace, expected);
});

test('pause, exact step, reset, and restart do not retain held input', () => {
  const observed = [];
  const simulation = new PlaySimulation({ onTick: (_step, input) => observed.push(input.actions.map((entry) => ({ ...entry }))) });
  simulation.inject({ kind: 'action', tick: 1, source: 'keyboard', action: 'MoveLeft', phase: 'down' });
  simulation.step();
  assert.equal(simulation.input.isPressed('MoveLeft'), true);
  simulation.pause();
  assert.equal(simulation.advanceDisplayFrame(10_000), 0);
  simulation.injectNext({ kind: 'reset', source: 'system', reason: 'blur' });
  simulation.step();
  assert.equal(simulation.input.isPressed('MoveLeft'), false);
  assert.equal(simulation.input.wasReleased('MoveLeft'), true);
  simulation.reset();
  assert.equal(simulation.snapshot().tick, 0);
  assert.equal(simulation.input.isPressed('MoveLeft'), false);
  assert.equal(observed.length, 2);
});

test('replay envelope restores puzzle drag, platform jump, racing steer and shooter fire input', () => {
  const samples = [];
  const simulation = new PlaySimulation({
    tickRateHz: 60,
    seed: 'g06-cadence',
    onTick: (step, input) => {
      if ([5, 8, 12, 14].includes(step.tick)) samples.push({ tick: step.tick, input });
    },
  });
  simulation.loadReplay({ schemaVersion: 1, tickRateHz: 60, seed: 'g06-cadence', events: replayEvents });
  simulation.step(14);
  assert.equal(samples[0].input.pointers[0].dragging, true);
  assert.equal(samples[1].input.actions.find((entry) => entry.action === 'Jump').down, true);
  assert.equal(samples[2].input.actions.find((entry) => entry.action === 'MoveX').value, 1);
  assert.equal(samples[3].input.actions.find((entry) => entry.action === 'Fire').down, true);
});
