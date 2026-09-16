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

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const nodes = host => [...new Map(host.replay().events.map(item => [item.node.id, item.node])).values()];
async function waitFor(predicate) { const end = Date.now() + 10000; while (!predicate()) { if (Date.now() > end) throw new Error('Host did not dispatch independent reads before their results.'); await delay(5); } }
function response(delta, reason) { return new Response(`data: ${JSON.stringify({ id: 'host-parallel', choices: [{ index: 0, delta, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }); }

for (const failOne of [false, true]) test(`pinned Harness → backend → Host runs four reads before any result and preserves ordered durable outcomes (failure=${failOne})`, { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'haiyue-w2-host-'));
  const root = createHarnessStudioRoot();
  const transport = await createPinnedHarnessAgentTransport({ owner: root, resolveApiKey: async () => 'fixture-only' });
  const backend = new HarnessApiKeyBackend({ transport, clearApiKey: async () => {} });
  const log = await OperationLog.open({ rootDirectory: path.join(directory, 'log'), appVersion: 'w2-test' });
  const registry = new AgentBackendRegistry(); registry.register(backend);
  const context = new PromptContextRuntime(log), turns = new AgentTurnRuntime(registry, log, context), sessions = new DurableSessionRuntime(log);
  const started = [], finished = [], delivered = [], requests = [], preparations = new Map();
  const gates = Array.from({ length: 4 }, deferred);
  let active = 0, maxActive = 0;
  const definitions = GAME_AUTHORING_TOOL_DEFINITIONS;
  const tools = {
    definitions: () => definitions,
    selectDefinitions: () => ({ definitions: definitions.filter(tool => ['scene.query', 'tool.search'].includes(tool.id)) }),
    async prepare(call) {
      assert.equal(call.toolVersion, '1.0.0');
      const p = { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: 'document:w2', baseRevision: 1, argumentsDigest: sha256(canonicalStringify(call.arguments)), previewDigest: sha256('preview'), preview: { title: 'Read', target: 'Scene', summary: 'Read immutable scene data', diff: '' }, status: 'ready' };
      preparations.set(p.id, p); return p;
    },
    async execute(id) {
      const p = preparations.get(id), index = Number(p.callId.split('-').at(-1));
      started.push(p); active++; maxActive = Math.max(active, maxActive);
      await gates[index].promise; active--; finished.push(p.callId);
      const failed = failOne && index === 1;
      return { schemaVersion: 1, callId: p.callId, toolId: p.toolId, status: failed ? 'failed' : 'completed', value: failed ? { code: 'fixture.read-failed', message: 'Fixture read failed.' } : { revision: 1, entities: [] }, documentId: p.documentId, beforeRevision: 1, afterRevision: 1 };
    },
  };
  const submit = backend.submitToolResult.bind(backend);
  backend.submitToolResult = async (id, result, signal) => { delivered.push({ id, result }); await submit(id, result, signal); };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (requests.length > 1) return response({ content: failOne ? 'One read failed.' : 'Read complete.' }, 'stop');
    const name = id => body.tools.find(tool => tool.function.description.endsWith(`Studio tool id: ${id}`)).function.name;
    return response({ content: 'Reading independent snapshots.', tool_calls: Array.from({ length: 4 }, (_, index) => ({ index, id: `call-w2-${index}`, type: 'function', function: { name: name(index === 3 ? 'studio.tool.invoke' : 'scene.query'), arguments: JSON.stringify(index === 3 ? { toolId: 'scene.get-many', toolVersion: '1.0.0', arguments: { entityIds: ['entity:w2'] } } : { revision: 1, projection: ['hierarchy'] }) } })) }, 'tool_calls');
  });
  const hostOptions = { runtime: { registry, turns, sessions, context, usage: turns.usage, accounting: new TaskAccountingRegistry(turns.usage) }, tools, operationLog: log,
    isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:w2', documentId: 'document:w2', revision: 1, manifest: { revision: 1 } }) };
  const host = new StudioConversationHost(hostOptions);
  try {
    await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId: backend.descriptor.id, prompt: 'Inspect independent scene slices.' });
    await waitFor(() => started.length === 4);
    assert.equal(delivered.length, 0); assert.equal(maxActive, 4);
    assert.equal(started[3].toolId, 'scene.get-many', 'invoke resolves an omitted real target before scheduling');
    for (const i of [3, 2, 1, 0]) { gates[i].resolve(); await waitFor(() => finished.includes(`call-w2-${i}`)); }
    await waitFor(() => !host.replay().busy);
    assert.equal(requests.length, 2);
    assert.deepEqual(delivered.map(item => item.id), [0, 1, 2, 3].map(i => `call-w2-${i}`));
    assert.equal(delivered[1].result.status, failOne ? 'failed' : 'completed');
    assert.deepEqual(requests[1].messages.filter(item => item.role === 'tool').map(item => item.tool_call_id), delivered.map(item => item.id));
    assert.equal(nodes(host).some(node => node.kind === 'tool-call' && node.status === 'pending'), false);
    const snapshot = await sessions.replay(started[0].sessionId);
    assert.equal(snapshot.ops.filter(op => op.kind === 'tool.started').length, 4);
    assert.equal(snapshot.ops.filter(op => op.kind === 'tool.completed').length, 4);
    assert.ok(snapshot.ops.every((op, index) => op.sequence === index));
    await host.dispose();
    const restored = new StudioConversationHost(hostOptions);
    try { await restored.initialize(); assert.equal(started.length, 4, 'history restore must not replay reads or edits'); assert.equal(nodes(restored).filter(node => node.kind === 'tool-call').length, 4); }
    finally { await restored.dispose(); }
  } finally {
    gates.forEach(gate => gate.resolve()); await host.dispose(); await turns.dispose(); await sessions.dispose(); await root.dispose(); await log.close(); await rm(directory, { recursive: true, force: true });
  }
});
