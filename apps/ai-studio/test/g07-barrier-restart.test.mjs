import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { DurableSessionRuntime, TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioConversationHost } from '../dist/conversation-host.js';

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
    await host.dispatch({ type: 'conversation/resolve-approval', approvalId, decision: 'allow-once' });
    await waitFor(() => host.replay().busy === false && host.replay().events.some((event) => event.node.id === nodeId && event.node.status === 'completed'));
    const replay = await reopenedSessions.replay(sessionId);
    assert.deepEqual(replay.recovery.unresolvedBarrierIds, []);
    assert.equal(replay.ops.some((op) => op.kind === 'approval.resolved' && op.payload.resolvedBy === 'user-after-restart'), true);
    assert.equal(runtime.resumeCalls, 1);
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

test('durable plan barrier releases the provider call and continues in a fresh turn after approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-provider-release-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g07-test', flushPolicy: 'always' });
  const sessions = new DurableSessionRuntime(log);
  let host;
  try {
    const runtime = providerReleaseRuntime(sessions);
    host = new StudioConversationHost({ runtime, tools: { definitions: () => [] }, operationLog: log, sessionRecovery: { async recover() {} }, projectContext: () => ({ projectId: 'project:g07-release', documentId: 'document:g07-release', revision: 1, name: 'Release fixture', dirty: false, selectedEntityId: null, sceneDigest: `sha256:${'2'.repeat(64)}`, scriptDigest: `sha256:${'3'.repeat(64)}`, capabilityDigest: `sha256:${'4'.repeat(64)}`, capabilityManifest: {}, projectSummary: {} }) });
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create a durable plan and wait for approval.' });
    await waitFor(() => host.replay().busy === false && runtime.activeCalls === 0 && host.replay().events.some((event) => event.node.kind === 'plan' && event.node.status === 'pending'));
    const pending = host.replay().events.map((event) => event.node).filter((node) => node.kind === 'plan' && node.status === 'pending').at(-1);
    assert.equal(runtime.startCalls, 1); assert.equal(runtime.cancelCalls, 1); assert.equal(runtime.submitted.length, 1);
    assert.equal(runtime.submitted[0].result.value.code, 'barrier.waiting-user');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: pending.id, acceptedItemIds: pending.content.items.map((item) => item.id), mode: 'approve' });
    await waitFor(() => runtime.startCalls === 2);
    await waitFor(() => host.replay().busy === false);
    assert.equal(runtime.maxActiveCalls, 1);
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

function runtimeFixture(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const profile = { id: 'prompt:g07-barrier', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, modules: [] };
  const backend = { descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async submitToolResult() {} };
  const runtime = { resumeCalls: 0, sessions, usage, accounting, registry: { descriptors: () => [backend.descriptor], get: () => backend }, context: { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'d'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'e'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; } }, turns: { async *start() {}, async *resume() { runtime.resumeCalls += 1; yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'completed', payload: { status: 'completed' } }; }, async cancel() {}, async recordToolResult() {} } };
  return runtime;
}

function providerReleaseRuntime(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const profile = { id: 'prompt:g07-release', version: '1.0.0', digest: `sha256:${'5'.repeat(64)}`, modules: [] };
  const runtime = { activeCalls: 0, maxActiveCalls: 0, startCalls: 0, cancelCalls: 0, submitted: [], sessions, usage, accounting };
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const backend = { descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async submitToolResult(toolCallId, result) { runtime.submitted.push({ toolCallId, result }); releaseFirst(); } };
  Object.assign(runtime, {
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    context: { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'6'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'7'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; } },
    turns: {
      async *start() {
        runtime.startCalls += 1; runtime.activeCalls += 1; runtime.maxActiveCalls = Math.max(runtime.maxActiveCalls, runtime.activeCalls);
        try {
          if (runtime.startCalls === 1) {
            yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'tool-request', payload: { toolCallId: 'call:g07-release-plan', toolId: 'studio.plan.propose', arguments: { title: 'Durable release plan', summary: 'Create a plan that releases the provider while the user is away.', items: [{ label: 'Continue safely', details: 'Resume in a fresh bounded turn after approval.' }] } } };
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

async function waitFor(predicate) { for (let index = 0; index < 300; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for recovered barrier.'); }
function runElectron(fixture, root, phase) { return new Promise((resolve, reject) => { const child = spawn(electronPath, [fixture], { env: { ...process.env, HAIYUE_G07_BARRIER_ROOT: root, HAIYUE_G07_BARRIER_PHASE: phase, HAIYUE_G07_USER_DATA: path.join(root, `user-data-${phase}`) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; }); child.once('error', reject); child.once('exit', (code) => resolve({ code, output })); }); }
