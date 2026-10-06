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

for (const enabled of [true, false]) test(`W4 real Harness delivery preserves next-step fields, raw evidence and rollback flag (${enabled})`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'haiyue-w4-host-'));
  const root = createHarnessStudioRoot();
  const transport = await createPinnedHarnessAgentTransport({ owner: root, resolveApiKey: async () => 'fixture-only', contextWindow: 200000 });
  const backend = new HarnessApiKeyBackend({ transport, clearApiKey: async () => {} });
  const log = await OperationLog.open({ rootDirectory: path.join(directory, 'log'), appVersion: 'w4-test' });
  const registry = new AgentBackendRegistry(); registry.register(backend);
  const context = new PromptContextRuntime(log), sessions = new DurableSessionRuntime(log), turns = new AgentTurnRuntime(registry, log, context, sessions);
  const requests = [], preparations = new Map(), executed = [];
  const native = GAME_AUTHORING_TOOL_DEFINITIONS.filter(t => ['scene.query', 'tool.search'].includes(t.id));
  const query = native.find(t => t.id === 'scene.query');
  const omitted = GAME_AUTHORING_TOOL_DEFINITIONS.find(t => t.id === 'entity.create');
  const matches = [query, omitted].map(t => ({ kind: 'tool', id: t.id, inputSchema: t.inputSchema, version: t.version, nextTool: t.id, invocation: { tool: 'tool.invoke', toolId: t.id, toolVersion: t.version } }));
  const tools = {
    definitions: () => GAME_AUTHORING_TOOL_DEFINITIONS, selectDefinitions: () => ({ definitions: native }),
    async prepare(call) { const value = { id: `prepare:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: 'document:w4', baseRevision: 7, argumentsDigest: sha256(canonicalStringify(call.arguments)), previewDigest: sha256('preview'), preview: { title: 'Read', target: 'Scene', summary: 'Read', diff: '' }, status: 'ready' }; preparations.set(value.id, value); return value; },
    async execute(id) { const p = preparations.get(id); executed.push(p.toolId); return { schemaVersion: 1, callId: p.callId, toolId: p.toolId, status: 'completed', value: p.toolId === 'tool.search' ? { matches, nextCursor: 'cursor:next', total: 10 } : { revision: 7, entities: [{ id: 'entity:target' }], nextCursor: null }, documentId: p.documentId, beforeRevision: 7, afterRevision: 7 }; },
  };
  let firstResult;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (requests.length === 2) {
      firstResult = JSON.parse(resultText(results(body)[0]));
      assert.equal(firstResult.afterRevision, 7); assert.equal(firstResult.value.nextCursor, 'cursor:next');
      assert.equal(firstResult.value.matches[0].nextTool, 'scene.query');
      assert.deepEqual(firstResult.value.matches[1].inputSchema, omitted.inputSchema);
      assert.equal(firstResult.value.matches[0].inputSchema === undefined, enabled);
    }
    if (requests.length === 3) {
      const result = JSON.parse(resultText(results(body).at(-1)));
      assert.equal(result.value.entities[0].id, 'entity:target'); assert.equal(result.afterRevision, 7);
      return response({ content: 'Inspection finished.' }, 'stop');
    }
    const id = requests.length === 1 ? 'tool.search' : firstResult.value.matches[0].nextTool;
    const name = body.tools.find(t => t.description.endsWith(`Studio tool id: ${id}`)).name;
    const args = id === 'tool.search' ? { text: 'scene', includeSchemas: true } : { revision: firstResult.afterRevision, projection: ['hierarchy'] };
    return response({ tool_calls: [{ index: 0, id: `call-w4-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
  });
  const host = new StudioConversationHost({ runtime: { registry, turns, sessions, context, usage: turns.usage, accounting: new TaskAccountingRegistry(turns.usage) }, tools, operationLog: log, compactToolResults: enabled,
    isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:w4', documentId: 'document:w4', revision: 7, manifest: { revision: 7 } }) });
  try {
    await host.initialize(); await host.dispatch({ type: 'agent/configure', budget: host.settings().budget, backendId: backend.descriptor.id, model: 'deepseek-flash', reasoningEffort: 'off', outputTokenLimit: 8192 });
    await host.dispatch({ type: 'conversation/send', backendId: backend.descriptor.id, prompt: 'Discover scene tools and inspect the current scene; do not modify it.' });
    const end = Date.now() + 12000; while (host.replay().busy && Date.now() < end) await delay(5);
    assert.equal(host.replay().busy, false); assert.equal(requests.length, 3, JSON.stringify(host.replay().events.filter(e => e.node.kind === 'diagnostic'))); assert.deepEqual(executed, ['tool.search', 'scene.query']);
    const events = await log.query({ kinds: ['agent/tool-result-projected'], limit: 10 });
    assert.equal(events.events.length, enabled ? 1 : 0);
    if (enabled) {
      const raw = await log.readArtifact(firstResult.artifactRef.id);
      assert.deepEqual(raw.value.value.matches, matches); assert.equal(firstResult.artifactRef.digest, 'sha256:' + raw.digest);
      assert.equal(events.events[0].payload.projectedBytes, Buffer.byteLength(canonicalStringify(firstResult)));
      assert.ok(events.events[0].payload.projectedBytes < events.events[0].payload.originalBytes);
      t.diagnostic(JSON.stringify({ originalBytes: events.events[0].payload.originalBytes, projectedBytes: events.events[0].payload.projectedBytes, httpRequests: requests.length, toolCalls: executed.length }));
    } else assert.equal(firstResult.artifactRef, undefined);
  } finally { await host.dispose(); await turns.dispose(); await sessions.dispose(); await root.dispose(); await log.close(); await rm(directory, { recursive: true, force: true }); }
});
