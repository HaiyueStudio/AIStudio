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
import { AgentBackendRegistry, AgentTurnRuntime, DurableSessionRuntime, PromptContextRuntime, TaskAccountingRegistry, ModelContextRuntime } from '@haiyue/ai-studio-agent-runtime';
import { GAME_AUTHORING_TOOL_DEFINITIONS } from '@haiyue/ai-studio-game-authoring-tools';
import { OperationLog, sha256, canonicalStringify } from '@haiyue/ai-studio-operation-log';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';

const nodes = host => [...new Map(host.replay().events.map(item => [item.node.id, item.node])).values()];
async function waitFor(predicate) { const end = Date.now() + 10000; while (!predicate()) { if (Date.now() > end) throw new Error('Host did not dispatch independent reads before their results.'); await delay(5); } }
function response(delta, reason) { return messagesResponse({ text: delta.content, calls: (delta.tool_calls ?? []).map(c => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })), tokens: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } }); }

test('W3 actual requests compact within one Harness turn and publish the confirmed Surface and per-request frames', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'haiyue-w3-host-'));
  const root = createHarnessStudioRoot();
  const transport = await createPinnedHarnessAgentTransport({ owner: root, resolveApiKey: async () => 'fixture-only', contextWindow: 50_000 });
  const backend = new HarnessApiKeyBackend({ transport, clearApiKey: async () => {} });
  const log = await OperationLog.open({ rootDirectory: path.join(directory, 'log'), appVersion: 'w3-test' });
  const registry = new AgentBackendRegistry(); registry.register(backend);
  const context = new PromptContextRuntime(log), sessions = new DurableSessionRuntime(log), turns = new AgentTurnRuntime(registry, log, context, sessions);
  const modelContexts = new ModelContextRuntime(log, sessions);
  const requests = [], preparations = new Map(); let sessionId;
  const tools = {
    definitions: () => GAME_AUTHORING_TOOL_DEFINITIONS,
    selectDefinitions: () => ({ definitions: GAME_AUTHORING_TOOL_DEFINITIONS.filter(t => t.id === 'scene.query') }),
    async prepare(call) {
      sessionId = call.sessionId;
      const value = { id: `prepare:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: 'document:w3', baseRevision: 7, argumentsDigest: sha256(canonicalStringify(call.arguments)), previewDigest: sha256('preview'), preview: { title: 'Read', target: 'Scene', summary: 'Read', diff: '' }, status: 'ready' };
      preparations.set(value.id, value); return value;
    },
    async execute(id) {
      const p = preparations.get(id);
      return { schemaVersion: 1, callId: p.callId, toolId: p.toolId, status: 'completed', value: { revision: 7, entityId: 'entity:target', details: 'historicaldata'.repeat(3500) }, documentId: p.documentId, beforeRevision: 7, afterRevision: 7 };
    },
  };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (requests.length > 3) return response({ content: 'Inspection finished.' }, 'stop');
    const name = body.tools.find(t => t.description.endsWith('Studio tool id: scene.query')).name;
    return response({ content: 'Inspect next slice.', tool_calls: [{ index: 0, id: `call-w3-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify({ revision: 7, projection: ['hierarchy'] }) } }] }, 'tool_calls');
  });
  const host = new StudioConversationHost({ runtime: { registry, turns, sessions, context, modelContexts, usage: turns.usage, accounting: new TaskAccountingRegistry(turns.usage) }, tools, operationLog: log,
    isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:w3', documentId: 'document:w3', revision: 7, manifest: { revision: 7 } }) });
  try {
    await host.initialize(); await host.dispatch({ type: 'agent/configure', budget: host.settings().budget, backendId: backend.descriptor.id, model: 'deepseek-flash', reasoningEffort: 'off', outputTokenLimit: 8192 }); await host.dispatch({ type: 'conversation/send', backendId: backend.descriptor.id, prompt: 'Inspect scene facts; do not modify the project.' });
    await waitFor(() => !host.replay().busy).catch(cause => { t.diagnostic(JSON.stringify({ requests: requests.length, nodes: nodes(host).slice(-8) }).slice(-6000)); throw cause; });
    assert.equal(requests.length, 4, JSON.stringify(nodes(host).filter(n => n.kind === 'diagnostic')));
    const prepared = await log.query({ kinds: ['agent/model-request-prepared'], sessionId, limit: 20 });
    const replacements = prepared.events.filter(e => e.payload.replacementPrepared).length;
    assert.ok(replacements >= 1);
    assert.equal(prepared.events.length, 4 + replacements);
    const candidate = prepared.events.find(e => e.payload.replacementPrepared);
    assert.ok(prepared.events.at(-1).payload.requestBytes < candidate.payload.requestBytes * 0.8);
    assert.match(JSON.stringify(requests[2]), /AIStudio request recovery/);
    assert.equal(results(requests.at(-1)).at(-1).tool_use_id, 'call-w3-3');
    const snapshot = await sessions.replay(sessionId);
    assert.equal(snapshot.surface.generation, replacements);
    assert.equal(snapshot.ops.filter(op => op.kind === 'compaction.completed').length, replacements);
    const frames = snapshot.ops.filter(op => op.payload.evidenceKind === 'context-frame');
    assert.equal(frames.length, 4, JSON.stringify((await log.query({ kinds: ['conversation/context-frame-unavailable'], limit: 20 })).events));
    for (const op of frames) {
      const frame = await log.readArtifact(op.payload.contextFrameArtifactId);
      const manifest = await log.readArtifact(frame.value.inputs[0].artifactId);
      assert.ok(manifest.value.toolsArtifactId, 'UI frame must measure the actual request manifest');
    }
    assert.equal(snapshot.recovery.openToolNodeIds.length, 0);
    assert.equal(snapshot.recovery.openTurnIds.length, 0);
  } finally { await host.dispose(); await turns.dispose(); await modelContexts.dispose(); await sessions.dispose(); await root.dispose(); await log.close(); await rm(directory, { recursive: true, force: true }); }
});
