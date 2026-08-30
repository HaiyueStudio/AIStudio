import assert from 'node:assert/strict';
import test from 'node:test';
import { GameplayObservationStore } from '../dist/gameplay-observation-store.js';

const owner = Object.freeze({ scriptId: 'script:controller', entityId: 'entity:controller' });

test('gameplay observations are canonical, owner-scoped and replace atomically', () => {
  const store = new GameplayObservationStore();
  store.set(owner, 'game', { score: 1, status: 'playing', nested: { z: 2, a: true } });
  store.set({ scriptId: 'script:hud', entityId: 'entity:hud' }, 'game', { visible: true });
  store.set(owner, 'game', { score: 2, events: ['line-cleared'] });
  assert.deepEqual(store.snapshot(), [
    { scriptId: 'script:controller', entityId: 'entity:controller', id: 'game', value: { events: ['line-cleared'], score: 2 } },
    { scriptId: 'script:hud', entityId: 'entity:hud', id: 'game', value: { visible: true } },
  ]);
  store.remove(owner, 'game');
  assert.equal(store.snapshot().length, 1);
  store.clear();
  assert.equal(store.snapshot().length, 0);
});

test('gameplay observations reject unsafe, non-JSON and unbounded values', () => {
  const store = new GameplayObservationStore();
  assert.throws(() => store.set(owner, '../bad', {}), /id must contain/u);
  assert.throws(() => store.set(owner, 'nan', { value: Number.NaN }), /finite/u);
  assert.throws(() => store.set(owner, 'class', new Date()), /plain objects/u);
  assert.throws(() => store.set(owner, 'large', { text: 'x'.repeat(2_049) }), /at most 2048/u);
  assert.throws(() => store.set(owner, 'prototype', { constructor: 'bad' }), /key is invalid/u);
});
