import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_AUTHORING_TOOL_DEFINITIONS as definitions, resolveClosedToolBatch, RollingToolBatchScheduler, ToolBatchScheduler } from '../dist/index.js';
const coords = { id: 'batch:w6', sessionId: 'session:w6', turnId: 'turn:w6' };
const node = (id, dependsOn = [], overrides = {}) => ({ id, toolId: 'scene.query', toolVersion: definitions.find(d => d.id === 'scene.query').version, arguments: {}, dependsOn, estimatedWorkMs: 100, onFailure: 'cancel-dependents', ...overrides });
const resolve = nodes => resolveClosedToolBatch({ schemaVersion: 1, nodes }, coords, definitions);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('closed admission accepts forward dependencies, bounds concurrency and preserves input-order results', async () => {
  const { request, schedule } = resolve([node('read:dependent', ['read:slow']), node('read:fast'), node('read:slow')]);
  assert.equal(schedule.strategy, 'parallel'); assert.equal(schedule.nodes[0].reason, 'explicit-dependency');
  const scheduler = new RollingToolBatchScheduler({ maxConcurrency: request.maxConcurrency, cancelled: (_node, diagnostic) => ({ status: 'cancelled', value: diagnostic }) });
  scheduler.declare(request);
  let active = 0, peak = 0; const order = [];
  const work = request.nodes.map((n, i) => scheduler.enqueue(n, async () => {
    active++; peak = Math.max(peak, active); order.push(`start:${i}`);
    await delay(i === 2 ? 30 : 5); order.push(`end:${i}`); active--; return { status: 'completed', value: i };
  }));
  assert.deepEqual((await scheduler.drain()).map(x => x.value), [0, 1, 2]); await Promise.all(work);
  assert.equal(peak, 2); assert.ok(order.indexOf('end:2') < order.indexOf('start:0'));
});
test('unknown/negative benefit stays serial; effects, versions, cycles and model authority fail closed', () => {
  assert.equal(resolve([node('read:one', [], { estimatedWorkMs: null }), node('read:two')]).request.maxConcurrency, 1);
  assert.equal(resolve([node('read:one', [], { estimatedWorkMs: 1 }), node('read:two', [], { estimatedWorkMs: 1 })]).schedule.reason, 'no-estimated-benefit');
  for (const nodes of [[node('read:one', ['read:two']), node('read:two', ['read:one'])], [node('read:one', [], { toolVersion: '0.0.0' })], [node('read:one', [], { toolId: 'studio.tool.batch' })], [node('read:one', [], { toolId: 'script.apply', toolVersion: definitions.find(d => d.id === 'script.apply').version })], [node('read:one', [], { executionClass: 'parallel-read' })]]) assert.throws(() => resolve(nodes));
  const write = node('write:one', [], { toolId: 'entity.create', toolVersion: definitions.find(d => d.id === 'entity.create').version, arguments: { baseRevision: 1 } });
  assert.throws(() => resolve([node('read:one', ['write:one']), write]), /cycle/);
  assert.equal(resolve([write, node('read:two')]).schedule.nodes[1].reason, 'registry-effect-or-snapshot-barrier');
});
test('reverse dependency chains cancel after failure without deadlock in both schedulers', async () => {
  const { request } = resolve([node('read:third', ['read:second']), node('read:second', ['read:first']), node('read:first')]);
  const run = async () => ({ status: 'failed', value: { failure: true } });
  const execution = await new ToolBatchScheduler().execute(request, run);
  assert.deepEqual(execution.outcomes.map(x => x.status), ['cancelled', 'cancelled', 'failed']);
  const rolling = new RollingToolBatchScheduler({ cancelled: (_n, value) => ({ status: 'cancelled', value }) }); rolling.declare(request);
  request.nodes.forEach(n => rolling.enqueue(n, run));
  assert.deepEqual((await rolling.drain()).map(x => x.status), ['cancelled', 'cancelled', 'failed']);
});
test('incomplete admission never executes; stop-batch drains started bodies on failure and hook failure', async () => {
  const { request } = resolve([node('read:first'), node('read:second')]);
  const rolling = new RollingToolBatchScheduler({ cancelled: (_n, value) => ({ status: 'cancelled', value }) }); rolling.declare(request);
  let executed = 0; rolling.enqueue(request.nodes[0], async () => { executed++; return { status: 'completed', value: {} }; });
  assert.equal((await rolling.drain())[0].status, 'cancelled'); assert.equal(executed, 0);
  let exited = false;
  await assert.rejects(new ToolBatchScheduler({ hooks: { onNodeDispatched(_request, n) { if (n === request.nodes[1]) throw new Error('journal unavailable'); } } }).execute(request, async () => { await delay(20); exited = true; return { status: 'completed', value: {} }; }), /journal unavailable/);
  assert.ok(exited);
});

test('Host checkpoint stops unrelated queued nodes without a model failure policy', async () => {
  const { request } = resolve([node('read:first'), node('read:later')]);
  const scheduler = new RollingToolBatchScheduler({ maxConcurrency: 1, cancelled: (_n, value) => ({ status: 'cancelled', value }) });
  scheduler.declare(request);
  scheduler.enqueue(request.nodes[0], async () => ({ status: 'cancelled', value: { checkpoint: true }, stopBatch: true }));
  scheduler.enqueue(request.nodes[1], async () => assert.fail('A checkpoint must stop unrelated pending work'));
  const outcomes = await scheduler.drain();
  assert.equal(outcomes[0].value.checkpoint, true); assert.equal(outcomes[1].status, 'cancelled');
});
