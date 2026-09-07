import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableSessionRuntime, TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog, ProjectAgentHistory } from '@haiyue/ai-studio-operation-log';
import { ProjectConversationController } from '@haiyue/ai-studio-agent-orchestration';

const backendId = 'backend:project-history';
const longResult = 'full-result-'.repeat(700);
const longReply = '完整回复'.repeat(5000);

async function fixture(t, slow = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-project-conversation-'));
  const source = await OperationLog.open({ rootDirectory: path.join(root, 'editor-cache'), appVersion: 'test' });
  let project = binding('a'); let counter = 0; let executing = false; let finished = false;
  const gates = new Map(); const traces = [];
  const sessions = new DurableSessionRuntime(source);
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: ['low'], defaultReasoningEffort: 'low', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async submitToolResult(id, result) { traces.push({ id, result }); gates.get(id)?.(); },
  };
  const profile = { id: 'prompt:history', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, modules: [] };
  const runtime = {
    sessions, registry: { descriptors: () => [backend.descriptor], get: () => backend },
    accounting: new TaskAccountingRegistry(new UsageLedgerStore()),
    context: { prompts: { profile }, async prepare({ request }) { return { prompt: request, promptProfile: profile, promptDigest: profile.digest, contextDigest: profile.digest, contextArtifactIds: [], cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; }, async commit() {} },
    turns: {
      async *start(_backendId, input, signal) {
        const owner = project; const sequence = ++counter;
        const sessionId = `session:history:${sequence}`; const turnId = `turn:history:${sequence}`; const callId = `call:history:${sequence}`;
        const event = (kind, payload) => ({ schemaVersion: 1, backendId, sessionId, turnId, kind, payload });
        let release; const done = new Promise(resolve => { release = resolve; }); gates.set(callId, release);
        yield event('status', { status: 'running' });
        yield event('tool-request', { toolCallId: callId, toolId: 'scene.query', arguments: { baseRevision: 1, owner: owner.projectId, name: input.prompt, text: 'parameters-'.repeat(300) } });
        await done;
        yield event('conversation-node', { status: 'streaming', delta: `${owner.projectId}:${longReply}` });
        yield event('completed', { status: signal.aborted ? 'cancelled' : 'completed' });
      },
      async *resume() {}, async cancel() { for (const release of gates.values()) release(); }, async recordToolResult() {},
    },
  };
  const tools = {
    definitions: () => [{ id: 'scene.query', version: '1.0.0', description: 'Read current project', effect: 'observe', risk: 'low', concurrencySafe: true, inputSchema: {} }],
    async prepare(call) { return { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: project.documentId, baseRevision: 1, status: 'ready', argumentsDigest: 'a'.repeat(64), previewDigest: 'b'.repeat(64), preview: { title: 'Read', target: 'Project', summary: 'Read', diff: '' } }; },
    async execute(preparation) { executing = true; const owner = project.projectId; await new Promise(resolve => setTimeout(resolve, slow ? 70 : 5)); finished = true; traces.push({ executedFor: owner, stillCurrent: project.projectId }); return { schemaVersion: 1, callId: preparation.replace('preparation:', ''), toolId: 'scene.query', documentId: project.documentId, status: 'completed', value: { owner, text: longResult }, beforeRevision: 1, afterRevision: 1 }; },
  };
  const directories = new Map();
  const controller = new ProjectConversationController({
    resolveProject: () => project,
    async openHistory(owner) {
      const directory = owner.storageKey ?? path.join(root, owner.projectId.replaceAll(':', '-'), '.aistudio', 'agent'); directories.set(owner.projectId, directory);
      const history = await ProjectAgentHistory.open({ source, projectId: owner.projectId, directory, storage: owner.storageKey ? 'project' : 'unsaved' });
      return { log: history.log, query: query => history.query(query), detail: id => history.detail(id), flush: () => history.flush(), dispose: () => history.dispose(), relocate: next => history.relocate(next.storageKey) };
    },
    hostOptions: (owner, log) => ({ runtime, tools, operationLog: log, isProjectOpen: () => owner.projectId === project.projectId, projectContext: () => ({ projectId: owner.projectId, documentId: owner.documentId, revision: 1, manifest: { name: owner.projectId } }) }),
  });
  t.after(async () => { await controller.dispose(); await sessions.dispose(); await source.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  await controller.initialize();
  return { root, source, sessions, controller, directories, traces, executing: () => executing, finished: () => finished,
    async change(name) { await controller.prepareProjectChange(); project = binding(name); await controller.syncProject(); },
    async run(prompt) { await controller.dispatch({ type: 'conversation/send', backendId, prompt }); await until(() => !controller.replay().busy); },
  };
}

test('project switches replace replay, preserve full structured tool data and restore the matching project after restart', async t => {
  const value = await fixture(t); const { controller } = value;
  await value.run('A-only request');
  const a = await controller.queryHistory('project:a', { limit: 100 });
  const result = a.records.find(record => record.kind === 'tool-result'); assert.ok(result);
  const detail = await controller.readHistory('project:a', result.id);
  assert.equal(detail.data.parameters.owner, 'project:a'); assert.equal(detail.data.parameters.text, 'parameters-'.repeat(300)); assert.equal(detail.data.result.value.text, longResult);
  assert.ok(result.durationMs >= 5); assert.equal(Date.parse(result.finishedAt) - Date.parse(result.startedAt), result.durationMs);
  const reply = a.records.find(record => record.kind === 'text' && record.sessionId.startsWith('session:history'));
  assert.equal((await controller.readHistory('project:a', reply.id)).data.text, `project:a:${longReply}`);
  const revision = controller.replay().revision;
  await controller.dispatch({ type: 'agent/configure', backendId, model: 'fixture-model', reasoningEffort: 'low', outputTokenLimit: 6000, budget: controller.replay().taskAccounting.budget });
  await value.change('b');
  assert.equal(controller.replay().backends[0].outputTokenLimit, 6000);
  assert.equal((await controller.queryHistory('project:b', {})).total, 0); assert.equal(controller.replay().events.length, 0); assert.ok(controller.replay().revision > revision);
  await assert.rejects(controller.readHistory('project:a', result.id), /项目已切换/);
  await value.run('B-only request');
  assert.doesNotMatch(JSON.stringify(controller.replay()), /A-only request/);
  await value.change('a');
  assert.match(JSON.stringify(controller.replay()), /A-only request/); assert.doesNotMatch(JSON.stringify(controller.replay()), /B-only request/);
  assert.equal((await controller.readHistory('project:a', result.id)).data.result.value.text, longResult);
  await controller.dispose();
  const copied = path.join(value.root, 'portable'); await cp(value.directories.get('project:a'), copied, { recursive: true });
  const freshLog = await OperationLog.open({ rootDirectory: path.join(value.root, 'fresh'), appVersion: 'test' });
  const archive = await ProjectAgentHistory.open({ source: freshLog, projectId: 'project:a', directory: copied, storage: 'project' });
  const freshSessions = new DurableSessionRuntime(freshLog);
  try {
    const session = await freshSessions.open(result.sessionId, { repairOpenOperations: false });
    const snapshot = await session.snapshot(); assert.equal(snapshot.session.projectId, 'project:a'); assert.ok(snapshot.ops.some(op => op.kind === 'tool.completed'));
    assert.ok(snapshot.transcript.some(entry => entry.content.includes('A-only request'))); await session.dispose();
  } finally { await freshSessions.dispose(); await archive.dispose(); await freshLog.close(); }
});

test('switching projects drains a late tool result before replacing its project authority', async t => {
  const value = await fixture(t, true);
  await value.controller.dispatch({ type: 'conversation/send', backendId, prompt: 'A delayed read' });
  await until(value.executing);
  await value.change('b');
  assert.equal(value.finished(), true);
  assert.ok(value.traces.some(trace => trace.executedFor === 'project:a' && trace.stillCurrent === 'project:a'));
  assert.equal((await value.controller.queryHistory('project:b', {})).total, 0);
  assert.doesNotMatch(JSON.stringify(value.controller.replay()), /A delayed read|project:a/);
});

test('reopening an interrupted step preserves its original parameters when marking it cancelled', async t => {
  const value = await fixture(t);
  const id = 'node:interrupted';
  const parameters = { revision: 17, text: 'original parameter '.repeat(400) };
  const data = await value.source.putArtifact({ toolId: 'scene.query', parameters });
  const node = { schemaVersion: 1, id, kind: 'tool-call', knownKind: null, status: 'pending', createdAt: '2026-09-06T12:00:00.000Z', provenance: { backendId, sessionId: 'session:interrupted', turnId: 'turn:interrupted' }, content: { toolId: 'scene.query' }, payloadTruncated: false };
  const projection = await value.source.putArtifact(node);
  const record = { schemaVersion: 1, id, projectId: 'project:a', kind: node.kind, status: node.status, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId, toolId: 'scene.query', startedAt: node.createdAt, finishedAt: null, durationMs: null, dataArtifactId: data.id };
  await value.source.append({ kind: 'agent/execution-record', severity: 'info', source: 'studio.fixture', correlation: { projectId: 'project:a' }, payload: { record }, artifactRefs: [data.id] });
  await value.source.append({ kind: 'conversation/node-projected', severity: 'info', source: 'studio.fixture', correlation: { projectId: 'project:a' }, payload: { nodeId: id, executionDataArtifactId: data.id }, artifactRefs: [projection.id] });
  await value.change('b'); await value.change('a');
  const detail = await value.controller.readHistory('project:a', id);
  assert.equal(detail.record.status, 'cancelled'); assert.deepEqual(detail.data.parameters, parameters);
});

function binding(name) { return { projectId: `project:${name}`, documentId: `document:${name}`, storageKey: null }; }
async function until(predicate) { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for project conversation'); }
