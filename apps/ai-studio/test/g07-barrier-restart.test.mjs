import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { DurableSessionRuntime, TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';
import { GAME_AUTHORING_TOOL_DEFINITIONS, ToolCatalogRuntime } from '@haiyue/ai-studio-game-authoring-tools';

const backendId = 'backend:g07-barrier';
const sessionId = 'session:g07-barrier';
const turnId = 'turn:g07-barrier';
const nodeId = 'node:g07-barrier-approval';
const approvalId = 'approval:g07-barrier';

test('an approval barrier remains actionable after process restart and resumes from its durable checkpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-barrier-'));
  let firstLog; let firstSessions; let reopenedLog; let reopenedSessions; let host;
  try {
    firstLog = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
    firstSessions = new DurableSessionRuntime(firstLog);
    const session = await firstSessions.create({ id: sessionId, projectId: 'project:g07', documentId: 'document:g07', activeGoal: 'resume approval', taskBudgetId: 'budget:g07' });
    await session.append({ kind: 'turn.started', turnId, payload: {} });
    await session.append({ kind: 'approval.requested', turnId, nodeId, projectRevision: 4, payload: { approvalId, barrierKind: 'tool-approval', expiresAt: null } });
    await session.checkpoint();
    const node = { schemaVersion: 1, id: nodeId, kind: 'approval', status: 'pending', createdAt: '2026-09-01T00:00:00.000Z', provenance: { backendId, sessionId, turnId }, content: { approvalId, toolCallId: 'call:g07-barrier', toolId: 'entity.rename', toolVersion: '1.0.0', target: 'entity:g07', effect: 'reversible-edit', risk: 'medium', argumentsSummary: 'Rename entity', previewDiff: '~ name', baseRevision: 4, argsDigest: `sha256:${'a'.repeat(64)}`, previewDigest: `sha256:${'b'.repeat(64)}`, scope: 'operation', decision: 'pending' } };
    const artifact = await firstLog.putArtifact(node, { schemaVersion: 'conversation-node/1', backendId });
    await firstLog.append({ kind: 'conversation/node-projected', severity: 'warning', source: 'studio.conversation-host', correlation: { sessionId, turnId, approvalId }, payload: { nodeId, nodeKind: 'approval', nodeStatus: 'pending', artifactId: artifact.id, artifactDigest: artifact.digest }, artifactRefs: [artifact.id] });
    await session.dispose(); await firstSessions.dispose(); await firstLog.close(); firstSessions = null; firstLog = null;

    reopenedLog = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
    reopenedSessions = new DurableSessionRuntime(reopenedLog);
    const runtime = runtimeFixture(reopenedSessions);
    host = new StudioConversationHost({ runtime, tools: { definitions: () => [] }, operationLog: reopenedLog });
    await host.initialize();
    const recovered = host.replay().events.map((event) => event.node).find((candidate) => candidate.id === nodeId);
    assert.equal(recovered.status, 'pending'); assert.equal(recovered.content.decision, 'pending');
    assert.ok(host.replay().executionGraphs.find(graph => graph.sessionId === sessionId)?.nodes.some(node => node.kind === 'approval' && node.status === 'waiting'), 'a session opened during barrier recovery must also restore its topology');
    await host.dispatch({ type: 'conversation/resolve-approval', approvalId, decision: 'allow-once' });
    await waitFor(() => host.replay().busy === false && host.replay().events.some((event) => event.node.id === nodeId && event.node.status === 'completed'));
    const replay = await reopenedSessions.replay(sessionId);
    assert.deepEqual(replay.recovery.unresolvedBarrierIds, []);
    assert.equal(replay.ops.some((op) => op.kind === 'approval.resolved' && op.payload.resolvedBy === 'user-after-restart'), true);
    assert.equal(runtime.resumeCalls, 1);
    await waitFor(() => host.replay().executionGraphs.find(graph => graph.sessionId === sessionId)?.nodes.some(node => node.kind === 'approval' && node.status === 'completed'));
  } finally {
    await host?.dispose().catch(() => undefined); await reopenedSessions?.dispose().catch(() => undefined); await reopenedLog?.close().catch(() => undefined);
    await firstSessions?.dispose().catch(() => undefined); await firstLog?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('trusted script and runtime start barriers survive a real Electron process restart', { timeout: 100_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-electron-barriers-'));
  const fixture = new URL('./fixtures/g07-barrier-electron-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1');
  try {
    const seed = await runElectron(fixture, root, 'seed');
    assert.equal(seed.code, 0, seed.output);
    assert.match(seed.output, /\[g07-barrier-electron\].*"seeded":2/u);
    const recovered = await runElectron(fixture, root, 'recover');
    assert.equal(recovered.code, 0, recovered.output);
    assert.match(recovered.output, /\[g07-barrier-electron\].*"pending":2.*"resolved":2.*"resumeCalls":2.*"unresolved":0/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('a long durable plan releases the provider call and selects real catalog tools for its approved continuation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-provider-release-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
  const sessions = new DurableSessionRuntime(log);
  let host;
  try {
    const runtime = providerReleaseRuntime(sessions);
    const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => []);
    const selectedRequests = [];
    const tools = { definitions: () => GAME_AUTHORING_TOOL_DEFINITIONS, selectDefinitions(request) { selectedRequests.push(request); return catalog.selectDefinitions(request); } };
    host = new StudioConversationHost({ runtime, tools, operationLog: log, sessionRecovery: { async recover() {} }, projectContext: () => ({ projectId: 'project:g07-release', documentId: 'document:g07-release', revision: 1, name: 'Release fixture', dirty: false, selectedEntityId: null, sceneDigest: `sha256:${'2'.repeat(64)}`, scriptDigest: `sha256:${'3'.repeat(64)}`, capabilityDigest: `sha256:${'4'.repeat(64)}`, capabilityManifest: {}, projectSummary: {} }) });
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create a durable plan and wait for approval.' });
    await waitFor(() => host.replay().busy === false && runtime.activeCalls === 0 && host.replay().events.some((event) => event.node.kind === 'plan' && event.node.status === 'pending'));
    const pending = host.replay().events.map((event) => event.node).filter((node) => node.kind === 'plan' && node.status === 'pending').at(-1);
    const suspended = (await sessions.replay(sessionId)).ops.find(op => op.kind === 'tool.completed' && op.payload.status === 'cancelled');
    assert.equal(suspended.payload.diagnostic, 'barrier.waiting-user');
    const pausedTurn = (await sessions.replay(sessionId)).ops.find(op => op.kind === 'turn.completed');
    assert.equal(pausedTurn.payload.suspendedBarrierId, pending.id);
    assert.equal(host.replay().executionGraphs.flatMap(graph => graph.nodes).find(node => node.kind === 'turn').status, 'waiting');
    assert.match(suspended.payload.reason, /等待用户确认/);
    assert.match(host.replay().executionGraphs.flatMap(graph => graph.nodes).find(node => node.detail.toolId === 'studio.plan.propose').detail.reason, /等待用户确认/);

    assert.equal(runtime.startCalls, 1); assert.equal(runtime.cancelCalls, 1); assert.equal(runtime.submitted.length, 1);
    assert.equal(runtime.submitted[0].result.value.code, 'barrier.waiting-user');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: pending.id, acceptedItemIds: pending.content.items.map((item) => item.id), mode: 'approve' });
    await waitFor(() => runtime.startCalls === 2);
    await waitFor(() => host.replay().busy === false);
    assert.equal(runtime.maxActiveCalls, 1);
    assert.ok(selectedRequests.at(-1).length > 512);
    assert.match(selectedRequests.at(-1), /already approved plan/);
    assert.match(selectedRequests.at(-1), /pointer input and screenshot evidence/);
    for (const id of ['project.snapshot', 'tool.search', 'play.input', 'play.capture']) assert.ok(runtime.inputs[1].tools.some(tool => tool.id === id));
    assert.equal(host.replay().events.some(event => event.node.kind === 'diagnostic' && event.node.content.code === 'conversation.operation-failed'), false);
    assert.equal(host.replay().events.some((event) => event.node.id === pending.id && event.node.status === 'completed'), true);
    const replay = await sessions.replay(sessionId);
    assert.deepEqual(replay.recovery.unresolvedBarrierIds, []);
  } finally {
    await host?.dispose().catch(() => undefined); await sessions.dispose().catch(() => undefined); await log.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('durable mutation approval releases its turn, reuses the scoped grant, and executes once in a continuation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-approval-release-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
  const sessions = new DurableSessionRuntime(log);
  let host;
  try {
    const runtime = approvalReleaseRuntime(sessions);
    const tools = approvalTools();
    host = new StudioConversationHost({ runtime, tools, operationLog: log, sessionRecovery: { async recover() {} }, projectContext: () => ({ projectId: 'project:g07-release', documentId: 'document:g07-release', revision: 1, name: 'Release fixture', dirty: false, selectedEntityId: null, sceneDigest: `sha256:${'2'.repeat(64)}`, scriptDigest: `sha256:${'3'.repeat(64)}`, capabilityDigest: `sha256:${'4'.repeat(64)}`, capabilityManifest: {}, projectSummary: {} }) });
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Approve a plan, then create one cube.' });
    await waitFor(() => host.replay().busy === false && runtime.activeCalls === 0 && latestNode(host, 'plan', 'pending'));
    const plan = latestNode(host, 'plan', 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map((item) => item.id), mode: 'approve' });
    await waitFor(() => host.replay().busy === false && runtime.startCalls === 2 && latestNode(host, 'approval', 'pending'));
    const approval = latestNode(host, 'approval', 'pending');
    assert.equal(runtime.activeCalls, 0); assert.equal(tools.executeCalls, 0);
    await host.dispatch({ type: 'conversation/resolve-approval', approvalId: approval.content.approvalId, decision: 'allow-once' });
    await waitFor(() => host.replay().busy === false && runtime.startCalls === 3 && tools.executeCalls === 1);
    assert.equal(runtime.activeCalls, 0); assert.equal(runtime.maxActiveCalls, 1); assert.equal(runtime.cancelCalls, 2);
    assert.equal(latestNode(host, 'approval', 'completed').content.decision, 'allow-once');
    const grantFacts = await log.query({ kinds: ['conversation/approval-grant-reused'], limit: 10, traverseCorrelation: false });
    assert.equal(grantFacts.events.length, 1);
    const replay = await sessions.replay(sessionId); assert.deepEqual(replay.recovery.unresolvedBarrierIds, []);
  } finally {
    await host?.dispose().catch(() => undefined); await sessions.dispose().catch(() => undefined); await log.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('durable backend question cancels the old provider turn and continues from the persisted answer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-question-release-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' }); const sessions = new DurableSessionRuntime(log); let host;
  try {
    const runtime = questionReleaseRuntime(sessions);
    host = new StudioConversationHost({ runtime, tools: { definitions: () => [] }, operationLog: log, sessionRecovery: { async recover() {} } });
    await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Ask one durable question.' });
    await waitFor(() => host.replay().busy === false && runtime.activeCalls === 0 && latestNode(host, 'question', 'pending'));
    const question = latestNode(host, 'question', 'pending'); assert.equal(runtime.cancelCalls, 1); assert.equal(runtime.answerCalls, 0);
    await host.dispatch({ type: 'conversation/answer-question', nodeId: question.id, answer: { text: 'Use the compact layout.' } });
    await waitFor(() => runtime.startCalls === 2); await waitFor(() => host.replay().busy === false);
    assert.equal(runtime.activeCalls, 0); assert.equal(runtime.answerCalls, 0); assert.equal(latestNode(host, 'question', 'completed').id, question.id);
  } finally { await host?.dispose().catch(() => undefined); await sessions.dispose().catch(() => undefined); await log.close().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('durable budget continuation releases the completed provider tranche and preserves prior output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-budget-release-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' }); const sessions = new DurableSessionRuntime(log); let host;
  try {
    const runtime = budgetReleaseRuntime(sessions); const tools = observeTools();
    host = new StudioConversationHost({ runtime, tools, operationLog: log, sessionRecovery: { async recover() {} } });
    await host.initialize();
    await host.dispatch({ type: 'agent/configure', backendId, model: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4096, budget: { schemaVersion: 2, id: 'budget:g07-durable', enforcement: 'hard', limits: { inputTokens: 100_000, outputTokens: 10_000, estimatedCostMicros: 1_000_000, wallTimeMs: 60_000, turns: 2, toolCalls: 1, repairIterations: 1, observationBytes: 100_000 } } });
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Inspect twice with a durable budget boundary.' });
    await waitFor(() => host.replay().busy === false && runtime.activeCalls === 0 && latestNode(host, 'question', 'pending')?.content.options?.some((option) => String(option.id).includes('budget-continue')));
    const question = latestNode(host, 'question', 'pending'); const continueOption = question.content.options.find((option) => String(option.id).includes('budget-continue'));
    assert.equal(runtime.startCalls, 1); assert.equal(tools.executeCalls, 1); assert.equal(runtime.submitted.length, 2);
    assert.equal(runtime.submitted[1].result.value.code, 'budget.continuation-required');
    await host.dispatch({ type: 'conversation/answer-question', nodeId: question.id, answer: { optionIds: [continueOption.id] } });
    await waitFor(() => runtime.startCalls === 2 && tools.executeCalls === 2); await waitFor(() => host.replay().busy === false);
    assert.equal(runtime.activeCalls, 0); assert.equal(runtime.submitted.length, 3); assert.equal(runtime.submitted[2].result.status, 'completed');
  } finally { await host?.dispose().catch(() => undefined); await sessions.dispose().catch(() => undefined); await log.close().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

for (const mode of ['live', 'input-tokens', 'restart', 'legacy-restart', 'stop']) test(`between-turn budget checkpoint keeps its task owner (${mode})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-between-turns-'));
  let log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
  let sessions = new DurableSessionRuntime(log); let host;
  try {
    let runtime = providerReleaseRuntime(sessions);
    host = new StudioConversationHost({ idPrefix: mode === 'input-tokens' ? 'scope:g07-input' : undefined, runtime, tools: observeTools(), operationLog: log, sessionRecovery: { async recover() {} } });
    await host.initialize();
    await host.dispatch({ type: 'agent/configure', backendId, model: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4096, budget: { schemaVersion: 2, id: 'budget:g07-between-turns', enforcement: 'hard', limits: { inputTokens: 200_000, outputTokens: 10_000, estimatedCostMicros: 1_000_000, wallTimeMs: 60_000, turns: mode === 'input-tokens' ? 100 : 1, toolCalls: 100, repairIterations: 1, observationBytes: 100_000 } } });
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Build and verify the approved interactive object.' });
    await waitFor(() => !host.replay().busy && latestNode(host, 'plan', 'pending'));
    const plan = latestNode(host, 'plan', 'pending'); const original = host.replay().taskRuns.at(-1);
    if (mode === 'input-tokens') {
      const now = Date.now();
      const ledger = runtime.usage.open({ taskId: original.taskId, sessionId, turnId, providerRequestDigest: null, startedAtMs: now });
      ledger.reconcile({ eventId: 'usage:g07-input', sequence: 1, mode: 'cumulative', inputTokens: 201_498, outputTokens: 100, observedAtMs: now, final: true });
      runtime.accounting.get(original.taskId).reconcile();
    }
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => !host.replay().busy && latestNode(host, 'question', 'pending'));
    const question = latestNode(host, 'question', 'pending');
    assert.match(question.provenance.turnId, /(?:^|:)turn:approved-plan:/);
    assert.equal(runtime.startCalls, 1, 'no provider turn exists for the budget checkpoint');
    assert.equal(question.content.taskId, original.taskId);
    assert.equal(host.replay().taskRuns.at(-1).turnId, question.provenance.turnId);
    assert.equal(host.replay().taskRuns.at(-1).status, 'waiting-user');
    await host.flushRecords();
    if (mode.endsWith('restart')) {
      if (mode === 'legacy-restart') {
        // Reproduce the old persisted shape: no task id on the barrier, task still
        // points at the prior provider turn; its budget timeline owns the local turn.
        const { taskId: _taskId, ...content } = question.content;
        const node = { ...question, content };
        const artifact = await log.putArtifact(node, { schemaVersion: 'conversation-node/1' });
        await log.append({ kind: 'conversation/node-projected', severity: 'info', source: 'studio.conversation-host', correlation: { sessionId: question.provenance.sessionId, turnId: question.provenance.turnId }, payload: {}, artifactRefs: [artifact.id] });
        const run = { ...host.replay().taskRuns.at(-1), revision: host.replay().taskRuns.at(-1).revision + 1, sessionId: original.sessionId, turnId: original.turnId };
        const taskArtifact = await log.putArtifact(run, { schemaVersion: 'conversation-task/1' });
        await log.append({ kind: 'conversation/task-projected', severity: 'info', source: 'studio.conversation-host', correlation: {}, payload: {}, artifactRefs: [taskArtifact.id] });
      }
      await host.dispose(); await sessions.dispose(); await log.close();
      log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
      sessions = new DurableSessionRuntime(log); runtime = runtimeFixture(sessions);
      host = new StudioConversationHost({ idPrefix: mode === 'input-tokens' ? 'scope:g07-input' : undefined, runtime, tools: observeTools(), operationLog: log, sessionRecovery: { async recover() {} } });
      await host.initialize();
    }
    const inputs = []; let resumes = 0;
    runtime.turns.start = async function* (_backend, input) {
      inputs.push(input);
      yield { schemaVersion: 1, backendId, sessionId, turnId: 'turn:g07-fresh-budget', kind: 'question', payload: { nodeId: 'question:g07-next-step', questions: [] } };
      yield { schemaVersion: 1, backendId, sessionId, turnId: 'turn:g07-fresh-budget', kind: 'completed', payload: { status: 'cancelled' } };
    };
    runtime.turns.resume = async function* () { resumes++; throw new Error('Local checkpoint must never reach provider resume'); };
    const option = question.content.options.find(option => option.id.includes(mode === 'stop' ? 'budget-stop' : 'budget-continue'));
    await host.dispatch({ type: 'conversation/answer-question', nodeId: question.id, answer: { optionIds: [option.id] } });
    await waitFor(() => !host.replay().busy);
    assert.equal(resumes, 0); assert.equal(inputs.length, mode === 'stop' ? 0 : 1);
    assert.equal(host.replay().taskRuns.length, 1);
    assert.equal(host.replay().taskRuns[0].taskId, original.taskId);
    assert.deepEqual(host.replay().taskRuns[0].acceptance.map(item => item.assertion), original.acceptance.map(item => item.assertion));
    if (mode !== 'stop') { assert.equal(inputs[0].taskId, original.taskId); assert.match(inputs[0].prompt, /evidence runtime-errors signal count equals 0/); }
    if (mode === 'live') assert.equal(runtime.accounting.get(original.taskId).snapshot().budget.limits.turns, 2, 'one answer grants exactly one tranche');
    if (mode === 'input-tokens') assert.equal(runtime.accounting.get(original.taskId).snapshot().budget.limits.inputTokens, 401_498, 'one tranche adds bounded headroom to reported usage');
    if (mode === 'stop') assert.equal(host.replay().taskRuns[0].status, 'cancelled');
    const checkpoint = await sessions.replay(question.provenance.sessionId);
    assert.deepEqual(checkpoint.recovery.openTurnIds, []); assert.deepEqual(checkpoint.recovery.unresolvedBarrierIds, []);
    await waitFor(() => host.replay().executionGraphs.find(graph => graph.sessionId === question.provenance.sessionId)?.currentNodeIds.length === 0);
  } finally { await host?.dispose().catch(() => undefined); await sessions.dispose().catch(() => undefined); await log.close().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

for (const phase of ['start', 'resume', 'stream']) test(`host failure closes the durable topology (${phase})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-host-failure-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
  let sessions = new DurableSessionRuntime(log); let host;
  try {
    const runtime = runtimeFixture(sessions);
    const fail = async function* () {
      if (phase === 'stream') yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'conversation-node', payload: { delta: 'Working…' } };
      throw Object.assign(new Error('Codex turn fixture is unavailable.'), { code: 'agent.resume-missing' });
    };
    runtime.turns.start = fail; runtime.turns.resume = fail;
    host = new StudioConversationHost({ runtime, tools: observeTools(), operationLog: log });
    await host.initialize();
    await host.dispatch(phase === 'resume' ? { type: 'conversation/retry', backendId, sessionId, turnId } : { type: 'conversation/send', backendId, prompt: 'Inspect the current project.' });
    await waitFor(() => !host.replay().busy && latestNode(host, 'diagnostic', 'failed'));
    const failure = latestNode(host, 'diagnostic', 'failed');
    const snapshot = await sessions.replay(failure.provenance.sessionId);
    const terminal = snapshot.ops.filter(op => op.kind === 'turn.completed');
    assert.equal(terminal.length, 1); assert.equal(terminal[0].payload.status, 'failed');
    assert.match(terminal[0].payload.reason, /unavailable/); assert.equal(terminal[0].payload.diagnostic, 'agent.resume-missing');
    assert.deepEqual(snapshot.recovery.openTurnIds, []);
    await waitFor(() => host.replay().executionGraphs.find(graph => graph.sessionId === failure.provenance.sessionId)?.nodes.some(node => node.kind === 'result' && node.status === 'failed'));
    const graph = host.replay().executionGraphs.find(graph => graph.sessionId === failure.provenance.sessionId);
    assert.deepEqual(graph.currentNodeIds, []); assert.ok(graph.nodes.every(node => node.status !== 'running'));
    const latest = new Map(host.replay().events.map(event => [event.node.id, event.node]));
    assert.ok([...latest.values()].filter(node => node.kind === 'progress').every(node => node.status === (phase === 'stream' ? 'completed' : 'failed')));
    if (phase === 'stream') assert.ok([...latest.values()].some(node => node.kind === 'text' && node.status === 'failed' && node.content.text === 'Working…'));
    if (phase !== 'resume') assert.equal(host.replay().taskRuns.at(-1).status, 'failed');
    await host.flushRecords(); await host.dispose(); await sessions.dispose();
    sessions = new DurableSessionRuntime(log);
    host = new StudioConversationHost({ runtime: runtimeFixture(sessions), tools: observeTools(), operationLog: log }); await host.initialize();
    assert.deepEqual(host.replay().executionGraphs.find(graph => graph.sessionId === failure.provenance.sessionId).currentNodeIds, []);
    assert.equal((await sessions.replay(failure.provenance.sessionId)).ops.filter(op => op.kind === 'turn.completed').length, 1, 'reload does not duplicate terminal facts');
  } finally { await host?.dispose().catch(() => undefined); await sessions.dispose().catch(() => undefined); await log.close().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

for (const newerAttempt of [false, true]) test(`legacy host failure repairs missing terminal topology without overriding a newer attempt (${newerAttempt})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-legacy-failure-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
  const sessions = new DurableSessionRuntime(log); let host;
  try {
    const session = await sessions.create({ id: sessionId, projectId: 'project:g07', documentId: null, taskBudgetId: null, activeGoal: 'Recover budget checkpoint' });
    await session.appendMessage({ role: 'user', content: 'Continue after budget approval', turnId });
    const node = { schemaVersion: 1, id: 'node:g07-host-failure', kind: 'diagnostic', status: 'failed', createdAt: new Date().toISOString(), provenance: { backendId, sessionId, turnId }, content: { code: 'agent.resume-missing', message: 'Codex turn fixture is unavailable.', severity: 'error' } };
    const artifact = await log.putArtifact(node, { schemaVersion: 'conversation-node/1' });
    await log.append({ kind: 'conversation/node-projected', severity: 'error', source: 'studio.conversation-host', correlation: { sessionId, turnId }, payload: {}, artifactRefs: [artifact.id] });
    await log.append({ kind: 'conversation/host-failed', severity: 'error', source: 'studio.conversation-host', correlation: { sessionId, turnId }, payload: node.content });
    if (newerAttempt) {
      await new Promise(resolve => setTimeout(resolve, 5));
      await session.append({ kind: 'turn.started', turnId, payload: { status: 'running' } });
    }
    host = new StudioConversationHost({ runtime: runtimeFixture(sessions), tools: observeTools(), operationLog: log }); await host.initialize();
    const graph = host.replay().executionGraphs.find(graph => graph.sessionId === sessionId);
    const terminal = (await sessions.replay(sessionId)).ops.filter(op => op.kind === 'turn.completed');
    assert.equal(terminal.length, newerAttempt ? 0 : 1);
    if (newerAttempt) assert.ok(graph.currentNodeIds.length > 0);
    else { assert.deepEqual(graph.currentNodeIds, []); assert.equal(terminal[0].payload.status, 'failed'); assert.match(graph.nodes.find(node => node.kind === 'result').detail.reason, /unavailable/); }
  } finally { await host?.dispose().catch(() => undefined); await sessions.dispose().catch(() => undefined); await log.close().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('between-turn inline budget approval excludes user wait and rearms the renewed wall-time budget', async () => {
  const runtime = providerReleaseRuntime(undefined); const originalStart = runtime.turns.start;
  let turnInputs = []; let beforeWork; let afterWork;
  runtime.turns.start = async function* (backend, input) {
    turnInputs.push(input);
    if (turnInputs.length === 1) {
      for await (const event of originalStart(backend, input)) yield event.kind === 'completed' ? { ...event, payload: { status: 'completed' } } : event;
    } else {
      beforeWork = runtime.accounting.get(input.taskId).snapshot().budgetDecision.status;
      yield { schemaVersion: 1, backendId, sessionId, turnId: 'turn:g07-inline-budget', kind: 'status', payload: { status: 'running' } };
      await new Promise(resolve => setTimeout(resolve, 300));
      afterWork = runtime.accounting.get(input.taskId).snapshot().budgetDecision.status;
      yield { schemaVersion: 1, backendId, sessionId, turnId: 'turn:g07-inline-budget', kind: 'completed', payload: { status: 'failed' } };
    }
  };
  const host = new StudioConversationHost({ runtime, tools: observeTools(), operationLog: { async append() {} } });
  try {
    await host.initialize();
    await host.dispatch({ type: 'agent/configure', backendId, model: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4096, budget: { schemaVersion: 2, id: 'budget:g07-inline', enforcement: 'hard', limits: { inputTokens: 200_000, outputTokens: 10_000, estimatedCostMicros: 1_000_000, wallTimeMs: 100, turns: 1, toolCalls: 100, repairIterations: 1, observationBytes: 100_000 } } });
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Build the approved object.' });
    await waitFor(() => latestNode(host, 'plan', 'pending'));
    const plan = latestNode(host, 'plan', 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => latestNode(host, 'question', 'pending'));
    const question = latestNode(host, 'question', 'pending');
    assert.match(question.provenance.turnId, /(?:^|:)turn:approved-plan:/);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(turnInputs.length, 1, 'human wait cannot start provider work');
    await host.dispatch({ type: 'conversation/answer-question', nodeId: question.id, answer: { optionIds: [question.content.options.find(option => option.id.includes('budget-continue')).id] } });
    await waitFor(() => !host.replay().busy);
    assert.equal(turnInputs.length, 2); assert.equal(turnInputs[0].taskId, turnInputs[1].taskId);
    assert.equal(beforeWork, 'within'); assert.equal(afterWork, 'hard-exceeded', 'the renewed execution deadline must still be enforced');
  } finally { await host.dispose(); }
});

function runtimeFixture(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const profile = { id: 'prompt:g07-barrier', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, modules: [] };
  const backend = { descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async submitToolResult() {} };
  const runtime = { resumeCalls: 0, sessions, usage, accounting, registry: { descriptors: () => [backend.descriptor], get: () => backend }, context: { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'d'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'e'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; } }, turns: { async *start() {}, async *resume() { runtime.resumeCalls += 1; yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'completed', payload: { status: 'completed' } }; }, async cancel() {}, async recordToolResult() {} } };
  return runtime;
}

function providerReleaseRuntime(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const profile = { id: 'prompt:g07-release', version: '1.0.0', digest: `sha256:${'5'.repeat(64)}`, modules: [] };
  const runtime = { activeCalls: 0, maxActiveCalls: 0, startCalls: 0, cancelCalls: 0, submitted: [], inputs: [], sessions, usage, accounting };
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const backend = { descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async submitToolResult(toolCallId, result) { runtime.submitted.push({ toolCallId, result }); releaseFirst(); } };
  Object.assign(runtime, {
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    context: { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'6'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'7'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; } },
    turns: {
      async *start(_backendId, input) {
        runtime.inputs.push(input);
        runtime.startCalls += 1; runtime.activeCalls += 1; runtime.maxActiveCalls = Math.max(runtime.maxActiveCalls, runtime.activeCalls);
        try {
          if (runtime.startCalls === 1) {
            yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'tool-request', payload: { toolCallId: 'call:g07-release-plan', toolId: 'studio.plan.propose', arguments: { title: 'Durable release plan', summary: 'Create a plan that releases the provider while the user is away.', items: [{ label: 'Continue safely', details: 'Resume in a fresh bounded turn after approval. '.repeat(16) + 'Use pointer input and screenshot evidence.' }], acceptance: [{ label: 'No runtime errors', required: true, category: 'functional', assertion: 'evidence runtime-errors signal count equals 0' }] } } };
            await firstReleased;
            yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'completed', payload: { status: 'cancelled' } };
          } else yield { schemaVersion: 1, backendId, sessionId, turnId: 'turn:g07-release-continuation', kind: 'completed', payload: { status: 'completed' } };
        } finally { runtime.activeCalls -= 1; }
      },
      async *resume() {}, async cancel() { runtime.cancelCalls += 1; releaseFirst(); }, async recordToolResult() {},
    },
  });
  return runtime;
}

function approvalReleaseRuntime(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const profile = { id: 'prompt:g07-approval-release', version: '1.0.0', digest: `sha256:${'8'.repeat(64)}`, modules: [] };
  const runtime = { activeCalls: 0, maxActiveCalls: 0, startCalls: 0, cancelCalls: 0, sessions, usage, accounting };
  const releases = new Map();
  const backend = { descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async submitToolResult(toolCallId) { releases.get(toolCallId)?.(); } };
  Object.assign(runtime, {
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    context: { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'9'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'a'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; } },
    turns: {
      async *start() {
        runtime.startCalls += 1; const stage = runtime.startCalls; runtime.activeCalls += 1; runtime.maxActiveCalls = Math.max(runtime.maxActiveCalls, runtime.activeCalls);
        const callId = stage === 1 ? 'call:g07-approval-plan' : `call:g07-approval-edit:${stage}`;
        const released = new Promise((resolve) => releases.set(callId, resolve));
        try {
          if (stage === 1) yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'tool-request', payload: { toolCallId: callId, toolId: 'studio.plan.propose', arguments: { title: 'Approval release plan', summary: 'Create exactly one cube after a separately persisted authorization.', items: [{ label: 'Create cube', details: 'Use the registered entity tool once.' }] } } };
          else yield { schemaVersion: 1, backendId, sessionId, turnId: `turn:g07-approval:${stage}`, kind: 'tool-request', payload: { toolCallId: callId, toolId: 'entity.create', arguments: { kind: 'cube', name: 'Approved Cube' } } };
          await released;
          yield { schemaVersion: 1, backendId, sessionId, turnId: stage === 1 ? turnId : `turn:g07-approval:${stage}`, kind: 'completed', payload: { status: stage < 3 ? 'cancelled' : 'completed' } };
        } finally { releases.delete(callId); runtime.activeCalls -= 1; }
      },
      async *resume() {}, async cancel() { runtime.cancelCalls += 1; for (const release of releases.values()) release(); }, async recordToolResult() {},
    },
  });
  return runtime;
}

function questionReleaseRuntime(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const profile = { id: 'prompt:g07-question-release', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}`, modules: [] };
  const runtime = { activeCalls: 0, startCalls: 0, cancelCalls: 0, answerCalls: 0, sessions, usage, accounting }; let release;
  const released = new Promise((resolve) => { release = resolve; });
  const backend = { descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async submitToolResult() {}, async answerQuestion() { runtime.answerCalls += 1; }, async resolveBackendApproval() {} };
  Object.assign(runtime, { registry: { descriptors: () => [backend.descriptor], get: () => backend }, context: { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'e'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'f'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; } }, turns: {
    async *start() { runtime.startCalls += 1; runtime.activeCalls += 1; try { if (runtime.startCalls === 1) { yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'question', payload: { nodeId: 'backend-question:g07', questions: [{ id: 'layout', header: 'Layout', question: 'Which layout?', options: [{ label: 'Compact', description: 'Use compact layout.' }] }], isBlocking: true } }; await released; yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'completed', payload: { status: 'cancelled' } }; } else yield { schemaVersion: 1, backendId, sessionId, turnId: 'turn:g07-question-continuation', kind: 'completed', payload: { status: 'completed' } }; } finally { runtime.activeCalls -= 1; } },
    async *resume() {}, async cancel() { runtime.cancelCalls += 1; release(); }, async recordToolResult() {},
  } }); return runtime;
}

function budgetReleaseRuntime(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const profile = { id: 'prompt:g07-budget-release', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}`, modules: [] };
  const runtime = { activeCalls: 0, startCalls: 0, cancelCalls: 0, submitted: [], sessions, usage, accounting }; const releases = [];
  const backend = { descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async submitToolResult(toolCallId, result) { runtime.submitted.push({ toolCallId, result }); releases.shift()?.(); } };
  Object.assign(runtime, { registry: { descriptors: () => [backend.descriptor], get: () => backend }, context: { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'2'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'3'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; } }, turns: {
    async *start() { runtime.startCalls += 1; runtime.activeCalls += 1; const stage = runtime.startCalls; try { if (stage === 1) { const first = new Promise((resolve) => releases.push(resolve)); yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'tool-request', payload: { toolCallId: 'call:g07-budget:first', toolId: 'project.snapshot', arguments: {} } }; await first; const second = new Promise((resolve) => releases.push(resolve)); yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'tool-request', payload: { toolCallId: 'call:g07-budget:second', toolId: 'diagnostics.query', arguments: {} } }; await second; yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'completed', payload: { status: 'cancelled' } }; } else { const retry = new Promise((resolve) => releases.push(resolve)); yield { schemaVersion: 1, backendId, sessionId, turnId: 'turn:g07-budget-continuation', kind: 'tool-request', payload: { toolCallId: 'call:g07-budget:retry', toolId: 'diagnostics.query', arguments: {} } }; await retry; yield { schemaVersion: 1, backendId, sessionId, turnId: 'turn:g07-budget-continuation', kind: 'completed', payload: { status: 'completed' } }; } } finally { runtime.activeCalls -= 1; } },
    async *resume() {}, async cancel() { runtime.cancelCalls += 1; releases.shift()?.(); }, async recordToolResult() {},
  } }); return runtime;
}

function observeTools() {
  const tools = { executeCalls: 0, definitions: () => ['project.snapshot', 'diagnostics.query'].map((id) => ({ id, description: id, effect: 'observe', risk: 'low', inputSchema: {} })), async prepare(call) { return { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: 'document:g07-release', baseRevision: 1, argumentsDigest: `sha256:${'4'.repeat(64)}`, previewDigest: `sha256:${'5'.repeat(64)}`, preview: { title: 'Read', target: 'Project', summary: 'Read only', diff: '' }, status: 'ready' }; }, async execute(preparationId) { tools.executeCalls += 1; return { schemaVersion: 1, callId: preparationId.replace('preparation:', ''), toolId: 'diagnostics.query', status: 'completed', value: { retained: true }, documentId: 'document:g07-release', beforeRevision: 1, afterRevision: 1 }; } }; return tools;
}

function approvalTools() {
  const approvals = new Map(); const preparations = new Map();
  const tools = {
    executeCalls: 0,
    definitions: () => [{ id: 'entity.create', description: 'Create entity', effect: 'reversible-edit', risk: 'medium', inputSchema: {} }],
    async prepare(call) {
      const preparation = { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, taskId: call.taskId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'medium', documentId: 'document:g07-release', baseRevision: 1, argumentsDigest: `sha256:${'b'.repeat(64)}`, previewDigest: `sha256:${'c'.repeat(64)}`, preview: { title: 'Create cube', target: 'Scene/Approved Cube', summary: 'Create one approved cube', diff: '+ Approved Cube' }, approvalId: `approval:${call.id}`, status: 'awaiting-approval' };
      preparations.set(call.id, preparation); approvals.set(preparation.approvalId, { schemaVersion: 1, approvalId: preparation.approvalId, preparationId: preparation.id, sessionId: call.sessionId, turnId: call.turnId, toolCallId: call.id, toolId: call.toolId, toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'medium', argumentsDigest: preparation.argumentsDigest, previewDigest: preparation.previewDigest, documentId: preparation.documentId, baseRevision: 1, target: preparation.preview.target, decision: 'pending' }); return preparation;
    },
    approval(id) { return approvals.get(id) ?? null; },
    async decide(id, decision) { const current = approvals.get(id); if (!current) throw new Error('approval missing'); const resolved = { ...current, decision }; approvals.set(id, resolved); return resolved; },
    async cancel(callId) { preparations.delete(callId); for (const [id, approval] of approvals) if (approval.toolCallId === callId) approvals.delete(id); },
    async execute(preparationId) { tools.executeCalls += 1; return { schemaVersion: 1, callId: preparationId.replace('preparation:', ''), toolId: 'entity.create', status: 'completed', value: { entity: { id: 'entity:approved-cube', name: 'Approved Cube' } }, documentId: 'document:g07-release', beforeRevision: 1, afterRevision: 2, historyLabel: 'Create Approved Cube' }; },
  };
  return tools;
}

function latestNode(host, kind, status) { return host.replay().events.map((event) => event.node).filter((node) => node.kind === kind && node.status === status).at(-1); }

// Durable checkpoints flush files; use an elapsed-time bound that tolerates a busy test host.
async function waitFor(predicate) { const deadline = performance.now() + 10_000; do { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } while (performance.now() < deadline); throw new Error('Timed out waiting for recovered barrier.'); }
function runElectron(fixture, root, phase) { return new Promise((resolve, reject) => { const child = spawn(electronPath, ['--in-process-gpu', '--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer', fixture], { env: { ...process.env, HAIYUE_G07_BARRIER_ROOT: root, HAIYUE_G07_BARRIER_PHASE: phase, HAIYUE_G07_USER_DATA: path.join(root, `user-data-${phase}`) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; }); child.once('error', reject); child.once('exit', (code) => resolve({ code, output })); }); }
