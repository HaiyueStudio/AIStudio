import assert from 'node:assert/strict';
import test from 'node:test';
import { deepClone } from '../src/canonical.mjs';
import { G12_SEMANTIC_REPLAY_ACTIONS, assertG12SemanticDriverCoverage, compileG12ReplayProgram, loadEvaluationAssets } from '../src/index.mjs';

const assets = await loadEvaluationAssets();

test('all seven hidden replays compile and declare every semantic driver explicitly', () => {
  const programs = assets.suite.cases.map((entry) => compileG12ReplayProgram(entry.inputReplay, { baseTick: 7 }));
  const coverage = assertG12SemanticDriverCoverage(programs, G12_SEMANTIC_REPLAY_ACTIONS);
  assert.deepEqual(coverage.required, [...G12_SEMANTIC_REPLAY_ACTIONS]);
  assert.ok(programs.every((program) => program.clock === 'fixed-tick-relative-to-paused-start' && program.baseTick === 7));
});

test('real iframe startup ticks rebase absolute suite ticks and play-ready input', () => {
  const snake = assets.suite.cases.find((entry) => entry.genre === 'snake');
  const program = compileG12ReplayProgram(snake.inputReplay, { baseTick: 3 });
  const verification = program.commands.find((entry) => entry.sourceStepId === 'verify-gameplay');
  assert.equal(verification.schedule.tick, 4);
  assert.equal(verification.driverId, 'scripted-verify-snake');
});

test('press, hold and sequence expand to deterministic down/up pairs', () => {
  const tetris = assets.suite.cases.find((entry) => entry.genre === 'falling-blocks');
  const platformer = assets.suite.cases.find((entry) => entry.genre === 'platformer');
  const tetrisProgram = compileG12ReplayProgram(tetris.inputReplay);
  assert.equal(tetrisProgram.commands.filter((entry) => entry.sourceStepId === 'move-rotate').length, 6);
  const run = compileG12ReplayProgram(platformer.inputReplay).commands.filter((entry) => entry.sourceStepId === 'run');
  assert.deepEqual(run.map((entry) => [entry.phase, entry.schedule.tick]), [['down', 1], ['up', 181]]);
});

test('hidden lifecycle replay explicitly exercises platform restart and racing brake plus restart', () => {
  const platformer = assets.suite.cases.find((entry) => entry.genre === 'platformer');
  const racing = assets.suite.cases.find((entry) => entry.genre === 'racing');
  assert.ok(platformer.inputReplay.steps.some((entry) => entry.id === 'restart' && entry.at === 'after:complete'));
  assert.ok(racing.inputReplay.steps.some((entry) => entry.id === 'brake' && entry.control === 'ArrowDown'));
  assert.ok(racing.inputReplay.steps.some((entry) => entry.id === 'restart' && entry.at === 'after:terminal-state'));
});

test('semantic replay is fail-closed when a real adapter omits or invents a driver', () => {
  const programs = assets.suite.cases.map((entry) => compileG12ReplayProgram(entry.inputReplay));
  assert.throws(() => assertG12SemanticDriverCoverage(programs, G12_SEMANTIC_REPLAY_ACTIONS.slice(1)), (error) => error.code === 'g12.semantic-driver-coverage-invalid' && error.details.missing.length === 1);
  assert.throws(() => assertG12SemanticDriverCoverage(programs, [...G12_SEMANTIC_REPLAY_ACTIONS, 'scripted-win-anyway']), (error) => error.code === 'g12.semantic-driver-coverage-invalid' && error.details.unknown.includes('scripted-win-anyway'));
});

test('unknown semantic actions cannot silently pass through the runner', () => {
  const replay = deepClone(assets.suite.cases[0].inputReplay);
  replay.steps[0].action = 'scripted-win-anyway';
  delete replay.steps[0].control;
  assert.throws(() => compileG12ReplayProgram(replay), (error) => error.code === 'g12.replay-action-unsupported');
});
