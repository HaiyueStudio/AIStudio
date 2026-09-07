import assert from 'node:assert/strict';
import test from 'node:test';
import { HarnessApiKeyBackend, CodexAppServerBackend } from '@haiyue/ai-studio-agent-backends';
import { AgentBackendRegistry, AgentTurnRuntime, DurableSessionRuntime, PromptContextRuntime, TaskAccountingRegistry } from '@haiyue/ai-studio-agent-runtime';
import { MODEL_CORE_TOOL_IDS, MODEL_TOOL_INVOKE_DEFINITION, ToolCatalogRuntime } from '@haiyue/ai-studio-game-authoring-tools';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';
import { behaviorFixture, timer } from '../../../../packages/game-authoring-tools/test/behavior-fixture.mjs';
import { ProviderFixture, nodes, waitFor } from './provider-fixture.mjs';

// Only provider transports are simulated. Search, policy, tools, analysis workers,
// project storage, Document/History and durable execution records are production services.
for (const kind of ['harness', 'codex']) test(`${kind}: discovered behavior tools execute real analysis with approval, provenance and replay`, { timeout: 30_000 }, async t => {
  const f = await behaviorFixture({ declarative: true, script: kind === 'harness' ? 'if (api.input.isDown("ArrowUp")) Math.sin(time);' : '' });
  const fixture = new ProviderFixture(kind), log = f.operationLog;
  const backend = kind === 'harness' ? new HarnessApiKeyBackend({ transport: fixture.harnessTransport(), clearApiKey: async () => {} }) : new CodexAppServerBackend({ transport: fixture, isolatedCwd: f.directory });
  const context = new PromptContextRuntime(log); await context.initialize();
  const registry = new AgentBackendRegistry(); registry.register(backend);
  const turns = new AgentTurnRuntime(registry, log, context), sessions = new DurableSessionRuntime(log);
  const runtime = { registry, turns, sessions, context, usage: turns.usage, accounting: new TaskAccountingRegistry(turns.usage) };
  // Exercise the real selector at its supported core-only budget so all three
  // behavior tools must be discovered within this same provider turn.
  const catalog = new ToolCatalogRuntime(f.runtime.definitions(), () => f.workspace.componentRegistry.snapshot().definitions);
  const tools = new Proxy(f.runtime, { get(target, key) { if (key === 'selectDefinitions') return text => catalog.selectDefinitions(text, [], MODEL_CORE_TOOL_IDS.length); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  const projectContext = () => ({ ...f.workspace.snapshot().document, documentId: f.workspace.gameSnapshot().id, manifest: {} });
  const host = new StudioConversationHost({ runtime, tools, operationLog: log, isProjectOpen: () => true, projectContext });
  t.after(async () => { await host.dispose(); await turns.dispose(); await sessions.dispose(); await f.close(); });
  const initialRevision = f.workspace.snapshot().document.revision, initialDocument = JSON.stringify(f.workspace.gameSnapshot());
  let first;
  fixture.program = async request => {
    const discovered = {};
    for (const id of ['behavior.query', 'behavior.locate', 'behavior.explain', 'component.configure', 'entity.rename']) {
      const result = await request(`call:search-${id}`, 'tool.search', { text: id, includeSchemas: true, limit: 1 });
      assert.equal(result.status, 'completed'); const match = result.value.matches[0]; assert.equal(match.id, id);
      assert.equal(match.version, '1.0.0'); assert.ok(match.inputSchema.properties.baseRevision);
      discovered[id] = match;
    }
    const invoke = (callId, toolId, args) => request(callId, discovered[toolId].invocation.tool, { toolId, toolVersion: discovered[toolId].invocation.toolVersion, arguments: args });
    first = await invoke('call:behavior-query', 'behavior.query', { baseRevision: initialRevision, limit: 100 });
    assert.equal(first.status, 'completed'); assert.equal(first.value.binding.projectId, f.workspace.snapshot().document.projectId);
    assert.ok(first.value.nodes.some(node => node.source.kind === 'declarative-component'));
    assert.equal(first.value.nodes.some(node => node.source.kind === 'script'), kind === 'harness');
    const node = first.value.nodes.find(node => node.kind === 'trigger');
    const bound = { baseRevision: initialRevision, manifestDigest: first.value.manifestDigest, sourceBindingDigest: first.value.binding.digest };
    const located = await invoke('call:behavior-locate', 'behavior.locate', { ...bound, nodeId: node.id });
    assert.equal(located.status, 'completed'); assert.equal(located.value.binding.digest, first.value.binding.digest);
    const explained = await invoke('call:behavior-explain', 'behavior.explain', { ...bound, nodeIds: [node.id], language: 'zh-CN' });
    assert.equal(explained.status, 'completed'); assert.equal(explained.value.explanation.producer.kind, 'verified-structure');
    assert.deepEqual(explained.value.explanation.entries[0].evidence, [node.source]);
    assert.equal(JSON.stringify(f.workspace.gameSnapshot()), initialDocument);
    for (const [id, payload, code] of [
      ['unknown', { toolId: 'scene.transaction', toolVersion: '1.0.0', arguments: {} }, 'tool.not-found'],
      ['version', { toolId: 'behavior.query', toolVersion: '2.0.0', arguments: {} }, 'tool.version-mismatch'],
      ['schema', { toolId: 'behavior.query', toolVersion: '1.0.0', arguments: { baseRevision: initialRevision, limit: null } }, 'tool.arguments-invalid'],
      ['risk', { toolId: 'behavior.query', toolVersion: '1.0.0', arguments: { baseRevision: initialRevision }, risk: 'low' }, 'tool.invocation-invalid'],
    ]) { const result = await request(`call:reject-${id}`, MODEL_TOOL_INVOKE_DEFINITION.id, payload); assert.equal(result.error.code, code); }
    const edit = { baseRevision: initialRevision, action: 'upsert', entityId: f.entityId, type: 'haiyue.gameplay.timers', patch: { timers: [{ ...timer, durationTicks: 20 }] } };
    assert.equal((await invoke('call:edit-without-plan', 'component.configure', edit)).error.code, 'plan.approval-required');
    await request('call:behavior-plan', 'studio.plan.propose', { title: 'Name the controller and change the timer', summary: 'Use existing entity and component tools.', items: [{ label: 'Update controller', details: 'Name it Timer Controller and change duration from 10 to 20 ticks.' }] });
    assert.equal((await invoke('call:edit-stale', 'component.configure', { ...edit, baseRevision: initialRevision - 1 })).error.code, 'tool.stale-revision');
    const renamed = await invoke('call:behavior-authorize', 'entity.rename', { baseRevision: initialRevision, entityId: f.entityId, name: 'Timer Controller' });
    assert.equal(renamed.status, 'completed'); assert.equal(renamed.afterRevision, initialRevision + 1);
    const edited = await invoke('call:behavior-edit', 'component.configure', { ...edit, baseRevision: renamed.afterRevision });
    assert.equal(edited.status, 'completed'); assert.equal(edited.afterRevision, initialRevision + 2);
    assert.equal((await invoke('call:behavior-stale-location', 'behavior.locate', { ...bound, nodeId: node.id })).error.code, 'tool.stale-revision');
    assert.equal((await invoke('call:behavior-stale-binding', 'behavior.query', { ...bound, baseRevision: edited.afterRevision })).error.code, 'behavior.stale');
    const fresh = await invoke('call:behavior-fresh', 'behavior.query', { baseRevision: edited.afterRevision });
    assert.equal(fresh.status, 'completed'); assert.notEqual(fresh.value.manifestDigest, first.value.manifestDigest);
  };
  await host.initialize();
  await host.dispatch({ type: 'conversation/send', backendId: backend.descriptor.id, prompt: 'Inspect this project, explain the timer, then change its duration to 20 ticks.' });
  await waitFor(() => fixture.error || nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
  if (fixture.error) throw fixture.error;
  const plan = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
  await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
  await waitFor(() => fixture.error || nodes(host).some(node => node.kind === 'approval' && node.status === 'pending'));
  if (fixture.error) throw fixture.error;
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), initialDocument);
  const approval = nodes(host).find(node => node.kind === 'approval' && node.status === 'pending');
  const record = f.runtime.approval(approval.content.approvalId);
  assert.equal(record.toolId, 'entity.rename'); assert.equal(record.effect, 'reversible-edit');
  await host.dispatch({ type: 'conversation/resolve-approval', approvalId: record.approvalId, decision: 'allow-once' });
  await waitFor(() => fixture.error || host.replay().busy === false);
  if (fixture.error) throw fixture.error;
  assert.equal(fixture.finished, true); assert.equal(fixture.starts, 1); assert.equal(f.preview.starts, 0);
  assert.ok(['behavior.query','behavior.locate','behavior.explain'].every(id => !fixture.toolIds.includes(id)));
  const replay = await sessions.replay(fixture.sessionId);
  for (const [callId, toolId] of [['call:behavior-query','behavior.query'], ['call:behavior-authorize','entity.rename'], ['call:behavior-edit','component.configure']]) {
    const started = replay.ops.find(op => op.kind === 'tool.started' && op.payload.toolCallId === callId);
    assert.equal(started.payload.toolId, toolId); assert.equal(started.payload.invokedVia, MODEL_TOOL_INVOKE_DEFINITION.id);
    assert.equal(nodes(host).find(node => node.kind === 'tool-result' && node.content.toolCallId === callId).content.toolId, toolId);
    const events = await log.query({ toolCallId: callId, limit: 50, traverseCorrelation: false });
    assert.ok(events.events.some(event => event.kind === 'tool/execution-completed'));
  }
  const after = JSON.stringify(f.workspace.gameSnapshot());
  assert.equal((await sessions.replay(fixture.sessionId)).surface.digest, replay.surface.digest);
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), after);
});
