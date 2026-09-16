import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';
import { DurableSessionRuntime, TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { GAME_AUTHORING_TOOL_DEFINITIONS } from '@haiyue/ai-studio-game-authoring-tools';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

const backendId = 'backend:lifecycle', sessionId = 'session:lifecycle', turnId = 'turn:lifecycle';
const plan = { title: 'Inspect and validate', summary: 'Collect evidence for the approved task.', items: [{ label: 'Inspect', details: 'Inspect runtime state and validate the preview.' }], acceptance: [{ label: 'Score changes', required: true, category: 'functional', assertion: 'evidence state signal score equals 1' }] };
const event = (kind, payload) => ({ schemaVersion: 1, backendId, sessionId, turnId, kind, payload });
const nodes = host => [...new Map(host.replay().events.map(item => [item.node.id, item.node])).values()];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const transaction of [false, true]) test(`failed Play inspection can revalidate without losing results or allowing edits outside repair (transaction=${transaction})`, { timeout: 15_000 }, async () => {
  await fixture(async f => {
    if (transaction) f.enableTransactions();
    f.program = async function* () {
      for (const [toolId, args] of [['studio.plan.propose', plan], ['play.inspect', {}], ['preview.validate', { baseRevision: 1 }], ['entity.create', { baseRevision: 1, kind: 'cube', name: 'Must not execute' }], ['project.snapshot', {}]]) {
        const result = f.result(toolId);
        yield event('tool-request', { toolCallId: toolId, toolId, arguments: args });
        await result;
        yield event('status', { status: 'running' });
      }
    };
    await f.start();
    await waitFor(() => nodes(f.host).some(node => node.kind === 'plan' && node.status === 'pending'));
    const pending = nodes(f.host).find(node => node.kind === 'plan' && node.status === 'pending');
    await f.host.dispatch({ type: 'conversation/accept-plan', nodeId: pending.id, acceptedItemIds: pending.content.items.map(item => item.id), mode: 'approve' });
    await f.finished();
    assert.equal(f.results.get('play.inspect').status, 'failed');
    assert.equal(f.results.get('preview.validate')?.status, 'completed');
    assert.equal(f.results.get('entity.create')?.error?.code, 'task.preview-stop-required');
    assert.equal(f.results.get('project.snapshot')?.status, 'completed');
    assert.deepEqual(f.executed, ['play.inspect', 'preview.validate', 'project.snapshot']);
    assert.equal(nodes(f.host).some(node => node.kind === 'tool-call' && node.status === 'pending'), false);
    assert.equal(nodes(f.host).some(node => node.kind === 'diagnostic' && node.content.code === 'session.sequence-gap'), false);
    assert.notEqual(f.host.replay().taskRuns.at(-1).status, 'completed', 'a successful validation is not acceptance evidence');
    await f.assertClosed(5, 5);
  });
});

test('a malformed request closes an empty batch after its delayed start and retains the original error', async () => {
  await fixture(async f => {
    f.beforeAppend = async op => { if (op.kind === 'tool-batch.planned' && !op.nodeId) await new Promise(resolve => setTimeout(resolve, 40)); };
    f.program = async function* () { yield event('tool-request', { toolCallId: 'call:malformed', toolId: '', arguments: {} }); };
    await f.start(); await f.finished();
    const diagnostic = nodes(f.host).find(node => node.kind === 'diagnostic' && node.status === 'failed');
    assert.ok(diagnostic);
    assert.notEqual(diagnostic.content.code, 'session.sequence-gap');
    assert.match(diagnostic.content.message, /tool/i);
    await f.assertClosed(1, 0);
  });
});

test('cancellation before a durable tool start waits for it and cannot execute a late tool body', async () => {
  await fixture(async f => {
    const entered = deferred(), release = deferred();
    f.beforeAppend = async op => { if (op.kind === 'tool-batch.planned' && op.nodeId) { entered.resolve(); await release.promise; } };
    f.program = async function* () { const result = f.result('call:cancel'); yield event('tool-request', { toolCallId: 'call:cancel', toolId: 'project.snapshot', arguments: {} }); await result; };
    await f.start(); await entered.promise;
    try { await f.host.dispatch({ type: 'conversation/cancel', backendId, sessionId, turnId }); }
    finally { release.resolve(); }
    await f.finished();
    assert.equal(f.results.get('call:cancel')?.status, 'cancelled');
    assert.deepEqual(f.executed, []); assert.deepEqual(f.prepared, []);
    assert.equal(nodes(f.host).some(node => node.kind === 'tool-call' && node.status === 'pending'), false);
    await f.assertClosed(1, 1);
  });
});

test('cleanup does not complete a batch twice when its completion audit fails', async () => {
  await fixture(async f => {
    f.failAudit = true;
    f.program = async function* () { const result = f.result('call:read'); yield event('tool-request', { toolCallId: 'call:read', toolId: 'project.snapshot', arguments: {} }); await result; };
    await f.start(); await f.finished();
    assert.ok(nodes(f.host).some(node => node.kind === 'diagnostic' && node.content.message === 'Fixture completion audit failed.'));
    assert.deepEqual(f.executed, ['project.snapshot']);
    await f.assertClosed(1, 1);
  });
});

const batchNode = (id, toolId, dependsOn = [], args = {}) => ({ id, toolId, toolVersion: GAME_AUTHORING_TOOL_DEFINITIONS.find(d => d.id === toolId).version, arguments: args, dependsOn, estimatedWorkMs: 100, onFailure: 'cancel-dependents' });
for (const invalid of [false, true]) test(`W6 batch keeps per-member plan authorization and rejects invalid envelopes before execution (${invalid})`, async () => {
  await fixture(async f => {
    f.enableTransactions();
    const members = [batchNode('edit:first', 'entity.create', [], { baseRevision: 1, kind: 'cube', name: 'Denied' }), batchNode('read:after', 'scene.query', ['edit:first'])];
    if (invalid) members[1].toolVersion = 'unknown';
    f.program = async function* () { const result = f.result('call:batch'); yield event('tool-request', { toolCallId: 'call:batch', toolId: 'studio.tool.batch', arguments: { schemaVersion: 1, nodes: members } }); await result; };
    await f.start(); await f.finished();
    const result = f.results.get('call:batch');
    if (invalid) assert.equal(result.error.code, 'tool.version-mismatch');
    else { assert.equal(result.results[0].result.error.code, 'plan.approval-required'); assert.equal(result.results[1].result.status, 'cancelled'); }
    assert.deepEqual(f.prepared, []); assert.deepEqual(f.executed, []);
    await f.assertClosed(invalid ? 0 : 1, invalid ? 0 : 3);
  });
});
test('W6 dependencies observe failed mutation execution, never merely successful preparation', async () => {
  await fixture(async f => {
    f.enableTransactions(); f.executionFailure = 'entity.create';
    f.program = async function* () {
      const reviewed = f.result('call:plan');
      yield event('tool-request', { toolCallId: 'call:plan', toolId: 'studio.plan.propose', arguments: { title: 'Edit', summary: 'Edit then read', items: [{ label: 'Edit', details: 'One edit' }] } });
      await reviewed;
      const result = f.result('call:batch');
      yield event('tool-request', { toolCallId: 'call:batch', toolId: 'studio.tool.batch', arguments: { schemaVersion: 1, nodes: [batchNode('edit:first', 'entity.create', [], { baseRevision: 1, kind: 'cube', name: 'First' }), batchNode('read:dependent', 'scene.query', ['edit:first'])] } });
      await result;
    };
    await f.start(); await waitFor(() => nodes(f.host).some(node => node.kind === 'plan' && node.status === 'pending'));
    const pending = nodes(f.host).find(node => node.kind === 'plan' && node.status === 'pending');
    await f.host.dispatch({ type: 'conversation/accept-plan', nodeId: pending.id, acceptedItemIds: pending.content.items.map(item => item.id), mode: 'approve' });
    await f.finished();
    assert.deepEqual(f.prepared, ['entity.create']); assert.deepEqual(f.executed, ['entity.create']);
    assert.deepEqual(f.results.get('call:batch').results.map(member => member.result.status), ['failed', 'cancelled']);
    await f.assertClosed(2, 4);
  });
});
test('W6 explicit provider step survives interleaved text and closes exactly once', async () => {
  await fixture(async f => {
    f.program = async function* () {
      const first = f.result('call:first'), last = f.result('call:last');
      yield event('tool-request', { toolCallId: 'call:first', toolId: 'project.snapshot', batchId: 'batch:explicit', arguments: {} });
      yield event('conversation-node', { delta: 'Still inspecting', status: 'streaming' });
      yield event('tool-request', { toolCallId: 'call:last', toolId: 'project.snapshot', batchId: 'batch:explicit', arguments: {} });
      await Promise.all([first, last]);
      yield event('status', { batchId: 'batch:explicit', batchClosed: true, status: 'running' });
    };
    await f.start(); await f.finished(); await f.assertClosed(1, 2);
  });
});
test('W6 cancelled closed admission drains all members without preparing or leaving pending UI', async () => {
  await fixture(async f => {
    const entered = deferred(), release = deferred();
    f.beforeAppend = async op => { if (op.kind === 'tool-batch.planned' && op.nodeId) { entered.resolve(); await release.promise; } };
    f.program = async function* () { const result = f.result('call:batch'); yield event('tool-request', { toolCallId: 'call:batch', toolId: 'studio.tool.batch', arguments: { schemaVersion: 1, nodes: [batchNode('read:first', 'project.snapshot'), batchNode('read:second', 'scene.query')] } }); await result; };
    await f.start(); await entered.promise;
    try { await f.host.dispatch({ type: 'conversation/cancel', backendId, sessionId, turnId }); } finally { release.resolve(); }
    await f.finished();
    assert.deepEqual(f.prepared, []); assert.deepEqual(f.executed, []);
    assert.ok(f.results.get('call:batch').results.every(result => result.result.status === 'cancelled'));
    assert.equal(nodes(f.host).some(node => node.kind === 'tool-call' && node.status === 'pending'), false);
    await f.assertClosed(1, 3);
  });
});
test('W6 durable query checkpoint stops pending members and releases provider only after outer result delivery', async () => {
  await fixture(async f => {
    const members = [batchNode('read:quota', 'scene.query', [], { limit: 5000 }), batchNode('read:later', 'project.snapshot')].map(node => ({ ...node, estimatedWorkMs: null }));
    f.program = async function* () { const result = f.result('call:batch'); yield event('tool-request', { toolCallId: 'call:batch', toolId: 'studio.tool.batch', arguments: { schemaVersion: 1, nodes: members } }); await result; };
    await f.start(); await f.finished();
    const result = f.results.get('call:batch');
    assert.equal(result.results[0].result.value.code, 'barrier.waiting-user');
    assert.equal(result.results[1].result.status, 'cancelled');
    assert.deepEqual(f.prepared, []); assert.deepEqual(f.executed, []);
    assert.equal(f.cancelledAfterResult, true);
    const snapshot = await f.snapshot();
    assert.equal(snapshot.recovery.unresolvedBarrierIds.length, 1);
    assert.equal(snapshot.recovery.outcomeUnknownNodeIds.length, 0);
    await f.assertClosed(1, 3);
  }, { sessionRecovery: { async recover() {} } });
});
test('W6 ambiguous outer delivery preserves completed member receipts and blocks automatic replay', async () => {
  await fixture(async f => {
    f.beforeSubmit = async id => { if (id === 'call:batch') throw new Error('Transport disconnected'); };
    f.program = async function* () { yield event('tool-request', { toolCallId: 'call:batch', toolId: 'studio.tool.batch', arguments: { schemaVersion: 1, nodes: [batchNode('read:first', 'project.snapshot')] } }); };
    await f.start(); await f.finished();
    const snapshot = await f.snapshot();
    assert.equal(snapshot.ops.filter(op => op.kind === 'tool.completed' && op.payload.toolId === 'project.snapshot').length, 1);
    assert.equal(snapshot.ops.filter(op => op.kind === 'tool.outcome-unknown' && op.payload.toolId === 'studio.tool.batch').length, 1);
    assert.equal(snapshot.recovery.outcomeUnknownNodeIds.length, 1);
    assert.deepEqual(f.executed, ['project.snapshot']);
  });
});

async function fixture(run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-batch-lifecycle-'));
  const log = await OperationLog.open({ rootDirectory: directory, appVersion: 'batch-lifecycle-test' });
  const sessions = new DurableSessionRuntime(log);
  const durable = await sessions.create({ id: sessionId, projectId: 'project:lifecycle', documentId: 'document:lifecycle', activeGoal: null, taskBudgetId: null });
  const releases = new Map(), preparations = new Map();
  const f = { results: new Map(), prepared: [], executed: [], program: null, beforeAppend: async () => {}, beforeSubmit: async () => {}, snapshot: () => sessions.replay(sessionId), failAudit: false, result(id) { const gate = deferred(); releases.set(id, gate); return gate.promise; } };
  const wrap = (target, overrides) => new Proxy(target, { get(object, key) { const value = overrides[key] ?? object[key]; return typeof value === 'function' ? value.bind(object) : value; } });
  const handle = wrap(durable, { async append(op) { await f.beforeAppend(op); return durable.append(op); } });
  const usage = new UsageLedgerStore();
  const profile = { id: 'prompt:lifecycle', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, modules: [] };
  const backend = {
    descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; },
    async submitToolResult(id, result) { await f.beforeSubmit(id, result); f.results.set(id, result); releases.get(id)?.resolve(result); },
    async cancelTurn() {}, async dispose() {},
  };
  const runtime = {
    registry: { descriptors: () => [backend.descriptor], get: () => backend }, sessions: { async open() { return handle; } }, usage, accounting: new TaskAccountingRegistry(usage),
    context: { prompts: { profile }, async prepare({ request }) { return { prompt: request, promptDigest: profile.digest, promptProfile: profile, contextArtifactIds: [], contextDigest: profile.digest, cache: {} }; }, async commit() {} },
    turns: { async *start(_id, input) { usage.open({ taskId: input.taskId, sessionId, turnId, providerRequestDigest: null, startedAtMs: Date.now() }); yield event('status', { status: 'running' }); yield* f.program(); yield event('completed', { status: 'completed' }); }, async cancel() { f.cancelledAfterResult = f.results.has('call:batch'); }, async recordToolResult() {} },
  };
  const tools = {
    definitions: () => GAME_AUTHORING_TOOL_DEFINITIONS,
    async prepare(call) { f.prepared.push(call.toolId); assert.equal(call.arguments.baseRevision ?? 1, 1); const preparation = { id: `preparation:${call.id}`, callId: call.id, sessionId, turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: 'document:lifecycle', baseRevision: 1, argumentsDigest: profile.digest, previewDigest: profile.digest, preview: { title: call.toolId, target: 'Project', summary: call.toolId, diff: '' }, status: 'ready' }; preparations.set(preparation.id, preparation); return preparation; },
    async execute(id) { const p = preparations.get(id); f.executed.push(p.toolId); return { schemaVersion: 1, callId: p.callId, toolId: p.toolId, status: p.toolId === 'play.inspect' || p.toolId === f.executionFailure ? 'failed' : 'completed', value: p.toolId === 'play.inspect' ? { message: 'Play is not active.' } : {}, documentId: p.documentId, beforeRevision: 1, afterRevision: 1 }; },
  };
  f.enableTransactions = () => { tools.executeTransaction = async () => assert.fail('A rejected workflow must not commit a transaction.'); };
  f.host = new StudioConversationHost({ ...options, runtime, tools, operationLog: wrap(log, { async append(op, options) { if (op.kind === 'agent/tool-batch-completed' && f.failAudit) { f.failAudit = false; throw new Error('Fixture completion audit failed.'); } return log.append(op, options); } }), isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:lifecycle', documentId: 'document:lifecycle', revision: 1, manifest: {} }) });
  f.start = async () => { await f.host.initialize(); await f.host.dispatch({ type: 'conversation/send', backendId, prompt: 'Inspect the current project.' }); };
  f.finished = () => waitFor(() => !f.host.replay().busy);
  f.assertClosed = async (batches, tools) => {
    const snapshot = await sessions.replay(sessionId);
    const ops = snapshot.ops;
    assert.equal(ops.filter(op => op.kind === 'tool-batch.started').length, batches);
    assert.equal(ops.filter(op => op.kind === 'tool-batch.completed').length, batches);
    assert.equal(ops.filter(op => op.kind === 'tool.started').length, tools);
    assert.equal(ops.filter(op => op.kind === 'tool.completed').length, tools);
    assert.equal(ops.filter(op => op.kind === 'turn.completed').length, 1);
    assert.ok(ops.every((op, index) => op.sequence === index));
  };
  try { await run(f); }
  finally { for (const gate of releases.values()) gate.resolve(); await f.host.dispose(); await sessions.dispose(); await log.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}
async function waitFor(predicate) { for (let count = 0; count < 1000; count++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for lifecycle fixture.'); }

test('W7 Host only delegates approved plan items, caches candidate receipts and never calls editor tools', async () => {
  let childCalls = 0;
  const ids = ['first', 'second'];
  const proposal = { title: 'Design isolated candidates', summary: 'Large independent proposals', items: ids.map(id => ({ label: `Design ${id}`, details: 'Produce a candidate only', execution: { schemaVersion: 1, id: `task:${id}`, dependsOn: [], inputs: [`fact:${id}`], artifacts: [`result:${id}`], readScopes: ['document:lifecycle'], writeScopes: [], verification: ['parent:review'], budget: { toolCalls: 1, wallTimeMs: 1000 }, estimatedWorkMs: 20000 } })) };
  const { sha256 } = await import('@haiyue/ai-studio-operation-log');
  const subtasks = { enabled: true, caps: { inputTokens: 1000, outputTokens: 1000, estimatedCostMicros: 1000, wallTimeMs: 1000 }, qualify: async () => 'evidence:fixture-only', facts: async (refs, revision) => refs.map(ref => ({ ref, content: ref, digest: sha256(ref), revision })), port: { backendId, model: 'fixture-model', async run(input) { childCalls++; return { turnId: `turn:child:${childCalls}`, candidate: { schemaVersion: 1, taskId: input.planTaskId, baseRevision: 1, artifacts: input.artifactKeys.map(key => ({ key, kind: 'proposal', content: 'Candidate', sources: input.facts.map(f => f.ref) })) } }; } } };
  await fixture(async f => {
    f.program = async function* () {
      for (const [id, toolId, arguments_] of [['call:unapproved', 'studio.task.delegate', { schemaVersion: 1, taskIds: ids.map(id => `task:${id}`) }], ['call:plan', 'studio.plan.propose', proposal], ['call:delegate', 'studio.task.delegate', { schemaVersion: 1, taskIds: ids.map(id => `task:${id}`) }], ['call:repeat', 'studio.task.delegate', { schemaVersion: 1, taskIds: [...ids].reverse().map(id => `task:${id}`) }]]) {
        const result = f.result(id); yield event('tool-request', { toolCallId: id, toolId, arguments: arguments_ }); await result;
      }
    };
    await f.start(); await waitFor(() => nodes(f.host).some(n => n.kind === 'plan' && n.status === 'pending'));
    const plan = nodes(f.host).find(n => n.kind === 'plan' && n.status === 'pending');
    await f.host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(i => i.id), mode: 'approve' });
    await f.finished();
    assert.equal(f.results.get('call:unapproved').reason, 'unapproved-task');
    assert.equal(f.results.get('call:delegate').status, 'completed');
    assert.deepEqual(f.results.get('call:repeat'), f.results.get('call:delegate'));
    assert.equal(childCalls, 2); assert.deepEqual(f.executed, []); assert.deepEqual(f.prepared, []);
    const replay = await f.snapshot(); assert.equal(replay.ops.filter(op => op.kind === 'tool.completed' && op.payload.toolId === 'studio.task.delegate').length, 3);
    assert.equal(replay.ops.some(op => op.kind === 'document.committed'), false);
  }, { subtasks });
});
