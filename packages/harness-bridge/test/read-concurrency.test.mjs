import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessStudioRoot } from '../dist/index.js';
import { createPinnedHarnessAgentTransport, harnessToolName } from '../dist/harness-agent.js';

const parallel = { schemaVersion: 1, mode: 'parallel-read' };
const tools = [
  { id: 'scene.query', description: 'Read scene', inputSchema: { type: 'object' }, concurrency: parallel },
  { id: 'entity.create', description: 'Edit scene', inputSchema: { type: 'object' }, concurrency: { schemaVersion: 1, mode: 'exclusive' } },
  { id: 'studio.tool.invoke', description: 'Discovered tool', inputSchema: { type: 'object' }, concurrency: { schemaVersion: 1, mode: 'invoke', targets: [{ toolId: 'scene.query', toolVersion: '1.0.0' }] } },
  { id: 'unknown.tool', description: 'Unknown', inputSchema: { type: 'object' } },
];
const input = { sessionId: 'session:parallel', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 8192, prompt: 'Read independent data.', tools };
const call = (index, tool = 0, args = {}) => ({ index, id: `call-${index}`, type: 'function', function: { name: harnessToolName(tools[tool].id, tool), arguments: JSON.stringify(args) } });
const invoke = (toolId = 'scene.query', toolVersion = '1.0.0', extra = {}) => ({ toolId, toolVersion, arguments: {}, ...extra });
function response(calls) { return new Response(`data: ${JSON.stringify({ id: 'parallel-response', choices: [{ index: 0, delta: calls ? { content: 'inspecting', tool_calls: calls } : { content: 'done' }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }); }
async function waitFor(predicate) { const until = Date.now() + 4000; while (!predicate()) { if (Date.now() > until) throw new Error('Concurrent dispatch did not arrive before results were released.'); await delay(5); } }
async function fixture(t, calls, options = {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); return response(requests.length === 1 ? calls : null); });
  const owner = createHarnessStudioRoot();
  const transport = await createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => 'fixture-only', ...options });
  const events = [], arrivals = [];
  const running = (async () => { for await (const event of transport.start(input)) { events.push(event); if (event.type === 'tool-request') arrivals.push(event); } })();
  // Observe teardown failures without unhandled rejection while a test waits for arrivals.
  running.catch(() => {});
  t.after(async () => { await owner.dispose(); await running.catch(() => {}); });
  return { owner, transport, events, arrivals, requests, running, async release(index, result = { status: 'completed' }) { await transport.submitToolResult(`call-${index}`, result); } };
}

for (const cap of [1, 2, 4]) test(`real pinned Harness dispatch is bounded at ${cap} and commits out-of-order finishes in call order`, { timeout: 10000 }, async t => {
  const f = await fixture(t, Array.from({ length: 6 }, (_, i) => call(i)), { maxParallelToolCalls: cap });
  assert.equal(f.transport.sessionCapabilities(input.model).parallelToolCalls, cap > 1);
  for (let start = 0; start < 6; start += cap) {
    const end = Math.min(start + cap, 6);
    await waitFor(() => f.arrivals.length === end);
    await delay(20); assert.equal(f.arrivals.length, end, 'pool must not exceed cap while results are held');
    for (let i = end - 1; i >= start; i--) await f.release(i);
  }
  await f.running;
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].messages.filter(item => item.role === 'tool').map(item => item.tool_call_id), Array.from({ length: 6 }, (_, i) => `call-${i}`));
  assert.ok(f.requests[0].tools.every(tool => !JSON.stringify(tool).includes('concurrency')), 'host metadata is not a model-facing schema');
  assert.equal(f.events.at(-1).status, 'completed');
});

test('mutation and unknown tools are exclusive barriers between parallel reads', { timeout: 10000 }, async t => {
  const f = await fixture(t, [call(0), call(1), call(2, 1), call(3), call(4), call(5, 3), call(6)]);
  for (const wave of [[0, 1], [2], [3, 4], [5], [6]]) {
    const count = wave.at(-1) + 1;
    await waitFor(() => f.arrivals.length === count); await delay(20); assert.equal(f.arrivals.length, count);
    for (const index of [...wave].reverse()) await f.release(index);
  }
  await f.running;
});

test('invoke classifies exact targets; stale, forged, recursive and unknown targets stay exclusive', { timeout: 10000 }, async t => {
  const calls = [call(0, 2, invoke()), call(1), ...[invoke('entity.create'), invoke('scene.query', '0.0.0'), invoke('scene.query', '1.0.0', { concurrencySafe: true }), invoke('studio.tool.invoke'), invoke('missing.tool')].map((args, i) => call(i + 2, 2, args)), call(7)];
  const f = await fixture(t, calls);
  await waitFor(() => f.arrivals.length === 2); await delay(20); assert.equal(f.arrivals.length, 2);
  await f.release(1); await f.release(0);
  for (let i = 2; i < 8; i++) { await waitFor(() => f.arrivals.length === i + 1); await delay(20); assert.equal(f.arrivals.length, i + 1); await f.release(i, { status: i < 7 ? 'failed' : 'completed' }); }
  await f.running;
});

test('cancelling four in-flight reads drains the pool, skips queued calls and rejects late results', { timeout: 10000 }, async t => {
  const f = await fixture(t, Array.from({ length: 6 }, (_, i) => call(i)));
  await waitFor(() => f.arrivals.length === 4);
  await f.transport.cancel(input.sessionId); await f.running;
  assert.equal(f.arrivals.length, 4); assert.equal(f.events.at(-1).status, 'cancelled');
  for (let i = 0; i < 4; i++) await assert.rejects(f.release(i), /not pending/);
  const resumed = await Array.fromAsync(f.transport.start(input));
  assert.equal(resumed.at(-1).status, 'completed');
  assert.equal(resumed.at(-1).turnId, `${input.sessionId}:turn:2`);
});

test('owner disposal drains all simultaneous pending reads', { timeout: 10000 }, async t => {
  const f = await fixture(t, [call(0), call(1)]);
  await waitFor(() => f.arrivals.length === 2); await f.owner.dispose();
  await assert.rejects(f.running, /disposed/);
  await assert.rejects(f.release(0), /not pending/); await assert.rejects(f.release(1), /not pending/);
  assert.equal(f.owner.snapshot().resources.fibers, 0);
});

test('parallel hints are bound into the provider session signature and cap validation releases no owner', async t => {
  const f = await fixture(t, null);
  await f.running;
  await assert.rejects(Array.fromAsync(f.transport.start({ ...input, tools: tools.map(tool => ({ ...tool, concurrency: { schemaVersion: 1, mode: 'exclusive' } })) })), /allowlist.*rebinding/);
  const owner = createHarnessStudioRoot(); t.after(() => owner.dispose());
  await assert.rejects(createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => 'fixture-only', maxParallelToolCalls: 5 }), /1–4/);
  const transport = await createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => 'fixture-only', maxParallelToolCalls: 1 });
  assert.equal(transport.sessionCapabilities(input.model).parallelToolCalls, false);
});
