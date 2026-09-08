import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBehavior, instrumentBehaviorScripts, createBehaviorRuntimePlan, BehaviorRuntimeRecorder, parseBehaviorRuntimePlan, sealBehaviorRuntimeCapture, assertBehaviorCaptureProgress, associateBehaviorTrace } from '../dist/behavior/index.js';
import { makeInput, declarativeInput, clone } from './behavior-fixtures.mjs';

function fixture(source, input = makeInput({ script: source })) {
  const manifest = analyzeBehavior(input), programs = instrumentBehaviorScripts(input, manifest);
  const plan = createBehaviorRuntimePlan(input, manifest, { playId: 'play:runtime', generation: 1, scripts: programs.map(p => ({ scriptId: p.scriptId, emittedText: p.originalEmittedText })) });
  const recorder = new BehaviorRuntimeRecorder(plan);
  const code = programs[0]?.originalEmittedText;
  const run = code === undefined ? null : recorder.compiler(() => 'script:main')(code, { component: {}, lifecycle: 'onUpdate', sourceUrl: 'behavior-fixture.js' });
  const original = code === undefined ? null : new Function('entity','component','world','time','delta','event','api', code);
  return { input, manifest, programs, plan, recorder, run, original };
}
const args = api => [null,null,null,10,1,null,api];
const executedSource = (f, kind) => f.recorder.snapshot().events.filter(e => e.kind === kind && e.nodeId).map(e => { const n = f.manifest.nodes.find(n => n.id === e.nodeId); return f.input.document.scripts[0].source.slice(n.source.range.start, n.source.range.end); });

test('instrumented execution preserves receivers, assignments, short circuit, directives, arguments and actual branches', () => {
  const source = `"use strict";
    const seen = []; let count = 0;
    const object = { value: 4, method() { return this.value; } };
    function condition() { count++; return api.flag; }
    if (condition()) seen.push(object.method()); else seen.push(-1);
    for (let i = 0; i < 3; i++) { if (i === 1) continue; seen.push(i); }
    let other = 0; while (other < 2) other++; do { other--; } while (other > 0);
    const missing = null; missing?.method(seen.push('bad'));
    const computed = false && seen.push('bad');
    let changed = 1; changed += 3; object.value++;
    return { seen, count, other, changed, value: object.value, strict: this === undefined, argc: arguments.length, computed };`;
  for (const flag of [true, false]) {
    const f = fixture(source); f.recorder.beginTick(1, 0);
    assert.deepEqual(f.run(...args({ flag })), f.original(...args({ flag })));
    const entered = executedSource(f, 'node-enter');
    assert.equal(entered.filter(s => s === 'condition()').length, 2, 'call and resulting condition are both observed');
    assert.equal(entered.some(s => s === "seen.push('bad')"), false);
    assert.equal(entered.includes('object.method()'), flag);
    assert.ok(f.recorder.snapshot().events.some(e => e.stateDiff?.truthy === false));
    assert.ok(f.recorder.snapshot().events.some(e => e.durationMicros !== null));
  }
});

test('real asynchronous resumes, thrown expressions and late callbacks retain execution semantics and Play ownership', async () => {
  const source = `async function first() { await api.gate; api.seen.push('resumed'); return 7; }
    api.callback = () => api.seen.push('callback');
    return first();`;
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(source), api = { gate, seen: [] }; f.recorder.beginTick(1, 0);
  const pending = f.run(...args(api));
  assert.equal(executedSource(f, 'node-exit').includes('await api.gate'), false);
  f.recorder.beginTick(2, 1); release(); assert.equal(await pending, 7);
  assert.deepEqual(api.seen, ['resumed']);
  const awaited = f.manifest.nodes.find(n => n.kind === 'await');
  assert.equal(f.recorder.snapshot().events.find(e => e.nodeId === awaited.id && e.kind === 'node-exit').tick, 2);
  api.callback(); assert.ok(executedSource(f, 'node-enter').some(s => s.includes("=> api.seen.push('callback')")));
  f.recorder.close(); const closed = f.recorder.snapshot(); api.callback();
  assert.deepEqual(f.recorder.snapshot(), closed, 'closed recorder cannot publish late callback rows');
  const thrown = fixture('api.fail(); api.unreachable();');
  const error = new Error('private user message');
  assert.throws(() => thrown.run(...args({ fail() { throw error; } })), e => e === error);
  assert.ok(thrown.recorder.snapshot().events.some(e => e.kind === 'error'));
  assert.equal(JSON.stringify(thrown.recorder.snapshot()).includes(error.message), false);
  assert.equal(executedSource(thrown, 'node-exit').includes('api.fail()'), false);
  assert.equal(executedSource(thrown, 'node-enter').includes('api.unreachable()'), false);
});

test('ambiguous static finally copies do not select an invented completion path', () => {
  const source = 'function run() { try { if (api.flag) return 1; api.work(); } finally { api.cleanup(); } return 2; } return run();';
  const f = fixture(source), copies = f.manifest.nodes.filter(n => n.kind === 'call' && source.slice(n.source.range.start, n.source.range.end) === 'api.cleanup()');
  assert.ok(copies.length > 1);
  for (const flag of [true, false]) {
    let cleanups = 0; assert.equal(f.run(...args({ flag, work() {}, cleanup() { cleanups++; } })), flag ? 1 : 2); assert.equal(cleanups, 1);
  }
  assert.equal(f.recorder.snapshot().events.some(e => copies.some(n => n.id === e.nodeId)), false);
});

test('overlapping async calls do not invent per-invocation durations when completion order differs', async () => {
  const f = fixture('async function wait(gate) { await gate; return 1; } return Promise.all([wait(api.a), wait(api.b)]);');
  let a, b; const api = { a: new Promise(resolve => { a = resolve; }), b: new Promise(resolve => { b = resolve; }) };
  const pending = f.run(...args(api)); a(); await Promise.resolve(); b(); assert.deepEqual(await pending, [1, 1]);
  const node = f.manifest.nodes.find(n => n.kind === 'await');
  const exits = f.recorder.snapshot().events.filter(e => e.nodeId === node.id && e.kind === 'node-exit');
  assert.equal(exits.length, 2); assert.ok(exits.every(e => e.durationMicros === null));
});

test('reached call expressions do not claim completion when an argument throws; Engine failures retain a redacted owner', () => {
  const f = fixture('function never(value) { return value; } never(api.fail());');
  assert.throws(() => f.run(...args({ fail() { throw new Error('fixture'); } })));
  const entry = f.manifest.nodes.find(n => n.kind === 'entry' && n.label === 'function-entry');
  assert.equal(f.recorder.snapshot().events.some(e => e.nodeId === entry.id), false);
  assert.ok(executedSource(f, 'node-enter').includes('never(api.fail())'));
  assert.equal(executedSource(f, 'node-exit').includes('never(api.fail())'), false);
  f.recorder.recordError('script:main');
  assert.equal(f.recorder.snapshot().events.at(-1).event, 'runtime-error');
  assert.equal(f.recorder.snapshot().events.at(-1).scriptId, 'script:main');
});

test('actual declarative result snapshots map timers, rules and state to config fields without script or adapter inventions', () => {
  const f = fixture('', declarativeInput()), timer = f.plan.components.find(c => c.type === 'haiyue.gameplay.timers'), rules = f.plan.components.find(c => c.type === 'haiyue.gameplay.rules'), state = f.plan.components.find(c => c.type === 'haiyue.gameplay.state');
  const item = (c, value) => ({ owner: { entityId: c.entityId, scriptId: c.id }, id: c.type, value });
  f.recorder.captureDeclarative({ tick: 0, observations: [item(state, { score: 0 })] }, false);
  f.recorder.beginTick(10, 2);
  f.recorder.captureDeclarative({ tick: 10, observations: [item(timer, { timers: [{ id: 'clock', fired: true }] }), item(rules, { firedRules: ['timer-rule'] }), item(state, { score: 1 })] }, true);
  f.recorder.capturePhysics([{ kind: 'collision', phase: 'enter', entityAId: 'entity:main', entityBId: 'entity:unknown' }]);
  const rows = f.recorder.snapshot().events;
  assert.equal(rows.filter(e => e.event === 'timer-fired').length, 1);
  assert.equal(rows.filter(e => e.event === 'rule-fired').length, 1);
  assert.equal(rows.filter(e => e.event === 'action-completed').length, 2);
  assert.ok(rows.some(e => e.kind === 'state-diff' && e.stateDiff.after === 1));
  assert.ok(rows.some(e => e.event === 'physics-collision-enter' && e.nodeId === null));
  assert.equal(rows.some(e => e.scriptId !== null), false);
  assert.equal(rows.some(e => f.manifest.nodes.find(n => n.id === e.nodeId)?.source.kind === 'runtime-adapter'), false);
});

test('bounded captures, rejected values, exact approved text and clock reset are explicit', () => {
  const f = fixture('for (let i=0;i<6000;i++) Math.sin(i);');
  f.recorder.beginTick(10, 3); f.run(...args({}));
  assert.equal(f.recorder.snapshot().events.length, 10000); assert.ok(f.recorder.snapshot().truncation.omittedAtLeast > 0);
  f.recorder.beginTick(0, 0); assert.equal(f.recorder.snapshot().closed, true);
  const g = fixture('return 1;');
  g.recorder.captureDeclarative({ tick: 0, observations: [], password: 'not-recorded-secret' }, true);
  assert.equal(JSON.stringify(g.recorder.snapshot()).includes('not-recorded-secret'), false);
  assert.equal(g.recorder.snapshot().events[0].kind, 'error');
  const hot = g.recorder.compiler(() => 'script:main')('return 2;', { component: {}, sourceUrl: 'fixture.js' });
  assert.equal(hot(...args({})), 2); assert.equal(g.recorder.snapshot().closed, true);
  assert.throws(() => createBehaviorRuntimePlan(g.input, g.manifest, { playId: 'play:test', generation: 1, scripts: [{ scriptId: 'script:main', emittedText: 'return 2;' }] }), /approved-text/);
  const bad = clone(g.plan); bad.nodes[0].entityId = 'entity:wrong'; assert.throws(() => parseBehaviorRuntimePlan(bad), /runtime-node/);
});

test('trusted ingress seals actual captures into the existing observation contract and rejects rewritten or foreign ownership', () => {
  const f = fixture('if (api.flag) Math.sin(time);'), metadata = { id: 'observation:fixture', taskId: 'task:fixture', turnId: 'turn:fixture', capturedAt: '2026-09-07T00:00:00Z', viewport: null, device: null, producerVersion: '0.0.0' };
  const seal = capture => sealBehaviorRuntimeCapture(f.plan, f.manifest, capture, metadata);
  f.recorder.beginTick(1, 0); f.run(...args({ flag: false }));
  const first = seal(f.recorder.snapshot()); assert.equal(first.closed, false);
  assert.equal(associateBehaviorTrace(first.artifact.observation, first.artifact.trace, f.manifest, f.plan).status, 'current');
  f.recorder.beginTick(2, 1); f.run(...args({ flag: true }));
  const second = seal(f.recorder.snapshot()); assertBehaviorCaptureProgress(first.artifact.trace, second.artifact.trace);
  assert.throws(() => assertBehaviorCaptureProgress(second.artifact.trace, first.artifact.trace), /capture-order/);
  const wrongOwner = clone(f.recorder.snapshot()); wrongOwner.events[0].nodeId = null; wrongOwner.events[0].kind = 'event'; wrongOwner.events[0].entityId = 'entity:wrong';
  assert.throws(() => seal(wrongOwner), /event-clock|event-owner/);
  const wrongPlay = clone(f.recorder.snapshot()); wrongPlay.generation++; assert.throws(() => seal(wrongPlay), /binding/);
  const wrongClock = clone(f.recorder.snapshot()); wrongClock.events.at(-1).tick = 0; assert.throws(() => seal(wrongClock), /event-clock/);
  const secret = clone(f.recorder.snapshot()); secret.events.at(-1).stateDiff = { password: 'rejected-fixture-value' }; assert.throws(() => seal(secret), /secret/);
  f.recorder.close(); assert.equal(seal(f.recorder.snapshot()).closed, true);
});
