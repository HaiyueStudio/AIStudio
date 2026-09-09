import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessApiKeyBackend, CodexAppServerBackend } from '@haiyue/ai-studio-agent-backends';
import { AgentBackendRegistry, AgentTurnRuntime, DurableSessionRuntime, PromptContextRuntime, TaskAccountingRegistry } from '@haiyue/ai-studio-agent-runtime';
import { GAME_AUTHORING_TOOL_DEFINITIONS, ToolCatalogRuntime } from '@haiyue/ai-studio-game-authoring-tools';
import { OperationLog, sha256, canonicalStringify } from '@haiyue/ai-studio-operation-log';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';
import { ProviderFixture, nodes, waitFor } from './agent-tools/provider-fixture.mjs';

const plan = { title: 'Approved interaction scene', summary: 'Create one editable entity and verify interaction and presentation.', items: [{ label: 'Create entity', details: 'Keep the approved entity independently editable. '.repeat(14) + 'Then verify pointer input and screenshot evidence.' }] };
const operation = stage => stage === 1
  ? { id: 'call:contract-plan', toolId: 'studio.plan.propose', args: plan }
  : { id: `call:contract-edit:${stage}`, toolId: 'entity.create', args: { baseRevision: 1, kind: 'cube', name: 'Approved Entity' } };

for (const kind of ['harness', 'codex']) test(`${kind}: durable plan approval rotates a changed tool contract with full context and executes the approved edit`, { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-tool-contract-'));
  const fixture = new ContinuationFixture(kind);
  const backend = kind === 'harness' ? new HarnessApiKeyBackend({ transport: fixture.harnessTransport(), clearApiKey: async () => {} }) : new CodexAppServerBackend({ transport: fixture, isolatedCwd: directory });
  const log = await OperationLog.open({ rootDirectory: path.join(directory, 'log'), appVersion: 'tool-contract-test' });
  const context = new PromptContextRuntime(log); const registry = new AgentBackendRegistry(); registry.register(backend);
  const turns = new AgentTurnRuntime(registry, log, context); const sessions = new DurableSessionRuntime(log);
  const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => []);
  const selections = []; let executions = 0; let revision = 1; const prepared = new Map();
  const tools = {
    definitions: () => GAME_AUTHORING_TOOL_DEFINITIONS,
    selectDefinitions(request) { const selected = catalog.selectDefinitions(request, ['entity.create']); selections.push(selected.selectedIds); return selected; },
    async prepare(call) {
      assert.equal(call.toolId, 'entity.create'); assert.equal(call.arguments.baseRevision, revision);
      const result = { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'low', documentId: 'document:contract', baseRevision: revision, argumentsDigest: sha256(canonicalStringify(call.arguments)), previewDigest: sha256('preview'), preview: { title: 'Create entity', target: 'Scene', summary: 'Create approved entity', diff: '+ entity' }, status: 'ready' };
      prepared.set(result.id, result); return result;
    },
    async execute(id) { const value = prepared.get(id); executions += 1; revision += 1; return { schemaVersion: 1, callId: value.callId, toolId: value.toolId, status: 'completed', value: { entity: { id: 'entity:approved', name: 'Approved Entity' } }, documentId: value.documentId, beforeRevision: value.baseRevision, afterRevision: revision }; },
  };
  const hostOptions = { runtime: { registry, turns, sessions, context, usage: turns.usage, accounting: new TaskAccountingRegistry(turns.usage) }, tools, operationLog: log, sessionRecovery: { async recover() {} }, isProjectOpen: () => true,
    projectContext: () => ({ projectId: 'project:contract', documentId: 'document:contract', revision, manifest: { marker: 'FULL_PROJECT_CONTEXT', revision } }),
  };
  const host = new StudioConversationHost(hostOptions);
  try {
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId: backend.descriptor.id, prompt: 'Inspect the project and propose a plan.' });
    await waitFor(() => fixture.error || !host.replay().busy && nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
    if (fixture.error) throw fixture.error;
    const pending = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
    assert.equal(executions, 0);
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: pending.id, acceptedItemIds: pending.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => fixture.error || !host.replay().busy && fixture.starts >= 2);
    if (fixture.error) throw fixture.error;
    assert.equal(fixture.starts, 2); assert.equal(executions, 1);
    assert.notDeepEqual(selections[0], selections[1], 'the real catalog must change between planning and execution');
    assert.notEqual(fixture.inputs[0].sessionId, fixture.inputs[1].sessionId);
    assert.match(fixture.inputs[1].prompt, /already approved plan/);
    assert.match(fixture.inputs[1].prompt, /FULL_PROJECT_CONTEXT/);
    assert.match(fixture.inputs[1].prompt, /Work only through the supplied Studio tools/);
    assert.doesNotMatch(fixture.inputs[1].prompt, /reference-only/);
    assert.equal(nodes(host).some(node => node.kind === 'diagnostic' && /toolset-drift|operation-failed/.test(node.content.code)), false);
    assert.equal(new Set(nodes(host).filter(node => node.kind === 'plan').map(node => node.id)).size, 1);
    const contexts = await log.query({ kinds: ['agent/context-bundle-prepared'], limit: 10, traverseCorrelation: false });
    assert.ok(contexts.events.some(event => event.payload.sessionReuse === 'tool-contract-changed'));
    const sessionIds = fixture.inputs.map(input => input.sessionId);
    await waitFor(() => sessionIds.every(id => host.replay().executionGraphs.some(graph => graph.sessionId === id)));
    await host.dispose();
    const restarted = new StudioConversationHost(hostOptions);
    try {
      await restarted.initialize();
      for (const id of sessionIds) assert.ok(restarted.replay().executionGraphs.some(graph => graph.sessionId === id), `history must retain stage ${id} after the same task switches sessions`);
      assert.equal(restarted.replay().executionGraphs.find(graph => graph.sessionId === sessionIds[0]).nodes.some(node => node.kind === 'plan'), true);
      assert.equal(restarted.replay().executionGraphs.find(graph => graph.sessionId === sessionIds[1]).nodes.some(node => node.detail.toolId === 'entity.create'), true);
      assert.equal(executions, 1, 'restoring topology must not replay mutations');
    } finally { await restarted.dispose(); }
  } finally {
    await host.dispose(); await turns.dispose(); await sessions.dispose(); await log.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

class ContinuationFixture extends ProviderFixture {
  constructor(kind) {
    super(kind); this.inputs = []; this.threadCount = 0; this.finishedTurns = new Set();
    this.program = async request => { const op = operation(this.starts); const result = await request(op.id, op.toolId, op.args); assert.equal(result.status, this.starts === 1 ? 'cancelled' : 'completed'); };
  }
  harnessTransport() {
    const fixture = this;
    return { ...super.harnessTransport(), cancel: async () => {},
      async *start(input) {
        const stage = ++fixture.starts; const sessionId = input.sessionId ?? `session:contract-harness:${stage}`; const turnId = `turn:contract-harness:${stage}`;
        fixture.inputs.push({ ...input, sessionId });
        yield { type: 'turn-start', sessionId, turnId };
        const op = operation(stage); assert.ok(input.tools.some(tool => tool.id === op.toolId));
        const result = new Promise(resolve => fixture.pending.set(op.id, resolve));
        yield { type: 'tool-request', sessionId, turnId, toolCallId: op.id, toolId: op.toolId, arguments: op.args };
        const response = await result; assert.equal(response.status, stage === 1 ? 'cancelled' : 'completed');
        yield { type: 'turn-end', sessionId, turnId, status: stage === 1 ? 'cancelled' : 'completed', finishReason: stage === 1 ? 'cancelled' : 'stop' };
      },
    };
  }
  async write(line) {
    const frame = JSON.parse(line);
    if (frame.method === 'thread/start') { this.sessionId = `session:contract-codex:${++this.threadCount}`; this.toolIds = []; this.wireNames.clear(); }
    if (frame.method === 'turn/start') { this.turnId = `turn:contract-codex:${this.starts + 1}`; this.inputs.push({ sessionId: frame.params.threadId, prompt: frame.params.input[0].text }); }
    return super.write(line);
  }
  finish() {
    if (this.finishedTurns.has(this.turnId)) return; this.finishedTurns.add(this.turnId);
    this.notify('turn/completed', { threadId: this.sessionId, turn: { id: this.turnId, status: this.error ? 'failed' : this.starts === 1 ? 'interrupted' : 'completed', error: null } });
  }
}
