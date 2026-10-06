import { response as messagesResponse, results, resultText } from '../../../packages/harness-bridge/test/fixtures/messages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessStudioRoot } from '@haiyue/ai-studio-harness-bridge';
import { createPinnedHarnessAgentTransport } from '@haiyue/ai-studio-harness-bridge/agent';
import { HarnessApiKeyBackend } from '@haiyue/ai-studio-agent-backends';
import { AgentBackendRegistry, AgentTurnRuntime, DurableSessionRuntime, PromptContextRuntime, TaskAccountingRegistry } from '@haiyue/ai-studio-agent-runtime';
import { GAME_AUTHORING_TOOL_DEFINITIONS } from '@haiyue/ai-studio-game-authoring-tools';
import { OperationLog, sha256, canonicalStringify } from '@haiyue/ai-studio-operation-log';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';
function response(delta, reason) { return messagesResponse({ text: delta.content, calls: (delta.tool_calls ?? []).map(c => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })), tokens: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } }); }


for (const mode of ['reads', 'transaction', 'failure']) test(`W6 pinned Harness closed DAG through Host and durable replay: ${mode}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'haiyue-w6-host-'));
  const root = createHarnessStudioRoot();
  const transport = await createPinnedHarnessAgentTransport({ owner: root, resolveApiKey: async () => 'fixture-only', contextWindow: 200000 });
  const backend = new HarnessApiKeyBackend({ transport, clearApiKey: async () => {} });
  const log = await OperationLog.open({ rootDirectory: path.join(directory, 'log'), appVersion: 'w6-test' });
  const registry = new AgentBackendRegistry(); registry.register(backend);
  const context = new PromptContextRuntime(log), sessions = new DurableSessionRuntime(log), turns = new AgentTurnRuntime(registry, log, context, sessions);
  const requests = [], preparations = new Map(), events = [];
  let revision = 7, active = 0, peak = 0, transactionCalls = 0, result, runSessionId;
  let markTransaction, markDocs;
  const transactionStarted = new Promise(resolve => { markTransaction = resolve; });
  const docsStarted = new Promise(resolve => { markDocs = resolve; });
  const member = (id, toolId, dependsOn = [], args = {}) => ({ id, toolId, toolVersion: GAME_AUTHORING_TOOL_DEFINITIONS.find(d => d.id === toolId).version, arguments: args, dependsOn, estimatedWorkMs: 100, onFailure: 'cancel-dependents' });
  const nodes = mode === 'transaction'
    ? [member('edit:one', 'entity.create', [], { baseRevision: 7, kind: 'cube', name: 'One' }), member('edit:two', 'entity.create', [], { baseRevision: 7, kind: 'cube', name: 'Two' }), member('read:docs', 'engine.docs.search', [], { text: 'camera' }), member('read:state', 'scene.query')]
    : [member('read:dependent', 'scene.query', ['read:source'], { name: 'dependent' }), member('read:independent', 'diagnostics.query'), member('read:source', 'scene.query', [], { name: 'source' })];
  const tools = {
    definitions: () => GAME_AUTHORING_TOOL_DEFINITIONS, selectDefinitions: () => ({ definitions: GAME_AUTHORING_TOOL_DEFINITIONS.filter(d => ['scene.query', 'tool.search'].includes(d.id)) }),
    async prepare(call) {
      runSessionId = call.sessionId;
      const def = GAME_AUTHORING_TOOL_DEFINITIONS.find(d => d.id === call.toolId);
      const value = { id: `prepare:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: def.version, effect: def.effect, risk: 'low', documentId: 'document:w6', baseRevision: revision, argumentsDigest: sha256(canonicalStringify(call.arguments)), previewDigest: sha256('preview'), preview: { title: 'Work', target: 'Scene', summary: 'Work', diff: '' }, status: 'ready', args: call.arguments };
      preparations.set(value.id, value); return value;
    },
    async execute(id) {
      const p = preparations.get(id); active++; peak = Math.max(peak, active); events.push(`start:${p.args.name ?? p.toolId}`);
      assert.notEqual(p.toolId, 'entity.create', 'independent edits must use the shared transaction');
      if (mode === 'transaction' && p.toolId === 'engine.docs.search') { await transactionStarted; markDocs(); }
      if (mode === 'transaction' && p.toolId === 'scene.query') assert.equal(revision, 8, 'state reads wait for commit');
      await delay(p.args.name === 'source' ? 35 : 10); active--; events.push(`end:${p.args.name ?? p.toolId}`);
      const status = mode === 'failure' && p.args.name === 'source' ? 'failed' : 'completed';
      return { schemaVersion: 1, callId: p.callId, toolId: p.toolId, status, value: { revision, entities: [{ id: 'entity:known' }] }, documentId: p.documentId, beforeRevision: revision, afterRevision: revision };
    },
    async executeTransaction(input) {
      transactionCalls++; markTransaction(); await docsStarted; revision = 8;
      const receipt = await log.putArtifact({ transactionId: 'transaction:w6', beforeRevision: 7, afterRevision: 8 }, { schemaVersion: 'w6-fixture/1' });
      const transaction = { transactionId: 'transaction:w6', idempotencyKey: 'idempotency:w6', receiptDigest: `sha256:${receipt.digest}`, receiptArtifactId: receipt.id, memberCount: 2, replayed: false };
      return { ...transaction, beforeRevision: 7, afterRevision: 8, results: input.preparationIds.map(id => { const p = preparations.get(id); return { schemaVersion: 1, callId: p.callId, toolId: p.toolId, status: 'completed', value: { entityId: `entity:${p.args.name}` }, documentId: p.documentId, beforeRevision: 7, afterRevision: 8, transaction }; }) };
    }, async cancel() {},
  };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (requests.length === 1 && mode === 'transaction') {
      const name = body.tools.find(t => t.description.endsWith('Studio tool id: studio.plan.propose')).name;
      return response({ tool_calls: [{ index: 0, id: 'call-w6-plan', type: 'function', function: { name, arguments: JSON.stringify({ title: 'Create', summary: 'Two independent edits with docs', assemblies: [], items: [{ label: 'Create', details: 'Create two cubes' }] }) } }] }, 'tool_calls');
    }
    if (requests.length === (mode === 'transaction' ? 3 : 2)) {
      const messages = results(body);
      assert.equal(messages.at(-1).tool_use_id, 'call-w6-batch');
      result = JSON.parse(resultText(messages.at(-1)));
      assert.deepEqual(result.results.map(r => r.id), nodes.map(n => n.id));
      return response({ content: 'Finished the bounded batch.' }, 'stop');
    }
    const name = body.tools.find(t => t.description.endsWith('Studio tool id: studio.tool.batch')).name;
    return response({ tool_calls: [{ index: 0, id: 'call-w6-batch', type: 'function', function: { name, arguments: JSON.stringify({ schemaVersion: 1, nodes }) } }] }, 'tool_calls');
  });
  const host = new StudioConversationHost({ runtime: { registry, turns, sessions, context, usage: turns.usage, accounting: new TaskAccountingRegistry(turns.usage) }, tools, operationLog: log,
    isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:w6', documentId: 'document:w6', revision, manifest: {} }) });
  try {
    await host.initialize(); await host.dispatch({ type: 'agent/configure', budget: host.settings().budget, backendId: backend.descriptor.id, model: 'deepseek-flash', reasoningEffort: 'off', outputTokenLimit: 8192 });
    await host.dispatch({ type: 'conversation/send', backendId: backend.descriptor.id, prompt: 'Execute the known-input fixture DAG.' });
    let approved = false;
    for (let i = 0; host.replay().busy && i < 2500; i++) {
      if (mode === 'transaction' && !approved) {
        const plan = host.replay().events.map(e => e.node).find(n => n.kind === 'plan' && n.status === 'pending');
        if (plan) { approved = true; await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(i => i.id), mode: 'approve' }); }
      }
      await delay(5);
    }
    assert.equal(host.replay().busy, false); assert.ok(result, JSON.stringify(host.replay().events.slice(-5)));
    assert.equal(requests.length, mode === 'transaction' ? 3 : 2); assert.equal(result.schedule.strategy, 'parallel');
    if (mode === 'transaction') { assert.equal(transactionCalls, 1); assert.equal(revision, 8); assert.equal(result.results[0].result.transaction?.transactionId, 'transaction:w6', JSON.stringify(result)); }
    else { assert.equal(peak, 2); if (mode === 'failure') { assert.equal(result.results[0].result.status, 'cancelled'); assert.ok(!events.includes('start:dependent')); } else assert.ok(events.indexOf('end:source') < events.indexOf('start:dependent')); }
    const snapshot = await (await sessions.open(runSessionId)).snapshot();
    const turnId = snapshot.ops.find(op => op.kind === 'tool.completed' && op.payload.toolId === 'studio.tool.batch').turnId;
    const usageRecord = turns.usage.get(turnId).snapshot().record;
    if (mode !== 'transaction') assert.equal(usageRecord.toolOutputBytes, Buffer.byteLength(canonicalStringify(result)), 'account the provider envelope exactly once, including batch metadata');
    await host.dispose(); await turns.dispose(); await sessions.dispose();
    const recovered = new DurableSessionRuntime(log);
    try {
      const replay = await (await recovered.open(runSessionId)).snapshot();
      assert.deepEqual(replay.ops.filter(op => ['tool.completed', 'document.committed'].includes(op.kind)), snapshot.ops.filter(op => ['tool.completed', 'document.committed'].includes(op.kind)));
      assert.equal(replay.surface.digest, snapshot.surface.digest);
      assert.equal(transactionCalls, mode === 'transaction' ? 1 : 0, 'durable recovery does not replay edits');
    } finally { await recovered.dispose(); }
    t.diagnostic(JSON.stringify({ mode, modelRequests: requests.length, childTools: preparations.size, peakReadBodies: peak, transactions: transactionCalls }));
  } finally { await host.dispose(); await turns.dispose(); await sessions.dispose(); await root.dispose(); await log.close(); await rm(directory, { recursive: true, force: true }); }
});
