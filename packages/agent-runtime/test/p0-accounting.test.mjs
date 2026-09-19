import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskAccountingRegistry, UsageLedgerStore, M12_DEFAULT_PRICING_CATALOG } from '../dist/index.js';

function fixture(limits = {}) {
  let now = 0;
  const store = new UsageLedgerStore();
  const account = new TaskAccountingRegistry(store).open({ taskId: 'task:p0', now: () => now, pricingCatalog: M12_DEFAULT_PRICING_CATALOG,
    budget: { schemaVersion: 2, id: 'budget:p0', enforcement: 'hard', limits: { inputTokens: 200, outputTokens: 200, estimatedCostMicros: 10000, wallTimeMs: 1000, turns: 20, toolCalls: 20, repairIterations: 5, observationBytes: 10000, ...limits } } });
  function open(id, start = now) {
    return store.open({ taskId: 'task:p0', sessionId: `session:${id}`, turnId: `turn:${id}`, providerRequestDigest: null, startedAtMs: start });
  }
  function report(id, ledger, input, at, sequence = 1, extra = {}) {
    ledger.reconcile({ eventId: `${id}:${sequence}`, sequence, mode: 'cumulative', inputTokens: input, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, observedAtMs: at, ...extra });
    account.bindTurn(`turn:${id}`, { provider: 'deepseek', model: 'deepseek-v4-flash', billingMode: 'api' });
  }
  return { store, account, open, report, set now(value) { now = value; } };
}

test('P0 reported usage replaces its exact reservation even with an unknown sibling', () => {
  const f = fixture();
  assert.equal(f.account.reserveWork('work:a', { inputTokens: 100 }), true);
  assert.equal(f.account.reserveWork('work:b', { inputTokens: 100 }), true);
  const a = f.open('a'), b = f.open('b');
  assert.equal(f.account.bindWork('work:a', 'turn:a'), true);
  assert.equal(f.account.bindWork('work:b', 'turn:b'), true);
  f.report('a', a, 50, 10);
  assert.equal(f.account.snapshot().usage.inputTokens, null, 'audit must preserve unknown usage');
  assert.equal(f.account.snapshot().consumption.inputTokens, 50, 'known sibling still counts');
  assert.deepEqual(f.account.reservedWork(), { inputTokens: 150 });
  assert.equal(f.account.beginTurn().allowed, true);
  f.report('a', a, 50, 10); // duplicate
  f.report('a', a, 25, 5, 0); // out-of-order
  assert.equal(f.account.reservedWork().inputTokens, 150);
  f.report('a', a, 40, 20, 2); // provider correction
  assert.equal(f.account.reservedWork().inputTokens, 160);
  assert.equal(f.account.beginTurn().allowed, true);
  f.report('b', b, 100, 25);
  f.report('a', a, 101, 30, 3);
  assert.equal(f.account.beginTurn().allowed, false, 'real excess still latches');
  assert.equal(f.account.snapshot().budgetDecision.hardStopLatched, true);
});

test('P0 lease identity and known-final settlement cannot cross turns', () => {
  const f = fixture();
  f.open('parent');
  f.account.reserveWork('work:a', { inputTokens: 100, outputTokens: 20, estimatedCostMicros: 100 });
  f.account.reserveWork('work:b', { inputTokens: 100 });
  const a = f.open('a'), b = f.open('b');
  assert.equal(f.account.bindWork('work:a', 'turn:parent'), false);
  assert.equal(f.account.bindWork('work:a', 'turn:missing'), false);
  assert.equal(f.account.bindWork('work:a', 'turn:a'), true);
  assert.equal(f.account.bindWork('work:b', 'turn:a'), false);
  assert.equal(f.account.bindWork('work:a', 'turn:b'), false);
  f.account.bindWork('work:b', 'turn:b');
  f.report('a', a, 20, 10, 1, { outputTokens: 5, final: true });
  assert.equal(f.account.reservedWork().outputTokens, 15);
  assert.equal(f.account.reservedWork().estimatedCostMicros, 100 - f.account.snapshot().consumption.estimatedCostMicros);
  assert.equal(f.account.settleWork('work:a', 'turn:a'), false, 'provider final cannot precede actual exit');
  a.markTerminal('error', 20);
  assert.equal(f.account.settleWork('work:b', 'turn:a'), false);
  assert.equal(f.account.settleWork('work:a', 'turn:a'), true);
  assert.equal(f.account.settleWork('work:a', 'turn:a'), false);
  b.markTerminal('cancelled', 20);
  f.account.releaseUnstartedWork('work:b');
  assert.equal(f.account.settleWork('work:b', 'turn:b'), false, 'unknown cannot refund');
  assert.equal(f.account.reservedWork().inputTokens, 100);
});

test('P0 cache credits remain per-turn and incomplete pricing retains only its remaining commitment', () => {
  const f = fixture();
  f.account.reserveWork('work:a', { inputTokens: 100, estimatedCostMicros: 100 });
  const a = f.open('a'); f.account.bindWork('work:a', 'turn:a');
  f.report('a', a, 90, 10, 1, { cachedInputTokens: 50, cacheWriteTokens: 10 });
  const charged = f.account.snapshot().consumption;
  assert.equal(charged.inputTokens, 30);
  assert.equal(charged.inputTokens + f.account.reservedWork().inputTokens, 100);
  f.report('a', a, null, 20, 2, { outputTokens: null, reasoningTokens: null });
  a.markTerminal('error', 20);
  assert.equal(f.account.settleWork('work:a', 'turn:a'), false);
  assert.equal(f.account.snapshot().consumption.inputTokens, 30, 'missing correction cannot erase known charges');
  assert.equal(f.account.reservedWork().inputTokens, 70);
  assert.equal(f.account.snapshot().cost.amountMicros, null);
});

test('P0 task time is the union of parallel/serial active intervals, excluding nested human waits', () => {
  const f = fixture();
  const parent = f.open('parent', 0), a = f.open('a', 0), b = f.open('b', 0);
  for (const [id, l] of [['parent', parent], ['a', a], ['b', b]]) { f.report(id, l, 0, 100); l.markTerminal('stop', 100); }
  assert.equal(f.account.reconcile().consumption.wallTimeMs, 100);
  assert.equal(f.store.snapshots().reduce((s, l) => s + l.record.wallTimeMs, 0), 300, 'per-turn work is still auditable');
  const next = f.open('next', 200);
  next.pauseWallTime(230); next.pauseWallTime(240); next.resumeWallTime(500); next.resumeWallTime(600);
  next.markTerminal('stop', 620);
  assert.equal(f.account.reconcile().consumption.wallTimeMs, 150);
  f.report('next', next, 0, 10000); // late billing cannot grow elapsed time
  assert.equal(f.account.reconcile().consumption.wallTimeMs, 150);
});

test('P0 out-of-order events cannot shrink an active interval', () => {
  const f = fixture(), a = f.open('a');
  f.report('a', a, 10, 100, 2);
  f.report('a', a, 5, 20, 1);
  assert.equal(f.account.snapshot().consumption.wallTimeMs, 100);
});

test('P0 Host scope counts preparation/tool gaps, pauses, continuation and drain exactly once', () => {
  const f = fixture(), scope = f.account.trackWallTime();
  f.now = 20; const parent = f.open('parent');
  f.report('parent', parent, 0, 80); parent.markTerminal('stop', 80);
  f.now = 100; scope.pause(); scope.pause();
  f.now = 200; scope.resume(); assert.equal(f.account.snapshot().consumption.wallTimeMs, 100);
  f.now = 300; scope.resume(); f.now = 350; scope.dispose(); scope.dispose();
  assert.equal(f.account.snapshot().consumption.wallTimeMs, 150);
  f.now = 400; const continuation = f.account.trackWallTime();
  f.now = 420; continuation.dispose();
  assert.equal(f.account.snapshot().consumption.wallTimeMs, 170);
});

test('P0 batch reserves one bounded elapsed interval and settles wall time even with unknown billing', () => {
  const f = fixture({ wallTimeMs: 100 }), close = f.account.reserveWallTime('wall:batch', 100);
  assert.equal(typeof close, 'function');
  f.now = 50;
  assert.equal(f.account.reservedWork().wallTimeMs, 50);
  assert.equal(f.account.snapshot().consumption.wallTimeMs, 50);
  assert.equal(f.account.beginTurn().allowed, true);
  f.now = 100; close(); close();
  assert.deepEqual(f.account.reservedWork(), {});
  assert.equal(f.account.snapshot().consumption.wallTimeMs, 100);
  const scope = f.account.trackWallTime(); f.now = 101;
  assert.equal(f.account.beginTurn().allowed, false);
  scope.dispose();
});
