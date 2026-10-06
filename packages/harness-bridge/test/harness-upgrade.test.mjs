import { response, frames, data, usage, results } from './fixtures/messages.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarnessStudioRoot } from '../dist/index.js';
import { createPinnedHarnessAgentTransport } from '../dist/harness-agent.js';

const turn = { model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 8192, prompt: 'fixture turn', tools: [] };
const tool = { id: 'scene.query', description: 'Read the scene', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const encoder = new TextEncoder();
async function transportFor(t, options = {}) {
  const owner = createHarnessStudioRoot();
  t.after(() => owner.dispose());
  const transport = await createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => 'fixture-key-not-a-credential', ...options });
  return { owner, transport };
}

test('Messages streams and tool results keep their session and turn across repeated calls', { timeout: 10_000 }, async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    const body = JSON.parse(options.body); requests.push(body);
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.model, turn.model);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, 'studio_0_scene_query');
    const request = requests.length;
    assert.equal(options.headers['x-api-key'], 'fixture-key-not-a-credential');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    if (request % 2 === 1) return response({ text: `inspect-${request}`, calls: [{ id: `call-${request}`, name: 'studio_0_scene_query', arguments: {} }] });
    assert.ok(results(body).some(result => result.tool_use_id === `call-${request - 1}`));
    return response({ text: `done-${request}` });
  });
  const { transport } = await transportFor(t);
  for (const [sessionId, expectedTurn] of [['session:a', 1], ['session:b', 1], ['session:a', 2]]) {
    const events = [];
    for await (const event of transport.start({ ...turn, sessionId, tools: [tool] })) {
      events.push(event);
      if (event.type === 'tool-request') {
        assert.equal(event.toolId, tool.id); assert.deepEqual(event.arguments, {});
        await transport.submitToolResult(event.toolCallId, { entities: [] });
      }
    }
    assert.ok(events.every((event) => event.sessionId === sessionId && event.turnId === `${sessionId}:turn:${expectedTurn}`));
    assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);
    assert.equal(events.filter((event) => event.type === 'tool-request').length, 1);
    assert.equal(events.filter((event) => event.type === 'text-delta').length, 2, 'durable assistant messages must not duplicate transient text');
    const boundaries = events.filter(event => event.type === 'batch-boundary');
    assert.deepEqual(boundaries.map(event => event.closed), [false, true, false, true]);
    const call = events.find(event => event.type === 'tool-request');
    assert.equal(call.batchId, boundaries[0].batchId); assert.equal(call.stepId, boundaries[0].stepId);
    assert.equal(boundaries[0].batchId, boundaries[1].batchId); assert.notEqual(boundaries[0].batchId, boundaries[2].batchId);
    const accounting = events.filter((event) => event.type === 'usage');
    assert.equal(accounting.length, 2);
    assert.ok(accounting.every((event) => event.inputTokens === 20 && event.cacheReadTokens === 80 && event.outputTokens === 7));
    assert.equal(events.at(-1).status, 'completed');
  }
  assert.equal(requests.length, 6);
});

test('stream cancellation settles one turn and permits a fresh turn on the same session', { timeout: 10_000 }, async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    if (++requests > 1) return response({ text: 'resumed' });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frames({ text: 'partial' }).slice(0, 3).map(data).join('')));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const { transport } = await transportFor(t);
  const abort = new AbortController(); const events = [];
  for await (const event of transport.start({ ...turn, sessionId: 'session:cancel' }, abort.signal)) {
    events.push(event);
    if (event.type === 'text-delta') abort.abort();
  }
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  assert.equal(events.at(-1).status, 'cancelled');
  const resumed = await Array.fromAsync(transport.start({ ...turn, sessionId: 'session:cancel' }));
  assert.equal(resumed.find((event) => event.type === 'text-delta').text, 'resumed');
  assert.ok(resumed.every((event) => event.turnId === 'session:cancel:turn:2'));
  assert.equal(resumed.at(-1).status, 'completed');
});

test('owner disposal drains an in-flight Studio tool and rejects late results', { timeout: 10_000 }, async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ calls: [{ id: 'pending-call', name: 'studio_0_scene_query', arguments: {} }] }));
  const { owner, transport } = await transportFor(t);
  let callId;
  let disposing;
  await assert.rejects(async () => {
    for await (const event of transport.start({ ...turn, tools: [tool] })) {
      if (event.type === 'tool-request') { callId = event.toolCallId; disposing = owner.dispose(); }
    }
  }, /disposed/);
  assert.equal(callId, 'pending-call');
  await disposing;
  await assert.rejects(transport.submitToolResult(callId, { entities: [] }), /not pending/);
  assert.equal(owner.snapshot().resources.fibers, 0);
  await transport.dispose();
});

test('model defaults are explicit and only the official endpoint inherits catalog capacity', async (t) => {
  const { transport } = await transportFor(t, { model: 'deepseek-flash' });
  assert.equal(transport.modelCatalog()[0].id, 'deepseek-flash');
  assert.equal(transport.modelCatalog()[0].maxTokens, 256_000);
  assert.equal(transport.sessionCapabilities('deepseek-flash').maxInputTokens, 1_000_000);
  await transport.dispose();
  const custom = await transportFor(t, { baseURL: 'https://custom.invalid/v1' });
  assert.equal(custom.transport.modelCatalog()[0].id, 'deepseek-flash');
  assert.equal(custom.transport.sessionCapabilities('deepseek-flash').maxInputTokens, null);
});

test('request-error recovery stays bounded and new stream attempts keep the original turn', { timeout: 15_000 }, async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++requests < 3) throw new TypeError('fixture transport disconnected');
    return response({ text: 'recovered' });
  });
  const { transport } = await transportFor(t);
  const events = await Array.fromAsync(transport.start({ ...turn, sessionId: 'session:retry' }));
  assert.equal(requests, 3);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);
  assert.equal(events.filter((event) => event.type === 'text-delta').length, 1);
  assert.ok(events.every((event) => event.turnId === 'session:retry:turn:1'));
  assert.equal(events.at(-1).status, 'completed');

  t.mock.method(globalThis, 'fetch', async () => { ++requests; throw new TypeError('fixture persistent disconnect'); });
  const failed = await Array.fromAsync(transport.start({ ...turn, sessionId: 'session:retry' }));
  assert.equal(requests, 6, 'persistent errors must stop after the two Studio retries');
  assert.equal(failed.at(-1).status, 'failed');
  assert.equal(failed.at(-1).diagnostic.code, 'TRANSPORT');
});
