import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarnessStudioRoot } from '../dist/index.js';
import { harnessOwnerContext } from '../dist/ownership.js';
import { createPinnedHarnessAgentTransport } from '../dist/harness-agent.js';
import { response } from './fixtures/messages.mjs';

const input = { sessionId: 'session:v4', model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 1024, tools: [], prompt: 'Read current facts.', lastConfirmedOpId: 'op:v4' };
async function fixture(t, options = {}) {
  const owner = createHarnessStudioRoot();
  t.after(() => owner.dispose());
  const transport = await createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => 'fixture-only', ...options });
  return { owner, transport, ctx: harnessOwnerContext(owner) };
}

test('Session V4 awaits serial initialization before publishing a handle or making its first Messages request', { timeout: 10000 }, async t => {
  const { owner, transport, ctx } = await fixture(t);
  const entered = Promise.withResolvers(), ready = Promise.withResolvers();
  let requests = 0, initialized = false;
  t.after(() => ready.resolve());
  ctx.on('agent/created', async ({ agent, signal }) => {
    assert.equal(agent.session.header.version, 4);
    entered.resolve();
    await ready.promise;
    signal?.throwIfAborted();
    initialized = true;
  }, { global: true });
  t.mock.method(globalThis, 'fetch', async () => { assert.equal(initialized, true); requests++; return response({ text: 'Ready.' }); });
  const running = Array.fromAsync(transport.start(input));
  await entered.promise;
  assert.equal(requests, 0);
  assert.equal((await transport.inspectSession(input.sessionId)).state, 'missing');
  await assert.rejects(transport.openSession(input), /initializing/);
  ready.resolve();
  const events = await running;
  assert.equal(requests, 1);
  assert.equal(events.at(-1).status, 'completed');
  assert.equal((await transport.inspectSession(input.sessionId)).state, 'available');
  await transport.closeSession(input.sessionId);
  assert.equal((await transport.inspectSession(input.sessionId)).state, 'missing');
  await owner.dispose();
  assert.equal(owner.snapshot().resources.fibers, 0);
});

for (const action of ['cancel', 'closeSession']) test(`${action} aborts asynchronous initialization and permits clean recreation`, { timeout: 10000 }, async t => {
  const { transport, ctx } = await fixture(t);
  const entered = Promise.withResolvers();
  let first = true, requests = 0;
  ctx.on('agent/created', async ({ signal }) => {
    if (!first) return;
    first = false;
    entered.resolve();
    await new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, { global: true });
  t.mock.method(globalThis, 'fetch', async () => { requests++; return response({ text: 'Recreated.' }); });
  const rejected = assert.rejects(Array.fromAsync(transport.start(input)), /cancel|closed|abort/i);
  await entered.promise;
  await transport[action](input.sessionId);
  await rejected;
  assert.equal(requests, 0);
  assert.equal((await transport.inspectSession(input.sessionId)).state, 'missing');
  const events = await Array.fromAsync(transport.start(input));
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(requests, 1);
});

test('failed initialization releases its scope and pre-aborted requests never create a Session', async t => {
  const { owner, transport, ctx } = await fixture(t);
  const baseline = owner.snapshot().resources.fibers;
  let first = true;
  ctx.on('agent/created', async () => { if (first) { first = false; throw new Error('fixture initialization failure'); } }, { global: true });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No request expected.'));
  await assert.rejects(transport.openSession(input), /fixture initialization failure/);
  assert.equal(owner.snapshot().resources.fibers, baseline);
  assert.equal((await transport.inspectSession(input.sessionId)).state, 'missing');
  await assert.rejects(Array.fromAsync(transport.start(input, AbortSignal.abort(new Error('already stopped')))), /already stopped/);
  const opened = await transport.openSession(input);
  assert.equal(opened.sessionId, input.sessionId);
});

test('owner disposal aborts an initializing Session without publishing a late handle or request', { timeout: 10000 }, async t => {
  const { owner, transport, ctx } = await fixture(t);
  const entered = Promise.withResolvers();
  ctx.on('agent/created', async ({ signal }) => {
    entered.resolve();
    await new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, { global: true });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Disposed initialization must not make a request.'));
  const rejected = assert.rejects(Array.fromAsync(transport.start(input)), /disposed|abort/i);
  await entered.promise;
  await owner.dispose();
  await rejected;
  assert.equal(owner.snapshot().resources.fibers, 0);
  await assert.rejects(transport.openSession(input), /disposed/i);
});

test('official legacy URL migrates to Messages, custom Chat Completions and retired models require explicit migration', async t => {
  const { owner, transport } = await fixture(t, { baseURL: 'https://api.deepseek.com/v1' });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    return response({ text: 'Messages.' });
  });
  assert.equal((await Array.fromAsync(transport.start(input))).at(-1).status, 'completed');
  await assert.rejects(transport.openSession({ ...input, sessionId: 'old-model', model: 'deepseek-v4-flash' }), /not in the pinned catalog/);
  await transport.dispose();
  await assert.rejects(createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => 'fixture-only', baseURL: 'https://gateway.invalid/chat/completions' }), /endpoint-migration-required/);
  assert.equal(owner.snapshot().resources.fibers, 0);
});
