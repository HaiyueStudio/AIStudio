import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { AgentBackendProtocolError, AgentBackendRegistry, AgentTurnRuntime, createAgentRuntimePlugin } from '../dist/index.js';

const backendId = asStableId('backend:fake');
const sessionId = asStableId('session:fake');
const turnId = asStableId('turn:fake');
const turnConfig = Object.freeze({ schemaVersion: 2, backendId, model: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4_096, taskBudgetId: asStableId('budget:fixture'), promptProfile: Object.freeze({ id: asStableId('prompt:fixture'), version: '2.0.0', digest: `sha256:${'a'.repeat(64)}` }), requestedCapabilities: Object.freeze(['agent.model-config', 'agent.usage']) });
const turnInput = (prompt, tools = []) => ({ taskId: asStableId('task:fixture'), config: turnConfig, prompt, contextArtifactIds: [], tools });

function event(kind, payload) { return Object.freeze({ schemaVersion: 1, backendId, sessionId, turnId, kind, payload: Object.freeze(payload) }); }
function fakeBackend(events) {
  let disposed = 0;
  return {
    upstream: { fixture: '1' }, descriptor: { schemaVersion: 1, id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: { resume: true, questions: true, structuredTools: true, backendApprovals: true, usage: true, rateLimits: true } },
    modelCatalog: async () => ({ schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'pinned-adapter', models: [{ id: 'fixture-model', label: 'Fixture', description: 'fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4_096, isDefault: true }] }),
    negotiate: async (config) => ({ schemaVersion: 2, backendId, protocolVersion: 'fixture', requested: config, status: 'accepted', effective: { model: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4_096, capabilities: ['agent.model-config', 'agent.usage'] }, diagnostics: [] }),
    authenticate: async () => null, status: async () => ({ state: 'ready', authMode: 'none', rateLimits: [] }), logout: async () => {},
    async *startTurn() { yield* events; }, async *resumeTurn() { yield* events; }, submitToolResult: async () => {}, answerQuestion: async () => {}, resolveBackendApproval: async () => {}, cancelTurn: async () => {},
    async dispose() { disposed += 1; }, get disposed() { return disposed; },
  };
}

test('registry, normalized event stream and operation log preserve only digests and provenance', async () => {
  const canary = 'SECRET_CANARY_AGENT_RUNTIME_12345678';
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-agent-runtime-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'test' });
  const registry = new AgentBackendRegistry();
  const backend = fakeBackend([
    event('status', { status: 'running' }),
    event('conversation-node', { delta: canary, status: 'streaming' }),
    event('tool-request', { toolCallId: 'tool-call:1', toolId: 'studio.entity.create', arguments: { secret: canary } }),
    event('question', { nodeId: 'question:1', prompt: canary }),
    event('approval', { id: 'approval:1', summary: canary }),
    event('usage', { inputTokens: 3, outputTokens: 2 }),
    event('completed', { status: 'completed' }),
  ]);
  registry.register(backend);
  assert.equal(registry.descriptors()[0].capabilities.structuredTools, true);
  const runtime = new AgentTurnRuntime(registry, log);
  const values = [];
  for await (const value of runtime.start(backendId, turnInput(canary, [{ id: asStableId('studio.entity.create'), description: 'Create', inputSchema: { type: 'object' } }]))) values.push(value);
  assert.deepEqual(values.map((item) => item.kind), ['status', 'conversation-node', 'tool-request', 'question', 'approval', 'usage', 'completed']);
  const query = await log.query({ limit: 50, traverseCorrelation: false });
  const negotiationLog = query.events.find((item) => item.kind === 'agent/config-negotiated');
  assert.equal(negotiationLog.payload.status, 'accepted');
  assert.equal(negotiationLog.payload.effective.model, 'fixture-model');
  const contextLog = query.events.find((item) => item.kind === 'agent/context-prepared');
  assert.ok(contextLog.payload.promptBytes > Buffer.byteLength(canary));
  assert.ok(contextLog.payload.contextArtifactIds.length > 0);
  const toolLog = query.events.find((item) => item.kind === 'agent/tool-request');
  assert.equal(toolLog.payload.toolId, 'studio.entity.create'); assert.equal(toolLog.correlation.toolCallId, 'tool-call:1'); assert.ok(toolLog.payload.argumentsDigest); assert.deepEqual(toolLog.payload.argumentKeys, ['secret']);
  const usageLog = query.events.find((item) => item.kind === 'agent/usage');
  assert.deepEqual(usageLog.payload.usage, { inputTokens: 3, outputTokens: 2 });
  assert.ok(query.events.every((item) => !JSON.stringify(item.payload).includes(canary)));
  await runtime.dispose(); await runtime.dispose(); assert.equal(backend.disposed, 1); await log.close();
  assert.doesNotMatch(await readTree(root), new RegExp(canary));
});

test('invalid schemas, coordinate drift, missing terminal and non-usage events after terminal fail closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-agent-invalid-')); const log = await OperationLog.open({ rootDirectory: root, appVersion: 'test' });
  for (const [name, events, code] of [
    ['coordinate', [event('status', { status: 'running' }), { ...event('completed', { status: 'completed' }), turnId: asStableId('turn:other') }], 'agent.coordinate-drift'],
    ['terminal', [event('status', { status: 'running' })], 'agent.stream-without-terminal'],
    ['after', [event('completed', { status: 'completed' }), event('conversation-node', { delta: 'late', status: 'streaming' })], 'agent.event-after-terminal'],
    ['schema', [{ ...event('completed', { status: 'unknown' }) }], 'agent.terminal-invalid'],
  ]) {
    const registry = new AgentBackendRegistry(); registry.register(fakeBackend(events)); const runtime = new AgentTurnRuntime(registry, log);
    await assert.rejects(async () => { for await (const _ of runtime.start(backendId, { ...turnInput(name), contextArtifactIds: [] })) {} }, (error) => error instanceof AgentBackendProtocolError && error.code === code);
    await runtime.dispose();
  }
  await log.close();
});

test('late usage reconciles accounting without resuming terminal execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-agent-late-')); const log = await OperationLog.open({ rootDirectory: root, appVersion: 'test' });
  const registry = new AgentBackendRegistry(); registry.register(fakeBackend([
    event('completed', { status: 'completed', finishReason: 'stop' }),
    event('usage', { eventId: 'late:1', sequence: 1, mode: 'cumulative', inputTokens: 9, cachedInputTokens: 4, outputTokens: 2, final: true }),
  ]));
  const runtime = new AgentTurnRuntime(registry, log);
  const values = [];
  for await (const value of runtime.start(backendId, { ...turnInput('late'), contextArtifactIds: [] })) values.push(value);
  assert.deepEqual(values.map((item) => item.kind), ['completed', 'usage']);
  const snapshot = runtime.usage.get(turnId).snapshot();
  assert.equal(snapshot.executionState, 'terminal');
  assert.equal(snapshot.finishReason, 'stop');
  assert.equal(snapshot.lateReconciliations, 1);
  assert.equal(snapshot.record.inputTokens, 9);
  await runtime.dispose(); await log.close();
});

test('cancellation suppresses later effects but still drains terminal and late usage for reconciliation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-agent-cancel-accounting-')); const log = await OperationLog.open({ rootDirectory: root, appVersion: 'test' });
  const registry = new AgentBackendRegistry(); registry.register(fakeBackend([
    event('status', { status: 'running' }), event('tool-request', { toolCallId: 'tool-call:cancelled', toolId: 'studio.entity.create', arguments: {} }),
    event('completed', { status: 'cancelled', finishReason: 'cancelled' }), event('usage', { eventId: 'cancel:late', sequence: 1, mode: 'cumulative', inputTokens: 7, cachedInputTokens: 2, outputTokens: 1, reasoningTokens: 0, final: true }),
  ]));
  const runtime = new AgentTurnRuntime(registry, log); const controller = new AbortController(); const values = [];
  for await (const value of runtime.start(backendId, { ...turnInput('cancel-accounting'), contextArtifactIds: [] }, controller.signal)) { values.push(value.kind); if (value.kind === 'status') controller.abort(new Error('cancel fixture')); }
  assert.deepEqual(values, ['status', 'completed', 'usage']);
  const snapshot = runtime.usage.get(turnId).snapshot(); assert.equal(snapshot.finishReason, 'cancelled'); assert.equal(snapshot.lateReconciliations, 1); assert.equal(snapshot.record.inputTokens, 7);
  await runtime.dispose(); await log.close();
});

test('registry rejects duplicate ids and missing providers deterministically', async () => {
  const registry = new AgentBackendRegistry(); const first = fakeBackend([event('completed', { status: 'completed' })]); registry.register(first);
  assert.throws(() => registry.register(fakeBackend([])), (error) => error.code === 'agent.backend-duplicate');
  assert.throws(() => registry.get(asStableId('backend:missing')), (error) => error.code === 'agent.backend-missing');
  await registry.dispose();
});

test('registry disposes backends serially in reverse registration order and still visits all failures', async () => {
  const registry = new AgentBackendRegistry(); const order = [];
  for (const [id, fails] of [['backend:one', false], ['backend:two', true], ['backend:three', false]]) {
    const backend = fakeBackend([]); backend.descriptor = { ...backend.descriptor, id: asStableId(id) }; backend.dispose = async () => { order.push(id); if (fails) throw new Error(id); };
    registry.register(backend);
  }
  await assert.rejects(registry.dispose(), /backend:two/);
  assert.deepEqual(order, ['backend:three', 'backend:two', 'backend:one']);
  await registry.dispose();
});

test('agent runtime plugin declares the single-root operation-log dependency', () => {
  const plugin = createAgentRuntimePlugin({ createBackends: () => [] });
  assert.deepEqual(plugin.manifest.required, [{ id: asStableId('studio.operation-log'), version: '^1.0.0' }]);
  assert.deepEqual(plugin.manifest.provides, [{ id: asStableId('studio.agent-runtime'), version: '1.0.0' }]);
  assert.equal(plugin.manifest.contributions.length, 0);
});

async function readTree(root) { const { readdir } = await import('node:fs/promises'); const values = []; async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const target = path.join(dir, entry.name); if (entry.isDirectory()) await walk(target); else values.push(await readFile(target, 'utf8')); } } await walk(root); return values.join('\n'); }
