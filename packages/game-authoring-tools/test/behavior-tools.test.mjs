import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { BehaviorReadService, parseBehaviorContract } from '@haiyue/ai-studio-script-preview';
import { GAME_AUTHORING_TOOL_DEFINITIONS, GameToolProtocolError, ToolCatalogRuntime, resolveModelToolInvocation } from '../dist/index.js';
import { behaviorFixture, call, execute, timer } from './behavior-fixture.mjs';

const revision = f => f.workspace.snapshot().document.revision;
const query = (f, extra = {}) => execute(f, 'behavior.query', { baseRevision: revision(f), ...extra });
const bound = result => ({ baseRevision: result.beforeRevision, manifestDigest: result.value.manifestDigest, sourceBindingDigest: result.value.binding.digest });

for (const source of ['script', 'declarative', 'mixed']) test(`${source}: real behavior tools preserve source binding and read-only History`, async t => {
  const f = await behaviorFixture({ declarative: source !== 'script', script: source !== 'declarative' ? 'if (api.input.isDown("ArrowUp")) Math.sin(time);' : '' }); t.after(f.close);
  const before = JSON.stringify(f.workspace.gameSnapshot()), history = JSON.stringify(f.workspace.snapshot().history);
  const result = await query(f, { entityId: f.entityId, limit: 100 });
  assert.equal(result.status, 'completed'); assert.equal(result.afterRevision, result.beforeRevision);
  const binding = parseBehaviorContract('behavior-source-binding', result.value.binding);
  assert.equal(binding.projectId, f.workspace.snapshot().document.projectId); assert.equal(binding.documentId, f.workspace.gameSnapshot().id);
  assert.ok(result.value.nodes.length); if (source !== 'declarative') assert.ok(result.value.nodes.some(n => n.source.kind === 'script'));
  if (source !== 'script') assert.ok(result.value.nodes.some(n => n.source.kind === 'declarative-component' && n.kind === 'trigger'));
  if (source === 'declarative') assert.equal(f.workspace.gameSnapshot().scripts.length, 0);
  const service = new BehaviorReadService(); t.after(() => service.dispose()); await service.analyze(f.input());
  for (const kind of new Set(result.value.nodes.map(n => n.source.kind))) {
    const node = result.value.nodes.find(n => n.source.kind === kind);
    const located = await execute(f, 'behavior.locate', { ...bound(result), nodeId: node.id });
    assert.equal(service.resolveLocation(parseBehaviorContract('editor-location', located.value.location)).status, 'current');
    const english = await execute(f, 'behavior.explain', { ...bound(result), nodeIds: [node.id], language: 'en' });
    const chinese = await execute(f, 'behavior.explain', { ...bound(result), nodeIds: [node.id], language: 'zh-CN' });
    const explanation = parseBehaviorContract('behavior-explanation', english.value.explanation);
    assert.equal(explanation.producer.kind, 'verified-structure'); assert.equal(explanation.manifestDigest, result.value.manifestDigest);
    assert.deepEqual(explanation.entries[0].evidence, [node.source]); assert.notEqual(explanation.digest, chinese.value.explanation.digest);
    assert.match(explanation.entries[0].text, /runtime evidence/);
  }
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(JSON.stringify(f.workspace.snapshot().history), history); assert.equal(f.preview.starts, 0);
});

test('schema fuzz, exact invocation versions and registry-owned risk reject unsupported behavior requests', async t => {
  const f = await behaviorFixture(); t.after(f.close);
  const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => f.workspace.componentRegistry.snapshot().definitions);
  for (const id of ['behavior.query','behavior.locate','behavior.explain']) {
    const match = catalog.search(id, { includeSchemas: true, limit: 1 })[0]; assert.equal(match.id, id);
    assert.deepEqual(match.invocation, { tool: 'studio.tool.invoke', toolId: id, toolVersion: '1.0.0' }); assert.equal(match.effect, 'observe'); assert.equal(match.risk, 'low'); assert.equal(match.requiresApproval, false);
  }
  const digest = 'sha256:' + 'a'.repeat(64), nodeId = 'node:' + 'b'.repeat(32);
  const valid = { baseRevision: revision(f), manifestDigest: digest, sourceBindingDigest: digest };
  const cases = [
    ['behavior.query', {}], ['behavior.query', { baseRevision: '2' }], ['behavior.query', { baseRevision: 2.5 }],
    ...[0,101,-1,'25',null].map(limit => ['behavior.query', { baseRevision: revision(f), limit }]),
    ['behavior.query', { baseRevision: revision(f), offset: 1 }], ['behavior.query', { baseRevision: revision(f), manifestDigest: digest }],
    ['behavior.query', { ...valid, sourceBindingDigest: 'stale' }], ['behavior.query', { ...valid, kind: 'runtime-proven' }],
    ['behavior.query', { ...valid, entityId: '../../outside' }], ['behavior.query', { ...valid, registry: {} }],
    ['behavior.locate', { ...valid, nodeId: {} }], ['behavior.explain', { ...valid, nodeIds: [], language: 'en' }],
    ['behavior.explain', { ...valid, nodeIds: [nodeId,nodeId], language: 'en' }], ['behavior.explain', { ...valid, nodeIds: [nodeId], language: 'es' }],
    ...['effect','risk','capabilities','projectId','adapters','source','authorization'].map(key => ['behavior.query', { baseRevision: revision(f), [key]: 'untrusted' }]),
  ];
  const ajv = new Ajv({ strict: false });
  const schemas = Object.fromEntries(GAME_AUTHORING_TOOL_DEFINITIONS.filter(tool => tool.id.startsWith('behavior.')).map(tool => [tool.id, ajv.compile(tool.inputSchema)]));
  for (const [id,args] of cases) {
    assert.equal(schemas[id](args), false, `${id} must reject malformed input in its advertised schema too`);
    await assert.rejects(f.runtime.prepare(call(`call:fuzz-${++f.sequence}`, id, args)), e => e.code === 'tool.arguments-invalid');
  }
  for (const args of [{ baseRevision: revision(f) }, { ...valid, offset: 100, limit: 100 }, { baseRevision: revision(f), offset: 0, limit: 1 }]) assert.equal(schemas['behavior.query'](args), true);
  for (const toolId of ['scene.transaction','shell.exec','resource.assign']) assert.throws(() => resolveModelToolInvocation({ toolId, toolVersion: '1.0.0', arguments: {} }, GAME_AUTHORING_TOOL_DEFINITIONS), e => e.code === 'tool.not-found');
  assert.throws(() => resolveModelToolInvocation({ toolId: 'behavior.query', toolVersion: '2.0.0', arguments: {} }, GAME_AUTHORING_TOOL_DEFINITIONS), e => e.code === 'tool.version-mismatch');
  await assert.rejects(f.runtime.prepare({ ...call('call:version', 'behavior.query', { baseRevision: revision(f) }), toolVersion: '2.0.0' }), e => e.code === 'tool.not-found');
  assert.equal(f.sourceReads, 0);
});

test('component edits, project identity, registry/config changes and in-flight drift invalidate behavior results', async t => {
  const f = await behaviorFixture({ declarative: true }); t.after(f.close);
  const first = await query(f), nodeId = first.value.nodes.find(n => n.kind === 'trigger').id;
  const prepared = await f.runtime.prepare(call('call:prepared-stale', 'behavior.locate', { ...bound(first), nodeId }));
  await execute(f, 'component.configure', { baseRevision: revision(f), action: 'upsert', entityId: f.entityId, type: 'haiyue.gameplay.timers', patch: { timers: [{ ...timer, durationTicks: 20 }] } });
  await assert.rejects(f.runtime.execute(prepared.id), e => e.code === 'tool.stale-revision');
  await assert.rejects(query(f, { manifestDigest: first.value.manifestDigest, sourceBindingDigest: first.value.binding.digest }), e => e.code === 'behavior.stale');
  const second = await query(f); assert.notEqual(second.value.binding.digest, first.value.binding.digest);
  for (const mutate of [input => { input.projectId = 'project:foreign'; }, input => { input.document.id = 'document:foreign'; }, input => { input.registry.version = '2.0.0'; }, input => { input.adapters[0].version = '2.0.0'; }, input => { input.config.maxNodes = 1000; }]) {
    f.sourceHook = input => { mutate(input); return input; };
    await assert.rejects(query(f, { ...bound(second) }), e => e.code === 'behavior.stale');
  }
  let reads = 0;
  f.sourceHook = input => { if (++reads > 1) input.adapters[0].version = '2.0.0'; return input; };
  await assert.rejects(query(f), e => e.code === 'behavior.stale');
});

test('result pages adapt to byte budget without dropping provenance or skipping nodes', async t => {
  const f = await behaviorFixture({ script: 'Math.sin(time);\n'.repeat(160) }); t.after(f.close);
  f.sourceHook = input => { input.document.scripts[0].sourcePath = 'scripts/' + 'a'.repeat(400) + '.ts'; return input; };
  const first = await query(f, { limit: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(first.value)) <= 65536); assert.equal(first.value.pageTruncated, true);
  assert.equal(first.value.nextOffset, first.value.nodes.length); assert.ok(first.value.binding.digest);
  const next = await query(f, { ...bound(first), offset: first.value.nextOffset, limit: 100 });
  assert.equal(next.value.manifestDigest, first.value.manifestDigest); assert.ok(next.value.nodes.length);
  const ids = new Set(first.value.nodes.map(n => n.id)); assert.ok(next.value.nodes.every(n => !ids.has(n.id)));
  for (const page of [first.value, next.value]) { const nodes = new Set(page.nodes.map(n => n.id)); assert.ok(page.edges.every(e => nodes.has(e.from) && nodes.has(e.to))); }
});

test('missing source, secret-bearing inputs and provider errors are explicit and redacted', async t => {
  const absent = await behaviorFixture({ noSource: true }); t.after(absent.close);
  await assert.rejects(query(absent), e => e.code === 'behavior.unavailable');
  assert.equal((await execute(absent, 'engine.capabilities.describe', {})).status, 'completed');
  const f = await behaviorFixture(); t.after(f.close);
  const secret = 'sk-fixture-redaction-1234567890';
  for (const hook of [input => ({ ...input, authorization: secret }), () => { throw Error(secret); }, () => { throw new GameToolProtocolError('fixture.error', secret); }]) {
    f.sourceHook = hook; await assert.rejects(query(f), e => !e.message.includes(secret));
  }
  const events = await f.operationLog.query({ limit: 200, traverseCorrelation: false }); assert.ok(!JSON.stringify(events).includes(secret));
});

test('timeout, cancellation and disposal terminate behavior work without late results or document writes', async t => {
  const f = await behaviorFixture({ runtimeOptions: { timeoutCeilingMs: 80 } }); t.after(f.close);
  let release; f.sourceHook = input => new Promise(resolve => { release = () => resolve(input); });
  const before = JSON.stringify(f.workspace.gameSnapshot());
  await assert.rejects(query(f), e => e.code === 'tool.timeout'); release();
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before);
  assert.equal(f.runtime.snapshot().activeCalls, 0);
  const live = await behaviorFixture({ declarative: true }); t.after(live.close);
  const controller = new AbortController();
  const prepared = await live.runtime.prepare(call('call:cancel-analysis', 'behavior.query', { baseRevision: revision(live) }));
  const pending = live.runtime.execute(prepared.id, controller.signal); const rejected = assert.rejects(pending);
  await new Promise(resolve => setTimeout(resolve, 30)); controller.abort(); await live.runtime.dispose(); await rejected;
  await live.runtime.dispose(); assert.equal(live.runtime.snapshot().activeCalls, 0);
  const events = await live.operationLog.query({ toolCallId: 'call:cancel-analysis', limit: 50, traverseCorrelation: false });
  assert.equal(events.events.some(e => e.kind === 'tool/execution-completed'), false);
});
