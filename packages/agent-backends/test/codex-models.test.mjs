import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServerBackend } from '../dist/index.js';

const sol = model('gpt-6.2-sol', true);
const astra = model('gpt-6.2-astra');
function model(id, isDefault = false, extra = {}) {
  return { id, model: id, displayName: id, description: 'fixture', hidden: false, isDefault,
    supportedReasoningEfforts: ['low', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: 'low', ...extra };
}
function backend(transport) { return new CodexAppServerBackend({ transport, isolatedCwd: 'D:\\isolated-ai-studio', requestTimeoutMs: 1000 }); }
function config(id = astra.model, effort = 'max') {
  return { schemaVersion: 2, backendId: 'backend:codex-app-server', model: id, reasoningEffort: effort, outputTokenLimit: 999_999,
    taskBudgetId: 'budget:models', promptProfile: { id: 'prompt:models', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }, requestedCapabilities: ['agent.model-config'] };
}

test('GPT 6.2 pages retain exact xhigh/max, reject Ultra and send the selected model on the wire', async t => {
  const transport = new Transport(params => params.cursor ? { data: [astra], nextCursor: null } : { data: [sol], nextCursor: 'page:2' });
  const b = backend(transport); t.after(() => b.dispose());
  const catalog = await b.modelCatalog();
  assert.deepEqual(catalog.models.map(x => x.id), [sol.model, astra.model]);
  assert.deepEqual(catalog.models[1].reasoningEfforts, ['low', 'high', 'xhigh', 'max']);
  assert.equal(catalog.models[1].maxOutputTokens, 128_000);
  assert.equal((await b.negotiate(config())).effective.reasoningEffort, 'max');
  assert.equal((await b.negotiate(config())).effective.outputTokenLimit, 128_000);
  await assert.rejects(b.negotiate(config(astra.model, 'ultra')), /configuration is invalid/);
  const events = []; for await (const event of b.startTurn({ taskId: 'task:models', config: config(), prompt: 'fixture', contextArtifactIds: [], tools: [] })) events.push(event);
  assert.equal(events.at(-1).payload.status, 'completed');
  const thread = transport.requests.find(x => x.method === 'thread/start').params;
  const turn = transport.requests.find(x => x.method === 'turn/start').params;
  assert.equal(thread.model, astra.model); assert.equal(thread.allowProviderModelFallback, false);
  assert.equal(turn.model, astra.model); assert.equal(turn.effort, 'max');
  assert.equal('max_output_tokens' in turn, false);
});

test('catalog refresh, account changes and TTL replace cached availability', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  let models = [sol]; const transport = new Transport(() => ({ data: models, nextCursor: null }));
  const b = backend(transport); t.after(() => b.dispose());
  await b.modelCatalog(); await b.modelCatalog(); assert.equal(transport.catalogCalls, 1);
  models = [sol, astra]; assert.equal((await b.refreshModelCatalog()).models.length, 2); assert.equal(transport.catalogCalls, 2);
  now += 60_001; await b.modelCatalog(); assert.equal(transport.catalogCalls, 3);
  transport.notify('account/updated', {}); await new Promise(resolve => setImmediate(resolve));
  models = [astra]; assert.equal((await b.modelCatalog()).models[0].id, astra.model); assert.equal(transport.catalogCalls, 4);
  await b.logout(); await b.modelCatalog(); assert.equal(transport.catalogCalls, 5);
});

test('a refreshed generation cannot be overwritten by a late account catalog response', async t => {
  let release; const entered = new Promise(resolve => { release = resolve; });
  const transport = new Transport((_params, frame, self) => { if (self.catalogCalls === 1) { self.held = frame.id; release(); return; } return { data: [astra], nextCursor: null }; });
  const b = backend(transport); t.after(() => b.dispose());
  const first = b.modelCatalog(); const rejected = assert.rejects(first, error => error.code === 'codex.model-catalog-superseded');
  await entered; const latest = await b.refreshModelCatalog();
  transport.result(transport.held, { data: [sol], nextCursor: null }); await rejected;
  assert.deepEqual(latest.models.map(x => x.id), [astra.model]);
  assert.deepEqual((await b.modelCatalog()).models.map(x => x.id), [astra.model]);
});

test('cancelling one catalog waiter leaves the shared request available to another caller', async t => {
  let release; const entered = new Promise(resolve => { release = resolve; });
  const transport = new Transport((_params, frame, self) => { self.held = frame.id; release(); });
  const b = backend(transport); t.after(() => b.dispose());
  const controller = new AbortController(); const first = b.modelCatalog(controller.signal);
  const rejected = assert.rejects(first, /caller cancelled/);
  await entered; const second = b.modelCatalog(); controller.abort(new Error('caller cancelled'));
  transport.result(transport.held, { data: [sol], nextCursor: null });
  await rejected; assert.equal((await second).models[0].id, sol.model); assert.equal(transport.catalogCalls, 1);
});

test('catalog rejects cyclic cursors, duplicate ids and oversized values without partial publication', async t => {
  for (const [pages, code] of [
    [(params) => ({ data: [params.cursor ? astra : sol], nextCursor: 'same' }), 'codex.model-catalog-cursor'],
    [(params) => ({ data: [sol], nextCursor: params.cursor ? null : 'second' }), 'codex.model-catalog-duplicate'],
    [() => ({ data: [model('fixture', false, { displayName: 'x'.repeat(257) })], nextCursor: null }), 'codex.model-catalog-schema-drift'],
  ]) {
    const transport = new Transport(pages); const b = backend(transport); t.after(() => b.dispose());
    await assert.rejects(b.modelCatalog(), error => error.code === code);
    transport.catalog = () => ({ data: [sol], nextCursor: null });
    assert.equal((await b.modelCatalog()).models.length, 1);
    assert.equal(transport.requests.some(x => x.method === 'turn/start'), false);
  }
});

test('hidden models stay hidden, unknown limits stay conservative and GPT 6.2 never offers off', async t => {
  const transport = new Transport(() => ({ data: [model('hidden', false, { hidden: true }), model('future-model'), model(sol.model, true, { supportedReasoningEfforts: ['none', 'low'].map(reasoningEffort => ({ reasoningEffort })) })], nextCursor: null }));
  const b = backend(transport); t.after(() => b.dispose());
  const catalog = await b.modelCatalog();
  assert.deepEqual(catalog.models.map(x => x.id), ['future-model', sol.model]);
  assert.equal(catalog.models[0].maxOutputTokens, 32_768);
  assert.deepEqual(catalog.models[1].reasoningEfforts, ['low']);
  assert.equal((await b.negotiate(config(sol.model, 'off'))).status, 'rejected');
});

class Transport {
  constructor(catalog) {
    this.catalog = catalog; this.requests = []; this.catalogCalls = 0; this.values = []; this.waiters = []; this.closed = false;
    this.lines = { [Symbol.asyncIterator]: () => ({ next: () => this.values.length ? Promise.resolve({ value: this.values.shift(), done: false }) : this.closed ? Promise.resolve({ done: true }) : new Promise(resolve => this.waiters.push(resolve)) }) };
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
  }
  emit(value) { const line = JSON.stringify(value); const waiter = this.waiters.shift(); if (waiter) waiter({ value: line, done: false }); else this.values.push(line); }
  result(id, result) { this.emit({ id, result }); }
  notify(method, params) { this.emit({ method, params }); }
  async write(line) {
    const frame = JSON.parse(line); if (!frame.method || !('id' in frame)) return;
    this.requests.push(frame);
    if (frame.method === 'model/list') { this.catalogCalls += 1; const response = this.catalog(frame.params, frame, this); if (response) this.result(frame.id, response); }
    else if (frame.method === 'thread/start') this.result(frame.id, { thread: { id: 'thread:models' } });
    else if (frame.method === 'turn/start') {
      this.result(frame.id, { turn: { id: 'turn:models', status: 'inProgress' } });
      setImmediate(() => this.notify('turn/completed', { threadId: 'thread:models', turn: { id: 'turn:models', status: 'completed' } }));
    } else this.result(frame.id, {});
  }
  async dispose() { if (this.closed) return; this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true }); this.resolveExit({ code: 0, signal: null }); }
}
