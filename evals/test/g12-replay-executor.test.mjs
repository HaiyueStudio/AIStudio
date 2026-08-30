import assert from 'node:assert/strict';
import test from 'node:test';
import { GameplaySignalTracker, awaitG12GameplayTrigger, compileG12ReplayProgram, executeG12ReplayProgram } from '../src/index.mjs';

test('replay executor prequeues fixed input, runs semantic drivers and resolves observed triggers', async () => {
  const control = previewControl({ eventAt: 4, event: 'game-over' });
  const program = compileG12ReplayProgram({ driver: 'fixed', steps: [
    { id: 'start', at: 'play-ready', action: 'press', control: 'ArrowRight', durationTicks: 1 },
    { id: 'semantic', at: 'tick:2', action: 'scripted-swap', parameters: { kind: 'creates-match' } },
    { id: 'restart', at: 'after:game-over', action: 'press', control: 'KeyR', durationTicks: 1 },
  ] });
  const drivers = { 'scripted-swap': { id: 'scripted-swap', version: '1.0.0', maxTicks: 4, async run(session) { await session.action('KeyX', 1); } } };
  const result = await executeG12ReplayProgram(control, program, { drivers, maxTriggerWaitTicks: 10 });
  assert.equal(result.finalTick, 6);
  assert.deepEqual(result.semanticDriverIds, ['scripted-swap']);
  assert.ok(result.observedSignals.includes('game-over') && result.observedSignals.includes('terminal-state'));
  assert.deepEqual(control.events.filter((entry) => entry.action === 'KeyR').map((entry) => [entry.phase, entry.tick]), [['down', 5], ['up', 6]]);
});

test('trigger wait consumes fixed ticks and fails closed without an authoritative event', async () => {
  const control = previewControl();
  await assert.rejects(() => awaitG12GameplayTrigger(control, 'piece-locked', new GameplaySignalTracker(), { maxWaitTicks: 3 }), (error) => error.code === 'g12.replay-trigger-timeout' && error.details.observedSignals.includes('playing'));
  assert.equal(control.tick(), 3);
});

test('replay execution rejects stale base ticks and runtime errors', async () => {
  const program = compileG12ReplayProgram({ driver: 'fixed', steps: [{ id: 'start', at: 'play-ready', action: 'press', control: 'Space', durationTicks: 1 }] });
  const stale = previewControl({ startTick: 1 });
  await assert.rejects(() => executeG12ReplayProgram(stale, program), (error) => error.code === 'g12.replay-base-tick-stale');
  const broken = previewControl({ runtimeErrorCount: 1 });
  await assert.rejects(() => executeG12ReplayProgram(broken, program), (error) => error.code === 'g12.replay-runtime-error');
});

test('terminal status aliases are normalized but HUD text is never treated as a trigger', () => {
  const tracker = new GameplaySignalTracker();
  tracker.observe({ tick: 7, value: { gameplay: [{ value: { status: 'Victory', flags: { 'board-settled': true } } }], hud: [{ text: 'GAME OVER' }] } });
  assert.equal(tracker.tickFor('complete'), 7);
  assert.equal(tracker.tickFor('terminal-state'), 7);
  assert.equal(tracker.tickFor('board-settled'), 7);
  assert.equal(tracker.tickFor('game-over'), null);
});

function previewControl(options = {}) {
  let tick = options.startTick ?? 0;
  const events = [];
  const observation = () => ({
    tick,
    value: {
      runtimeErrorCount: options.runtimeErrorCount ?? 0,
      gameplay: [{ scriptId: 'script:test', entityId: 'entity:test', id: 'game', value: { status: 'playing', events: tick === options.eventAt ? [options.event] : [] } }],
    },
  });
  return {
    events,
    tick: () => tick,
    async inspect() { return observation(); },
    async input(event) { events.push(event); return observation(); },
    async step(count) { tick += count; return observation(); },
  };
}
