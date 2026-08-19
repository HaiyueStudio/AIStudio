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

function event(kind, payload) { return Object.freeze({ schemaVersion: 1, backendId, sessionId, turnId, kind, payload: Object.freeze(payload) }); }
function fakeBackend(events) {
  let disposed = 0;
  return {
    upstream: { fixture: '1' }, descriptor: { schemaVersion: 1, id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: { resume: true, questions: true, structuredTools: true, backendApprovals: true, usage: true, rateLimits: true } },
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
  for await (const value of runtime.start(backendId, { prompt: canary, contextArtifactIds: [asStableId('artifact:1')], tools: [{ id: asStableId('studio.entity.create'), description: 'Create', inputSchema: { type: 'object' } }] })) values.push(value);
  assert.deepEqual(values.map((item) => item.kind), ['status', 'conversation-node', 'tool-request', 'question', 'approval', 'usage', 'completed']);
  const query = await log.query({ limit: 50, traverseCorrelation: false });
  assert.equal(query.events[0].kind, 'agent/context-prepared');
  assert.equal(query.events[0].payload.promptBytes, Buffer.byteLength(canary));
  const toolLog = query.events.find((item) => item.kind === 'agent/tool-request');
  assert.equal(toolLog.payload.toolId, 'studio.entity.create'); assert.equal(toolLog.correlation.toolCallId, 'tool-call:1'); assert.ok(toolLog.payload.argumentsDigest); assert.deepEqual(toolLog.payload.argumentKeys, ['secret']);
  const usageLog = query.events.find((item) => item.kind === 'agent/usage');
  assert.deepEqual(usageLog.payload.usage, { inputTokens: 3, outputTokens: 2 });
  assert.ok(query.events.every((item) => !JSON.stringify(item.payload).includes(canary)));
  await runtime.dispose(); await runtime.dispose(); assert.equal(backend.disposed, 1); await log.close();
  assert.doesNotMatch(await readTree(root), new RegExp(canary));
});

test('invalid schemas, coordinate drift, missing terminal and events after terminal fail closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-agent-invalid-')); const log = await OperationLog.open({ rootDirectory: root, appVersion: 'test' });
  for (const [name, events, code] of [
    ['coordinate', [event('status', { status: 'running' }), { ...event('completed', { status: 'completed' }), turnId: asStableId('turn:other') }], 'agent.coordinate-drift'],
    ['terminal', [event('status', { status: 'running' })], 'agent.stream-without-terminal'],
    ['after', [event('completed', { status: 'completed' }), event('usage', {})], 'agent.event-after-terminal'],
    ['schema', [{ ...event('completed', { status: 'unknown' }) }], 'agent.terminal-invalid'],
  ]) {
    const registry = new AgentBackendRegistry(); registry.register(fakeBackend(events)); const runtime = new AgentTurnRuntime(registry, log);
    await assert.rejects(async () => { for await (const _ of runtime.start(backendId, { prompt: name, contextArtifactIds: [], tools: [] })) {} }, (error) => error instanceof AgentBackendProtocolError && error.code === code);
    await runtime.dispose();
  }
  await log.close();
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
