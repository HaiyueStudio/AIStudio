import assert from 'node:assert/strict';
import test from 'node:test';
import { EffectLockManager, effectLockKeys } from '../dist/index.js';

test('effect locks allow disjoint owners, serialize conflicts fairly and release idempotently', async () => {
  let now = 10;
  const locks = new EffectLockManager(() => now);
  const first = await locks.acquire('owner:first', ['entity:first']);
  const disjoint = await locks.acquire('owner:disjoint', ['entity:second']);
  const order = [];
  const secondPromise = locks.acquire('owner:second', ['entity:first']).then((lease) => { order.push('second'); return lease; });
  const thirdPromise = locks.acquire('owner:third', ['entity:first']).then((lease) => { order.push('third'); return lease; });
  assert.deepEqual(locks.snapshot(), { heldOwners: 2, heldKeys: 2, waiting: 2, acquisitions: 2, conflicts: 2, cancelledWaits: 0 });
  now = 25; first.release(); first.release();
  const second = await secondPromise;
  assert.deepEqual(order, ['second']);
  second.release();
  const third = await thirdPromise;
  assert.deepEqual(order, ['second', 'third']);
  assert.equal(second.waitMs, 15);
  third.release(); disjoint.release();
  assert.equal(locks.snapshot().heldOwners, 0);
});

test('global lock conflicts with every key and cancelled wait leaves no lease', async () => {
  const locks = new EffectLockManager();
  const held = await locks.acquire('owner:held', ['entity:first']);
  const controller = new AbortController();
  const waiting = locks.acquire('owner:global', ['effect:global'], controller.signal);
  controller.abort(new Error('cancel fixture'));
  await assert.rejects(waiting, /cancel fixture/);
  assert.equal(locks.snapshot().cancelledWaits, 1);
  assert.equal(locks.snapshot().waiting, 0);
  held.release();
  const global = await locks.acquire('owner:global-next', ['effect:global']);
  let disjointResolved = false;
  const disjoint = locks.acquire('owner:blocked', ['entity:other']).then((lease) => { disjointResolved = true; return lease; });
  await Promise.resolve(); assert.equal(disjointResolved, false);
  global.release(); (await disjoint).release();
});

test('execution classes expand to safe canonical lock sets', () => {
  assert.deepEqual(effectLockKeys('exclusive-mutation', ['entity:one']), ['document:current', 'entity:one']);
  assert.deepEqual(effectLockKeys('runtime-barrier', ['runtime:preview']), ['runtime:preview']);
  assert.deepEqual(effectLockKeys('unknown-exclusive', ['tool:unknown']), ['effect:global']);
  assert.deepEqual(effectLockKeys('parallel-read', ['entity:one']), []);
});

test('cross-batch and cross-turn owners share exact component, script, runtime and global barriers', async () => {
  const locks = new EffectLockManager();
  const mutationA = await locks.acquire('owner:batch-a:turn-a', ['component:player', 'script:controller']);
  let conflictingResolved = false; let disjointResolved = false;
  const conflicting = locks.acquire('owner:batch-b:turn-b', ['script:controller', 'component:player']).then((lease) => { conflictingResolved = true; return lease; });
  const disjoint = locks.acquire('owner:batch-c:turn-c', ['entity:background']).then((lease) => { disjointResolved = true; return lease; });
  await Promise.resolve();
  assert.equal(conflictingResolved, false); assert.equal(disjointResolved, true);
  (await disjoint).release(); mutationA.release(); (await conflicting).release();

  const trusted = await locks.acquire('owner:trusted:turn-d', effectLockKeys('trusted-code-barrier', ['script:controller']));
  let documentMutationResolved = false;
  const documentMutation = locks.acquire('owner:mutation:turn-e', effectLockKeys('exclusive-mutation', ['entity:player'])).then((lease) => { documentMutationResolved = true; return lease; });
  await Promise.resolve(); assert.equal(documentMutationResolved, false);
  trusted.release(); (await documentMutation).release();

  const runtime = await locks.acquire('owner:runtime:turn-f', effectLockKeys('runtime-barrier', ['runtime:preview']));
  let runtimeMutationResolved = false;
  const runtimeMutation = locks.acquire('owner:runtime-mutation:turn-g', effectLockKeys('exclusive-mutation', ['runtime:preview'])).then((lease) => { runtimeMutationResolved = true; return lease; });
  await Promise.resolve(); assert.equal(runtimeMutationResolved, false);
  runtime.release(); (await runtimeMutation).release();

  const global = await locks.acquire('owner:global:turn-h', effectLockKeys('unknown-exclusive', ['tool:unknown']));
  let anyResolved = false;
  const any = locks.acquire('owner:any:turn-i', ['entity:any']).then((lease) => { anyResolved = true; return lease; });
  await Promise.resolve(); assert.equal(anyResolved, false);
  global.release(); (await any).release();
  assert.equal(locks.snapshot().heldOwners, 0); assert.equal(locks.snapshot().waiting, 0);
});
