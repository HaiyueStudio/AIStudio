import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntimePlugin, agentRuntimeServiceToken, KnowledgeRetrievalRuntime, DurableSessionRuntime, ModelContextRuntime, BackendSessionRuntime } from '../dist/index.js';

function backend(id, disposed, fault = false) {
  return {
    descriptor: { schemaVersion: 1, id, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: { resume: true, questions: true, structuredTools: true, backendApprovals: false, usage: true, rateLimits: false } },
    async dispose() { disposed.push(id); if (fault) throw new Error(`dispose:${id}`); },
  };
}

function fixture({ failReplay, failProvide = false, query } = {}) {
  const effects = [];
  const services = new Map();
  const abort = new AbortController();
  const context = {
    owner: {
      signal: abort.signal,
      get active() { return !abort.signal.aborted; },
      assertActive() { if (abort.signal.aborted) throw new Error('owner inactive'); },
    },
    effects: { own(label, dispose) { effects.push(dispose); return { dispose }; } },
    services: {
      get() { return { log: {
        status: () => ({ nextSequence: 2, retainedFromSequence: 1, eventCount: 1 }),
        async flush() {},
        async query(input) {
          if (input.kinds[0].startsWith(failReplay ?? 'never:')) throw new Error(`replay:${failReplay}`);
          await query?.(input);
          return { events: [] };
        },
      } }; },
      provide(token, service) {
        if (failProvide && token === agentRuntimeServiceToken) throw new Error('provide:fault');
        services.set(token, service);
      },
    },
  };
  return {
    context, effects, services, abort,
    async dispose() { abort.abort(); for (const dispose of effects.toReversed()) await dispose(); },
  };
}

for (const failReplay of ['knowledge/', 'agent/']) {
  test(`runtime rolls back backends and knowledge when ${failReplay} replay fails`, async (t) => {
    const disposed = [];
    const value = fixture({ failReplay });
    const cleanup = t.mock.method(KnowledgeRetrievalRuntime.prototype, 'dispose');
    const plugin = createAgentRuntimePlugin({ createBackends(context) {
      assert.equal(context, value.context);
      assert.equal(value.effects.length, 1, 'rollback must be owned before the factory runs');
      return [backend('backend:replay', disposed)];
    } });
    await assert.rejects(plugin.activate(value.context, {}), /replay:/);
    assert.deepEqual(disposed, ['backend:replay']);
    assert.equal(cleanup.mock.callCount(), 1);
    assert.equal(value.services.size, 0);
    await value.dispose(); await value.dispose();
    assert.deepEqual(disposed, ['backend:replay']);
  });
}

test('registration failure reclaims every factory result even when one disposer fails', async () => {
  const disposed = [];
  const value = fixture();
  const plugin = createAgentRuntimePlugin({ createBackends: () => [
    backend('backend:duplicate', disposed), backend('backend:duplicate', disposed, true), backend('backend:unregistered', disposed),
  ] });
  await assert.rejects(plugin.activate(value.context, {}), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].code, 'agent.backend-duplicate');
    assert.match(error.errors[1].message, /dispose:backend:duplicate/);
    return true;
  });
  assert.deepEqual(disposed, ['backend:unregistered', 'backend:duplicate', 'backend:duplicate']);
  await assert.rejects(value.dispose(), /dispose:backend:duplicate/);
  assert.equal(disposed.length, 3);
});

test('late factory results are disposed before owner shutdown completes and never published', async () => {
  const disposed = [];
  const value = fixture();
  const gate = Promise.withResolvers();
  const plugin = createAgentRuntimePlugin({ createBackends: () => gate.promise });
  const activation = plugin.activate(value.context, {});
  const rejected = assert.rejects(activation, /owner inactive/);
  let closed = false;
  const shutdown = value.dispose().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  gate.resolve([backend('backend:late', disposed)]);
  await Promise.all([shutdown, rejected]);
  assert.deepEqual(disposed, ['backend:late']);
  assert.equal(value.services.size, 0);
});

test('owner invalidation during replay stops later initialization and cleans loaded backends', async () => {
  const disposed = [];
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let queries = 0;
  const value = fixture({ async query() { queries += 1; entered.resolve(); await gate.promise; } });
  const plugin = createAgentRuntimePlugin({ createBackends: () => [backend('backend:cancelled', disposed)] });
  const activation = plugin.activate(value.context, {});
  const rejected = assert.rejects(activation, /owner inactive/);
  await entered.promise;
  const shutdown = value.dispose();
  gate.resolve();
  await Promise.all([shutdown, rejected]);
  assert.equal(queries, 1);
  assert.equal(value.services.size, 0);
  assert.deepEqual(disposed, ['backend:cancelled']);
});

for (const failure of ['adapter', 'publish', 'none']) {
  test(`runtime cleans all session resources on ${failure} failure or normal shutdown`, async (t) => {
    const disposed = [];
    const value = fixture({ failProvide: failure === 'publish' });
    const cleanups = [KnowledgeRetrievalRuntime, DurableSessionRuntime, ModelContextRuntime, BackendSessionRuntime]
      .map((type) => t.mock.method(type.prototype, 'dispose'));
    const adapter = backend('backend:session', disposed);
    const backends = [adapter];
    if (failure === 'adapter') {
      const methods = { backendId: 'backend:shared-session', provider: 'harness', capabilities() {}, open() {}, inspect() {}, confirmBoundary() {}, compact() {}, detach() {} };
      Object.assign(adapter, methods);
      backends.push(Object.assign(backend('backend:session-two', disposed), methods));
    }
    const plugin = createAgentRuntimePlugin({ createBackends: () => backends });
    if (failure === 'none') await plugin.activate(value.context, {});
    else await assert.rejects(plugin.activate(value.context, {}));
    await value.dispose(); await value.dispose();
    assert.deepEqual(disposed, failure === 'adapter' ? ['backend:session-two', 'backend:session'] : ['backend:session']);
    for (const cleanup of cleanups) assert.equal(cleanup.mock.callCount(), 1);
    if (failure === 'none') {
      const service = value.services.get(agentRuntimeServiceToken);
      assert.throws(() => service.registry.descriptors(), /disposed/);
      await assert.rejects(service.knowledge.initialize(), /disposed/);
    }
  });
}
