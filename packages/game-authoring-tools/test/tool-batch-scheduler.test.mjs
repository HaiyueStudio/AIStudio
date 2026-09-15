import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GAME_AUTHORING_TOOL_DEFINITIONS,
  ToolBatchProtocolError,
  ToolBatchScheduler,
  RollingToolBatchScheduler,
  isProjectIndependentRead,
  classifyToolConcurrency,
  normalizeToolBatchRequest,
  validateToolBatchRequest,
} from '../dist/index.js';

const ids = Object.freeze({ sessionId: 'session:test', turnId: 'turn:test' });

function batch(calls, options = {}) {
  return normalizeToolBatchRequest({
    id: options.id ?? 'batch:test', ...ids, calls,
    maxConcurrency: options.maxConcurrency ?? 4,
    maxResultBytes: options.maxResultBytes ?? 1024 * 1024,
    createdAt: '2026-09-01T00:00:00.000Z',
  }, GAME_AUTHORING_TOOL_DEFINITIONS);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

test('registry classification only parallelizes explicitly safe observations and fails closed', () => {
  assert.ok(GAME_AUTHORING_TOOL_DEFINITIONS.every((definition) => typeof definition.concurrencySafe === 'boolean'));
  const query = GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'scene.query');
  const input = GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'play.input');
  assert.equal(classifyToolConcurrency(query, {}).executionClass, 'parallel-read');
  assert.equal(classifyToolConcurrency(input, {}).executionClass, 'runtime-barrier');
  assert.equal(classifyToolConcurrency(undefined, {}).executionClass, 'unknown-exclusive');
});

test('normalization ignores spoofed scheduling metadata and keeps contract ids bounded', () => {
  const longCallId = `call:${'x'.repeat(123)}`;
  const request = batch([{ toolCallId: longCallId, toolId: 'camera.set', arguments: { camera: {} }, executionClass: 'parallel-read', effects: ['observe'] }]);
  assert.equal(request.nodes[0].executionClass, 'exclusive-mutation');
  assert.deepEqual(request.nodes[0].effects, ['document-mutation']);
  assert.ok(request.nodes[0].id.length <= 128);
  assert.throws(() => normalizeToolBatchRequest({ id: 'batch:test', ...ids, calls: [{ toolCallId: 'call:one', toolId: 'scene.query' }], createdAt: 'not-a-timestamp' }, GAME_AUTHORING_TOOL_DEFINITIONS), (error) => error.code === 'tool-batch.timestamp-invalid');
});

test('parallel reads use a rolling pool and wall time follows the slowest body', async () => {
  const request = batch([
    { toolCallId: 'call:scene', toolId: 'scene.query' },
    { toolCallId: 'call:diagnostics', toolId: 'diagnostics.query' },
    { toolCallId: 'call:assets', toolId: 'asset.search' },
  ], { maxConcurrency: 3 });
  let active = 0; let maxActive = 0;
  const started = Date.now();
  const result = await new ToolBatchScheduler().execute(request, async (node, signal) => {
    active += 1; maxActive = Math.max(maxActive, active);
    await delay(node.toolId === 'scene.query' ? 90 : 70, signal); active -= 1;
    return { status: 'completed', value: { toolId: node.toolId } };
  });
  const elapsed = Date.now() - started;
  assert.equal(maxActive, 3);
  assert.equal(result.summary.maxConcurrencyObserved, 3);
  assert.ok(elapsed < 180, `parallel batch unexpectedly took ${elapsed}ms`);
});

test('exclusive barriers do not overlap reads and later reads wait for the barrier', async () => {
  const request = batch([
    { toolCallId: 'call:read-a', toolId: 'scene.query' },
    { toolCallId: 'call:read-b', toolId: 'diagnostics.query' },
    { toolCallId: 'call:write', toolId: 'camera.set', arguments: { camera: {} } },
    { toolCallId: 'call:read-c', toolId: 'camera.get' },
  ]);
  const events = [];
  await new ToolBatchScheduler().execute(request, async (node, signal) => {
    events.push(`start:${node.toolCallId}`); await delay(node.toolCallId === 'call:write' ? 10 : 25, signal); events.push(`end:${node.toolCallId}`);
    return { status: 'completed', value: { ok: true } };
  });
  const writeStart = events.indexOf('start:call:write');
  assert.ok(events.indexOf('end:call:read-a') < writeStart);
  assert.ok(events.indexOf('end:call:read-b') < writeStart);
  assert.ok(events.indexOf('end:call:write') < events.indexOf('start:call:read-c'));
});

test('cycle validation includes model dependencies and implicit barrier ordering', () => {
  assert.throws(() => batch([
      { toolCallId: 'call:write', toolId: 'camera.set', arguments: { camera: {} }, dependsOn: ['call:read'] },
      { toolCallId: 'call:read', toolId: 'scene.query' },
    ]), (error) => error instanceof ToolBatchProtocolError && error.code === 'tool-batch.cycle');
});

test('body completion may be out of order while committed outcomes and digest remain deterministic', async () => {
  const committed = [];
  const request = batch([
    { toolCallId: 'call:slow', toolId: 'scene.query' },
    { toolCallId: 'call:fast', toolId: 'diagnostics.query' },
  ]);
  const run = () => new ToolBatchScheduler({ hooks: { onNodeCommitted: (_request, outcome) => committed.push(outcome.node.toolCallId) } }).execute(request, async (node, signal) => {
    await delay(node.toolCallId === 'call:slow' ? 50 : 5, signal);
    return { status: 'completed', value: { id: node.toolCallId } };
  });
  const first = await run(); const second = await run();
  assert.deepEqual(first.outcomes.map((item) => item.node.toolCallId), ['call:slow', 'call:fast']);
  assert.ok(first.outcomes[0].completionOrdinal > first.outcomes[1].completionOrdinal);
  assert.deepEqual(committed, ['call:slow', 'call:fast', 'call:slow', 'call:fast']);
  assert.equal(first.summary.resultDigest, second.summary.resultDigest);
});

test('failure cancels transitive dependents but independent work continues', async () => {
  const request = batch([
    { toolCallId: 'call:fail', toolId: 'scene.query' },
    { toolCallId: 'call:independent', toolId: 'diagnostics.query' },
    { toolCallId: 'call:dependent', toolId: 'asset.search', dependsOn: ['call:fail'] },
  ]);
  const executed = [];
  const result = await new ToolBatchScheduler().execute(request, async (node) => {
    executed.push(node.toolCallId);
    if (node.toolCallId === 'call:fail') throw new Error('expected');
    return { status: 'completed', value: { ok: true } };
  });
  assert.deepEqual(executed.sort(), ['call:fail', 'call:independent']);
  assert.deepEqual(result.outcomes.map((item) => item.status), ['failed', 'completed', 'cancelled']);
  assert.equal(result.outcomes[2].diagnostic.code, 'tool-batch.dependency-failed');
});

test('stop-batch failure aborts active peers and cancels pending nodes', async () => {
  const request = batch([
    { toolCallId: 'call:stop', toolId: 'scene.query', onFailure: 'stop-batch' },
    { toolCallId: 'call:peer', toolId: 'diagnostics.query' },
    { toolCallId: 'call:pending', toolId: 'asset.search', dependsOn: ['call:peer'] },
  ]);
  const result = await new ToolBatchScheduler().execute(request, async (node, signal) => {
    if (node.toolCallId === 'call:stop') throw new Error('stop');
    await delay(500, signal);
    return { status: 'completed', value: {} };
  });
  assert.deepEqual(result.outcomes.map((item) => item.status), ['failed', 'cancelled', 'cancelled']);
});

test('external cancellation and node timeout settle with bounded outcomes', async () => {
  const request = batch([{ toolCallId: 'call:slow', toolId: 'scene.query' }]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('user-cancel')), 10);
  const cancelled = await new ToolBatchScheduler().execute(request, async (_node, signal) => { await delay(500, signal); return { status: 'completed', value: {} }; }, controller.signal);
  assert.equal(cancelled.outcomes[0].status, 'cancelled');

  const timeoutStarted = Date.now();
  const timedOut = await new ToolBatchScheduler({ nodeTimeoutMs: () => 10 }).execute(request, async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return { status: 'completed', value: {} }; });
  assert.equal(timedOut.outcomes[0].status, 'cancelled');
  assert.equal(timedOut.outcomes[0].diagnostic.code, 'tool-batch.node-timeout');
  assert.ok(Date.now() - timeoutStarted < 80, 'scheduler timeout must not trust an executor to observe AbortSignal');
});

test('batch output limit is enforced and digest-only projection remains bounded', async () => {
  const request = batch([
    { toolCallId: 'call:digest', toolId: 'diagnostics.query', outputProjection: 'digest-only' },
    { toolCallId: 'call:full', toolId: 'scene.query' },
  ], { maxResultBytes: 200 });
  const result = await new ToolBatchScheduler().execute(request, async () => ({ status: 'completed', value: { text: 'x'.repeat(256) } }));
  assert.deepEqual(Object.keys(result.outcomes[0].value).sort(), ['byteLength', 'digest']);
  assert.equal(result.outcomes[1].status, 'failed');
  assert.equal(result.outcomes[1].diagnostic.code, 'tool-batch.result-limit');
});

for (const mode of ['batch', 'rolling']) {
  async function run(calls, body) {
    const request = batch(calls);
    if (mode === 'batch') { const result = await new ToolBatchScheduler().execute(request, body); assert.ok(result.outcomes.every(item => item.status === 'completed')); return result; }
    const scheduler = new RollingToolBatchScheduler({ maxWallTimeMs: 2000, cancelled: (_node, diagnostic) => ({ status: 'cancelled', value: { diagnostic } }) });
    try { const result = await Promise.all(request.nodes.map(node => scheduler.enqueue(node, signal => body(node, signal)))); assert.ok(result.every(item => item.status === 'completed')); return result; }
    finally { await scheduler.drain(); }
  }
  for (const reverse of [false, true]) test(`${mode}: registry read and scene mutation overlap in either order (${reverse})`, async () => {
    const calls = [{ toolCallId: 'call:write', toolId: 'entity.create' }, { toolCallId: 'call:docs', toolId: 'engine.docs.search' }];
    if (reverse) calls.reverse();
    const started = [];
    let release; const bothStarted = new Promise(resolve => { release = resolve; });
    let overlapped = true;
    const timeout = setTimeout(() => { overlapped = false; release(); }, 800);
    try {
      await run(calls, async node => {
        started.push(node.toolId); if (started.length === 2) release();
        await bothStarted;
        assert.equal(started.length, 2, 'a registry read must start before the mutation finishes');
        return { status: 'completed', value: {} };
      });
      assert.equal(started.length, 2);
      assert.equal(overlapped, true);
    } finally { clearTimeout(timeout); }
  });
  for (const barrier of ['script.apply', 'preview.start', 'unknown.tool', 'entity.create-many']) test(`${mode}: static reads respect ${barrier} barrier`, async () => {
    const events = [];
    await run([{ toolCallId: 'call:barrier', toolId: barrier }, { toolCallId: 'call:docs', toolId: 'engine.docs.search' }], async (node, signal) => {
      events.push(`start:${node.toolId}`); await delay(5, signal); events.push(`end:${node.toolId}`);
      return { status: 'completed', value: {} };
    });
    assert.deepEqual(events, [`start:${barrier}`, `end:${barrier}`, 'start:engine.docs.search', 'end:engine.docs.search']);
  });
  test(`${mode}: explicit documentation dependency remains ordered`, async () => {
    let written = false;
    await run([{ toolCallId: 'call:write', toolId: 'entity.create' }, { toolCallId: 'call:docs', toolId: 'engine.docs.search', dependsOn: ['call:write'] }], async (node, signal) => {
      if (node.toolId === 'entity.create') { await delay(5, signal); written = true; } else assert.equal(written, true);
      return { status: 'completed', value: {} };
    });
  });
}

test('independent reads remain registry-limited and revision assertions forbid crossing writes', () => {
  for (const toolId of ['engine.docs.search', 'engine.docs.read', 'tool.search', 'component.describe']) {
    const node = batch([{ toolCallId: 'call:docs', toolId }]).nodes[0];
    assert.equal(isProjectIndependentRead(node), true);
    assert.equal(isProjectIndependentRead({ ...node, expectedRevision: 1 }), false);
    assert.equal(isProjectIndependentRead({ ...node, arguments: { baseRevision: 1 } }), false);
  }
  for (const toolId of ['scene.query', 'asset.search', 'project.snapshot', 'play.inspect']) assert.equal(isProjectIndependentRead(batch([{ toolCallId: 'call:state', toolId }]).nodes[0]), false);
  const definition = GAME_AUTHORING_TOOL_DEFINITIONS.find(item => item.id === 'engine.docs.search');
  assert.equal(classifyToolConcurrency({ ...definition, requiresApproval: true }, {}).executionClass, 'approval-barrier');
  // A forward dependency on a static read no longer creates a spurious barrier cycle.
  assert.doesNotThrow(() => batch([{ toolCallId: 'call:write', toolId: 'entity.create', dependsOn: ['call:docs'] }, { toolCallId: 'call:docs', toolId: 'engine.docs.search' }]));
});
