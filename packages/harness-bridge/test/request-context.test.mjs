import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessStudioRoot } from '../dist/index.js';
import { createPinnedHarnessAgentTransport, harnessToolName } from '../dist/harness-agent.js';

const tool = { id: 'scene.query', description: 'Read', inputSchema: { type: 'object' } };
const base = { sessionId: 'session:request-context', model: 'deepseek-v4-flash', reasoningEffort: 'off', maxTokens: 1024, tools: [tool] };
function response(call, code) {
  if (code) return new Response(JSON.stringify({ error: { message: 'fixture rejected', type: 'invalid_request_error' } }), { status: code });
  const delta = call ? { content: 'Read', tool_calls: [{ index: 0, id: call, type: 'function', function: { name: harnessToolName(tool.id, 0), arguments: '{}' } }] } : { content: 'Done' };
  return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 123, completion_tokens: 5, total_tokens: 128 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(t, fetcher) {
  const requests = []; t.mock.method(globalThis, 'fetch', async (_url, init) => { const value = JSON.parse(init.body); requests.push(value); return fetcher(requests.length, value); });
  const owner = createHarnessStudioRoot(); t.after(() => owner.dispose());
  const transport = await createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => 'fixture-only' });
  return { transport, requests, run: async (prompt, requestContext) => { const events = []; for await (const event of transport.start({ ...base, prompt, requestContext })) { events.push(event); if (event.type === 'tool-request') await transport.submitToolResult(event.toolCallId, { status: 'completed', revision: 7 }); } return events; } };
}
test('actual request gate runs before first HTTP and every tool step; rebuild shrinks the wire and preserves latest tool pairing', async t => {
  const f = await fixture(t, count => response(count === 2 ? 'call:one' : null));
  await f.run('OLD_HISTORY '.repeat(5000));
  const preparations = [], confirmations = [];
  let replaced = false;
  const port = { prepare: async request => {
    preparations.push(request);
    assert.ok(request.tools.length); assert.ok(request.requestBytes > 0);
    const result = { id: `prepared:${preparations.length}` };
    if (!replaced) { replaced = true; result.replacement = { throughMessageId: request.messages.filter(m => m.role !== 'system').at(-1).id, summary: 'Retained task and policy; current revision 7.' }; }
    return result;
  }, confirm: async id => { confirmations.push(id); } };
  const events = await f.run('Continue the same task', port);
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events.at(-1)));
  assert.equal(f.requests.length, 3, 'local rebuild must not add a provider call');
  assert.equal(preparations.length, 3);
  assert.equal(confirmations.length, 2);
  assert.deepEqual(preparations.map(r => r.epoch), [0, 1, 1]);
  assert.ok(JSON.stringify(f.requests[1]).length < JSON.stringify(f.requests[0]).length / 5);
  assert.equal(f.requests[2].messages.find(m => m.role === 'tool').tool_call_id, 'call:one');
  assert.equal(preparations.at(-1).previousUsage.inputTokens, 123);
});
test('provider failure after replacement restores original history and epoch without confirming a candidate', async t => {
  const f = await fixture(t, count => response(null, count === 2 ? 400 : undefined));
  await f.run('ORIGINAL_FACT '.repeat(300));
  let count = 0, confirms = 0;
  const failed = await f.run('continue', { prepare: async r => (++count === 1 ? { id: 'prepare:one', replacement: { throughMessageId: r.messages.filter(m => m.role !== 'system').at(-1).id, summary: 'short' } } : { id: 'prepare:two' }), confirm: async () => { confirms++; } });
  assert.equal(failed.at(-1).status, 'failed'); assert.equal(confirms, 0);
  assert.equal(failed.filter(e => e.type === 'usage').length, 0, 'rollback must not bill old assistant messages again');
  const observed = [];
  const resumed = await f.run('resume', { prepare: async r => { observed.push(r); return { id: 'prepare:resume' }; }, confirm: async () => {} });
  assert.equal(resumed.at(-1).status, 'completed'); assert.equal(observed[0].epoch, 0);
  assert.match(JSON.stringify(f.requests[2]), /ORIGINAL_FACT/);
  assert.doesNotMatch(JSON.stringify(f.requests[2]), /"content":"short"/);
});
test('preparation failure and invalid tool-pair cut make no extra HTTP request', async t => {
  const f = await fixture(t, count => response(count === 1 ? 'call:one' : null));
  let count = 0;
  const events = await f.run('read', { prepare: async r => {
    if (++count === 1) return { id: 'prepare:first' };
    return { id: 'prepare:invalid', replacement: { throughMessageId: r.messages.find(m => m.toolCallIds.length).id, summary: 'bad cut' } };
  }, confirm: async () => {} });
  assert.equal(events.at(-1).status, 'failed'); assert.equal(f.requests.length, 1);
});

test('cancellation during rebuilt preparation restores history before the next turn', async t => {
  const f = await fixture(t, () => response(null));
  await f.run('CANCEL_RESTORE_FACT '.repeat(400));
  let count = 0;
  const events = await f.run('continue', { prepare: async r => {
    if (++count === 1) return { id: 'prepare:one', replacement: { throughMessageId: r.messages.filter(m => m.role !== 'system').at(-1).id, summary: 'candidate' } };
    await f.transport.cancel(base.sessionId);
    return { id: 'prepare:cancelled' };
  }, confirm: async () => { assert.fail('Cancelled preparation must not confirm'); } });
  assert.equal(events.at(-1).status, 'cancelled'); assert.equal(f.requests.length, 1);
  await f.run('resume');
  assert.match(JSON.stringify(f.requests[1]), /CANCEL_RESTORE_FACT/);
});
test('durable confirmation failure restores the old Surface without executing returned tools', async t => {
  const f = await fixture(t, count => response(count === 2 ? 'call:must-not-execute' : null));
  await f.run('DURABLE_ORIGINAL '.repeat(400));
  let count = 0;
  const events = await f.run('continue', { prepare: async r => ++count === 1 ? { id: 'prepare:one', replacement: { throughMessageId: r.messages.filter(m => m.role !== 'system').at(-1).id, summary: 'candidate' } } : { id: 'prepare:two' }, confirm: async () => { throw new Error('fixture durable failure'); } });
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(events.filter(e => e.type === 'tool-request').length, 0);
  await f.run('resume'); assert.match(JSON.stringify(f.requests[2]), /DURABLE_ORIGINAL/);
});
