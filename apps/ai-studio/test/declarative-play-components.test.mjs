import assert from 'node:assert/strict';
import test from 'node:test';
import { DeclarativePlayRuntime } from '../dist/declarative-play-components.js';

const component = (id, type, value, enabled = true) => Object.freeze({ id, type, version: '1.0.0', enabled, value: Object.freeze(value) });

test('declarative gameplay, timer, HUD and listener project deterministically without script source', () => {
  const runtime = new DeclarativePlayRuntime([{ id: 'entity:game', components: [
    component('component:state', 'haiyue.gameplay.state', {
      observationId: 'game', state: 'playing', score: 12, health: 3, maxHealth: 5, checkpoint: 'room-2',
      counters: [{ id: 'lines', value: 4 }], flags: [{ id: 'boss', value: false }], events: [{ id: 'spawned', value: 'piece-7' }],
    }),
    component('component:timers', 'haiyue.gameplay.timers', { observationId: 'timers', timers: [
      { id: 'drop', durationTicks: 3, startDelayTicks: 0, repeat: true, running: true, event: 'drop-piece' },
      { id: 'round', durationTicks: 5, startDelayTicks: 1, repeat: false, running: true, event: 'round-ended' },
    ] }),
    component('component:pool', 'haiyue.gameplay.pool', { observationId: 'pieces', templateEntityId: 'entity:piece', capacity: 2, activeCount: 1, spawns: [
      { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, color: [1, 0, 0, 1] },
      { position: { x: 1, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, color: [0, 1, 0, 1] },
    ] }),
    component('component:rules', 'haiyue.gameplay.rules', { rules: [{ id: 'hard-drop', once: true, when: { source: 'input-pressed', value: 'HardDrop', entityAId: '', entityBId: '', phase: 'enter' }, actions: [
      { kind: 'add-score', targetObservationId: 'game', key: '', numberValue: 10, textValue: '', booleanValue: false },
      { kind: 'set-pool-count', targetObservationId: 'pieces', key: '', numberValue: 2, textValue: '', booleanValue: false },
      { kind: 'emit-event', targetObservationId: 'game', key: 'hard-dropped', numberValue: 0, textValue: 'piece-7', booleanValue: false },
    ] }] }),
    component('component:hud', 'haiyue.ui.hud', { items: [
      { id: 'score', kind: 'text', text: 'Score {score} / Lines {counter:lines}', assetId: '', action: '', position: 'top-left', offsetX: 0, offsetY: 0, color: '#fff', backgroundColor: '#0008', fontSize: 22, width: 220, height: 44, visible: true },
      { id: 'restart', kind: 'button', text: 'Restart', assetId: '', action: 'Restart', position: 'bottom-center', offsetX: 0, offsetY: 0, color: '#fff', backgroundColor: '#135', fontSize: 18, width: 120, height: 44, visible: true },
    ] }),
    component('component:listener', 'haiyue.audio.listener', { active: true, spatial: true, masterGain: 0.8, dopplerFactor: 1, speedOfSound: 343.3 }),
  ] }, { id: 'entity:piece', components: [] }]);

  const tick3 = runtime.snapshot(3);
  assert.equal(tick3.hud[0].text, 'Score 12 / Lines 4');
  assert.equal(tick3.hud[1].action, 'Restart');
  assert.deepEqual(tick3.audioListener, { componentId: 'component:listener', entityId: 'entity:game', spatial: true, masterGain: 0.8, dopplerFactor: 1, speedOfSound: 343.3 });
  const game = tick3.observations.find((entry) => entry.id === 'game');
  assert.deepEqual(game.value, { state: 'playing', score: 12, health: 3, maxHealth: 5, checkpoint: 'room-2', counters: [{ id: 'lines', value: 4 }], flags: [{ id: 'boss', value: false }], events: [{ id: 'spawned', value: 'piece-7' }] });
  const timers = tick3.observations.find((entry) => entry.id === 'timers').value;
  assert.deepEqual(timers.firedEvents, ['drop-piece']);
  assert.equal(timers.timers[0].remainingTicks, 0);
  assert.equal(timers.timers[0].fired, true);
  assert.equal(runtime.snapshot(6).observations.find((entry) => entry.id === 'timers').value.timers[1].completed, true);
  const advanced = runtime.advance(1, { pressedActions: ['HardDrop'] });
  assert.equal(advanced.observations.find((entry) => entry.id === 'game').value.score, 22);
  assert.equal(advanced.pools[0].activeCount, 2);
  assert.equal(advanced.hud[0].text, 'Score 22 / Lines 4');
  assert.deepEqual(advanced.observations.find((entry) => entry.id === 'rules').value.firedRules, ['hard-drop']);
  assert.ok(advanced.observations.find((entry) => entry.id === 'game').value.events.some((event) => event.id === 'hard-dropped'));
  assert.equal(runtime.advance(2, { pressedActions: ['HardDrop'] }).observations.find((entry) => entry.id === 'game').value.score, 22, 'once rules do not fire twice');
});

test('declarative projection fails closed on ambiguous HUD and audio ownership', () => {
  const hud = (id) => component(`component:${id}`, 'haiyue.ui.hud', { items: [{ id: 'score', kind: 'text', text: id, assetId: '', action: '', position: 'top-left', offsetX: 0, offsetY: 0, color: '#fff', backgroundColor: '#0008', fontSize: 16, width: 100, height: 30, visible: true }] });
  assert.throws(() => new DeclarativePlayRuntime([{ id: 'entity:a', components: [hud('a')] }, { id: 'entity:b', components: [hud('b')] }]), /hud-id-duplicate/u);
  const listener = (id) => component(`component:${id}`, 'haiyue.audio.listener', { active: true, spatial: true, masterGain: 1, dopplerFactor: 1, speedOfSound: 343.3 });
  assert.throws(() => new DeclarativePlayRuntime([{ id: 'entity:a', components: [listener('a')] }, { id: 'entity:b', components: [listener('b')] }]), /audio-listener-conflict/u);
});

test('disabled declarative components have no runtime projection', () => {
  const runtime = new DeclarativePlayRuntime([{ id: 'entity:game', components: [component('component:disabled', 'haiyue.gameplay.state', {}, false)] }]);
  assert.deepEqual(runtime.snapshot(0), { tick: 0, observations: [], hud: [], pools: [], audioListener: null });
});
