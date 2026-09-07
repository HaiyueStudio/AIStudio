import { ProviderFixture, nodes, waitFor } from './agent-tools/provider-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessApiKeyBackend, CodexAppServerBackend } from '@haiyue/ai-studio-agent-backends';
import { AgentBackendRegistry, AgentTurnRuntime, DurableSessionRuntime, PromptContextRuntime, TaskAccountingRegistry } from '@haiyue/ai-studio-agent-runtime';
import { GAME_AUTHORING_TOOL_DEFINITIONS, MODEL_CORE_TOOL_IDS, MODEL_TOOL_INVOKE_DEFINITION, ToolCatalogRuntime } from '@haiyue/ai-studio-game-authoring-tools';
import { OperationLog, sha256, canonicalStringify } from '@haiyue/ai-studio-operation-log';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';

for (const kind of ['harness', 'codex']) test(`${kind}: omitted tools execute after search through the real backend adapter and retain policy/replay`, { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-tool-discovery-'));
  const fixture = new ProviderFixture(kind);
  const backend = kind === 'harness'
    ? new HarnessApiKeyBackend({ transport: fixture.harnessTransport(), clearApiKey: async () => {} })
    : new CodexAppServerBackend({ transport: fixture, isolatedCwd: directory });
  const log = await OperationLog.open({ rootDirectory: path.join(directory, 'log'), appVersion: 'tool-discovery-test' });
  const context = new PromptContextRuntime(log); await context.initialize();
  const registry = new AgentBackendRegistry(); registry.register(backend);
  const turns = new AgentTurnRuntime(registry, log, context);
  const sessions = new DurableSessionRuntime(log);
  const runtime = { registry, turns, sessions, context, usage: turns.usage, accounting: new TaskAccountingRegistry(turns.usage) };
  const tools = toolService();
  const host = new StudioConversationHost({ runtime, tools, operationLog: log, isProjectOpen: () => true,
    projectContext: () => ({ projectId: 'project:discovery', documentId: 'document:discovery', revision: tools.revision, manifest: {} }),
  });
  fixture.program = async request => {
    const readSearch = await request('call:search-read', 'tool.search', { text: 'camera.get', includeSchemas: true, limit: 1 });
    const read = readSearch.value.matches[0];
    assert.equal(read.id, 'camera.get');
    const readResult = await request('call:invoke-read', read.invocation.tool, { toolId: read.id, toolVersion: read.version, arguments: {} });
    assert.equal(readResult.status, 'completed');
    assert.equal(readResult.value.camera, 'current');

    const search = await request('call:search-script', 'tool.search', { text: 'script.apply', includeSchemas: true, limit: 1 });
    const match = search.value.matches[0];
    const args = { toolId: match.invocation.toolId, toolVersion: match.invocation.toolVersion, arguments: { baseRevision: 1, proposalId: 'script-proposal:discovery' } };
    assert.equal(match.id, 'script.apply');
    assert.ok(match.inputSchema.properties.proposalId);
    for (const [id, malformed, code] of [
      ['unknown', { ...args, toolId: 'shell.exec' }, 'tool.not-found'],
      ['recursive', { ...args, toolId: MODEL_TOOL_INVOKE_DEFINITION.id }, 'tool.not-found'],
      ['version', { ...args, toolVersion: '99.0.0' }, 'tool.version-mismatch'],
      ['policy', { ...args, effect: 'observe' }, 'tool.invocation-invalid'],
      ['plan', args, 'plan.approval-required'],
    ]) {
      const result = await request(`call:reject-${id}`, match.invocation.tool, malformed);
      assert.equal(result.status, 'failed'); assert.equal(result.error.code, code);
    }
    await request('call:plan', 'studio.plan.propose', { title: 'Apply a discovered script', summary: 'Submit the existing validated script proposal.', items: [{ label: 'Apply script', details: 'Use the discovered tool with exact one-shot authorization.' }] });
    const stale = await request('call:stale-revision', match.invocation.tool, { ...args, arguments: { ...args.arguments, baseRevision: 0 } });
    assert.equal(stale.error.code, 'tool.stale-revision');
    const applied = await request('call:invoke-script', match.invocation.tool, args);
    assert.equal(applied.status, 'completed'); assert.equal(applied.afterRevision, 2);
  };
  try {
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId: backend.descriptor.id, prompt: 'Inspect the camera, then apply the existing script proposal.' });
    await waitFor(() => fixture.error || nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
    if (fixture.error) throw fixture.error;
    const plan = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => fixture.error || nodes(host).some(node => node.kind === 'approval' && node.status === 'pending'));
    if (fixture.error) throw fixture.error;
    assert.equal(tools.executions, 0, 'discovering and routing must not approve trusted code');
    assert.equal(tools.approvalRecord.toolId, 'script.apply');
    assert.equal(tools.approvalRecord.effect, 'trusted-code');
    await host.dispatch({ type: 'conversation/resolve-approval', approvalId: tools.approvalRecord.approvalId, decision: 'allow-once' });
    await waitFor(() => host.replay().busy === false);
    if (fixture.error) throw fixture.error;
    assert.equal(fixture.finished, true);
    assert.equal(fixture.starts, 1, 'search must not restart or replace the provider turn');
    assert.ok(fixture.toolIds.includes(MODEL_TOOL_INVOKE_DEFINITION.id));
    assert.ok(!fixture.toolIds.includes('camera.get') && !fixture.toolIds.includes('script.apply'));
    assert.equal(tools.executions, 1);
    assert.deepEqual(tools.prepared.map(call => call.toolId), ['tool.search', 'camera.get', 'tool.search', 'script.apply', 'script.apply']);
    assert.equal(tools.prepared.at(-1).id, 'call:invoke-script', 'the original provider call id must survive routing');
    const snapshot = await sessions.replay(fixture.sessionId);
    const readOp = snapshot.ops.find(op => op.kind === 'tool.started' && op.payload.toolCallId === 'call:invoke-read');
    const applyOp = snapshot.ops.find(op => op.kind === 'tool.started' && op.payload.toolCallId === 'call:invoke-script');
    assert.equal(readOp.payload.executionClass, 'parallel-read');
    assert.equal(applyOp.payload.toolId, 'script.apply');
    assert.equal(applyOp.payload.invokedVia, MODEL_TOOL_INVOKE_DEFINITION.id);
    assert.equal(applyOp.payload.executionClass, 'trusted-code-barrier');
    assert.ok(applyOp.payload.effects.includes('approval'));
    assert.equal(nodes(host).find(node => node.kind === 'tool-result' && node.content.toolCallId === 'call:invoke-script').content.toolId, 'script.apply');
    await host.dispose(); await turns.dispose(); await sessions.dispose(); await log.close();
    const reopened = await OperationLog.open({ rootDirectory: path.join(directory, 'log'), appVersion: 'tool-discovery-test' });
    const replayRuntime = new DurableSessionRuntime(reopened);
    try { assert.equal((await replayRuntime.replay(fixture.sessionId)).surface.digest, snapshot.surface.digest); }
    finally { await replayRuntime.dispose(); await reopened.close(); }
    assert.equal(tools.executions, 1, 'replay must not repeat the routed effect');
  } finally {
    await host.dispose(); await turns.dispose(); await sessions.dispose(); await log.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function toolService() {
  const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => []);
  const preparations = new Map();
  return {
    revision: 1, executions: 0, prepared: [], approvalRecord: null,
    definitions: () => GAME_AUTHORING_TOOL_DEFINITIONS,
    selectDefinitions: () => ({ definitions: GAME_AUTHORING_TOOL_DEFINITIONS.filter(tool => MODEL_CORE_TOOL_IDS.includes(tool.id)) }),
    async prepare(call) {
      this.prepared.push(call);
      const definition = GAME_AUTHORING_TOOL_DEFINITIONS.find(tool => tool.id === call.toolId);
      if (call.toolId === 'script.apply' && call.arguments.baseRevision !== this.revision) throw Object.assign(new Error('Stale revision'), { code: 'tool.stale-revision' });
      const result = { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: definition.version,
        effect: definition.effect, risk: definition.risk, documentId: 'document:discovery', baseRevision: this.revision,
        argumentsDigest: sha256(canonicalStringify(call.arguments)), previewDigest: sha256('preview'), preview: { title: definition.title, target: 'Current project', summary: definition.title, diff: '' }, status: definition.requiresApproval ? 'approval-required' : 'ready',
        ...(definition.requiresApproval ? { approvalId: `approval:${call.id}` } : {}),
      };
      preparations.set(result.id, { call, result });
      if (result.approvalId) this.approvalRecord = { ...result, schemaVersion: 1, preparationId: result.id, toolCallId: call.id, target: 'Current project', decision: 'pending' };
      return result;
    },
    approval() { return this.approvalRecord; },
    async decide(_id, decision) { this.approvalRecord = { ...this.approvalRecord, decision }; return this.approvalRecord; },
    async execute(id) {
      const { call, result } = preparations.get(id);
      let value;
      if (call.toolId === 'tool.search') value = { matches: catalog.search(call.arguments.text, call.arguments) };
      else if (call.toolId === 'camera.get') value = { camera: 'current' };
      else { assert.equal(call.toolId, 'script.apply'); assert.equal(this.approvalRecord.decision, 'allow-once'); this.executions += 1; this.revision += 1; value = { scriptId: 'script:discovery' }; }
      return { schemaVersion: 1, callId: call.id, toolId: call.toolId, status: 'completed', value, documentId: result.documentId, beforeRevision: result.baseRevision, afterRevision: this.revision };
    },
  };
}

