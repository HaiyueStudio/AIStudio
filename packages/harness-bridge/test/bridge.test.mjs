import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { asStableId, createStudioServiceToken, defineStudioPlugin } from '@haiyue/ai-studio-contracts';
import { createHarnessStudioRoot } from '../dist/index.js';
import { runHarnessBridgeUpstreamConformance } from '../dist/conformance.js';
import { createPinnedHarnessAgentTransport, harnessToolName } from '../dist/harness-agent.js';

const valueToken = createStudioServiceToken('fixture.value');
const capability = asStableId('fixture.capability');

function definition(id, options = {}) {
  return defineStudioPlugin({
    manifest: {
      schemaVersion: 1,
      id: asStableId(id),
      version: options.version ?? '1.0.0',
      apiVersion: '1.0',
      required: options.required ?? [],
      optional: options.optional ?? [],
      provides: options.provides ?? [],
      contributions: options.contributions ?? [],
      activationPolicy: options.activationPolicy ?? 'required',
    },
    validateConfig(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('config must be object');
      if (options.rejectConfig) throw new TypeError('rejected config');
      return value;
    },
    activate: options.activate ?? (() => {}),
  });
}

function profile(ids, patches = []) {
  return {
    schemaVersion: 1,
    id: asStableId(`profile:${ids.length || 'empty'}`),
    bundles: [{
      id: asStableId('bundle:fixture'),
      rows: ids.map((id, index) => ({ id: asStableId(`row:${index}:${id}`), pluginId: asStableId(id), enabled: true, config: { index } })),
    }],
    patches,
  };
}

test('one Cordis root activates dependency order and owns services, contributions, events and effects', async () => {
  const order = [];
  const disposed = [];
  const durable = [];
  const provider = definition('fixture.provider', {
    provides: [{ id: capability, version: '1.0.0' }],
    activate(context) {
      order.push('provider');
      context.services.provide(valueToken, 42);
      context.effects.own('provider.resource', () => { disposed.push('provider'); });
    },
  });
  const consumer = definition('fixture.consumer', {
    required: [{ id: capability, version: '^1.0.0' }],
    activate(context) {
      order.push('consumer');
      assert.equal(context.services.get(valueToken), 42);
      context.contributions.register({ id: asStableId('fixture.panel'), kind: asStableId('panel.fixture'), value: { title: 'Fixture' } });
      context.events.emitDurable({
        schemaVersion: 1, id: asStableId('event:fixture'), kind: asStableId('plugin.ready'), source: context.pluginId,
        timestamp: '2026-08-19T00:00:00.000Z', payload: {},
      });
      context.effects.own('consumer.resource', () => { disposed.push('consumer'); });
    },
  });
  const host = createHarnessStudioRoot({ durableEvent: (event) => durable.push(event) });
  await host.activate(profile(['fixture.consumer', 'fixture.provider']), [provider, consumer]);
  assert.deepEqual(order, ['provider', 'consumer']);
  assert.equal(host.snapshot().state, 'active');
  assert.equal(host.snapshot().resources.fibers, 2);
  assert.equal(durable.length, 1);
  await assert.rejects(
    host.disable(asStableId('fixture.provider')),
    /active dependents/,
  );
  await host.dispose();
  assert.deepEqual(disposed, ['consumer', 'provider']);
  assert.deepEqual(host.snapshot().resources, { services: 0, contributions: 0, listeners: 0, effects: 0, fibers: 0 });
  await host.dispose();
});

test('partial activation failure rolls every effect back in reverse order', async () => {
  const disposed = [];
  const a = definition('fixture.rollback-a', { activate(context) { context.effects.own('a', () => disposed.push('a')); } });
  const b = definition('fixture.rollback-b', { activate(context) { context.effects.own('b', () => disposed.push('b')); } });
  const c = definition('fixture.rollback-c', { activate(context) { context.effects.own('c', () => disposed.push('c')); throw new Error('fault'); } });
  const host = createHarnessStudioRoot();
  await assert.rejects(host.activate(profile(['fixture.rollback-a', 'fixture.rollback-b', 'fixture.rollback-c']), [a, b, c]), /fault/);
  assert.deepEqual(disposed, ['c', 'b', 'a']);
  assert.equal(host.snapshot().resources.fibers, 0);
  await host.dispose();
});

test('optional provider failure degrades consumer without failing profile', async () => {
  const optionalCapability = asStableId('fixture.optional');
  const provider = definition('fixture.optional-provider', {
    activationPolicy: 'default', provides: [{ id: optionalCapability, version: '1.0.0' }],
    activate() { throw new Error('optional unavailable'); },
  });
  let observed = true;
  const consumer = definition('fixture.optional-consumer', {
    optional: [{ id: optionalCapability, version: '1.0.0' }],
    activate(context) { observed = context.optionalCapabilities[optionalCapability]; },
  });
  const host = createHarnessStudioRoot();
  await host.activate(profile(['fixture.optional-consumer', 'fixture.optional-provider']), [provider, consumer]);
  assert.equal(observed, false);
  assert.equal(host.snapshot().plugins.find((item) => item.id === 'fixture.optional-consumer').state, 'degraded');
  await host.dispose();
});

test('invalid config and late async activation fail closed with zero resources', async () => {
  const invalid = definition('fixture.invalid-config', { rejectConfig: true });
  const host = createHarnessStudioRoot();
  await assert.rejects(host.activate(profile(['fixture.invalid-config']), [invalid]), /rejected config/);
  assert.equal(host.snapshot().resources.fibers, 0);
  await host.dispose();

  let lateWrite = false;
  const late = definition('fixture.late', {
    async activate(context) {
      await new Promise((resolve) => context.owner.signal.addEventListener('abort', resolve, { once: true }));
      try { context.owner.assertActive(); lateWrite = true; } catch {}
    },
  });
  const racingHost = createHarnessStudioRoot();
  const activation = racingHost.activate(profile(['fixture.late']), [late]);
  await new Promise((resolve) => setImmediate(resolve));
  await racingHost.dispose();
  await assert.rejects(activation);
  assert.equal(lateWrite, false);
  assert.equal(racingHost.snapshot().resources.fibers, 0);
});

test('profile replacement is deterministic and 100 cycles leave no owned resources', async () => {
  const plugin = definition('fixture.cycle', {
    activate(context) {
      context.services.provide(valueToken, 1);
      context.effects.own('cycle', () => {});
    },
  });
  const full = profile(['fixture.cycle'], [{ pluginId: asStableId('fixture.cycle'), config: { patched: true } }]);
  const empty = profile([]);
  const host = createHarnessStudioRoot();
  await host.activate(empty, [plugin]);
  let dump;
  for (let index = 0; index < 100; index += 1) {
    await host.replace(full, [plugin]);
    dump ??= host.dumpResolvedProfile();
    assert.equal(host.dumpResolvedProfile(), dump);
    await host.replace(empty, [plugin]);
    assert.deepEqual(host.snapshot().resources, { services: 0, contributions: 0, listeners: 0, effects: 0, fibers: 0 });
  }
  await host.dispose();
});

test('fixed Cordis compatibility and lazy closure remain explicit', async () => {
  const result = await runHarnessBridgeUpstreamConformance();
  assert.deepEqual(result.disposed, ['second', 'first']);
  assert.deepEqual(result.identity, { cordis: '4.0.1', harness: '0.1.0-rc.7' });
  const source = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dsh-agent|dsh-llm|dsh-tools|agent-backends/);
  const declarations = await readFile(new URL('../dist/index.d.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(declarations, /@deepseek-ai\/cordis|\bContext\b|\bFiber(?:State)?\b/);
});

test('pinned Harness agent composition fails closed without a credential and disposes idempotently', async () => {
  const transport = await createPinnedHarnessAgentTransport({ resolveApiKey: async () => null });
  assert.deepEqual(
    transport.modelCatalog().map(({ id, maxTokens }) => ({ id, maxTokens })),
    [
      { id: 'deepseek-v4-flash', maxTokens: 384_000 },
      { id: 'deepseek-v4-pro', maxTokens: 384_000 },
    ],
  );
  assert.equal(await transport.configured(), false);
  const events = [];
  for await (const event of transport.start({ prompt: 'credential-boundary-smoke', tools: [] })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ['turn-start', 'turn-end']);
  assert.equal(events.at(-1).status, 'failed');
  assert.ok(events.at(-1).diagnostic?.code);
  await transport.dispose();
  await transport.dispose();
});

test('Harness maps dotted Studio tool ids to provider-safe deterministic names', () => {
  assert.equal(harnessToolName('entity.create', 0), 'studio_0_entity_create');
  assert.equal(harnessToolName('preview.start', 12), 'studio_12_preview_start');
  assert.match(harnessToolName('studio.tool/unsafe value', 1), /^[a-zA-Z0-9_-]+$/);
});
