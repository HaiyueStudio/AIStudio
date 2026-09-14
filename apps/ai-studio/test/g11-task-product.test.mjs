import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { TaskAccountingRegistry, UsageLedgerStore, DurableSessionRuntime } from '@haiyue/ai-studio-agent-runtime';
import { StudioConversationHost, queryRetainedOperationEvents } from '@haiyue/ai-studio-agent-orchestration';

const backendId = 'backend:g11-product';
const sessionId = 'session:g11-product';
const turnId = 'turn:g11-product';
const evidenceId = `artifact:sha256:${'e'.repeat(64)}`;

test('G11 projects an approved evidence-backed task and replays the same terminal summary after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-product-'));
  try {
    const firstLog = await openLog(root);
    const tools = toolsFixture();
    const first = new StudioConversationHost({ runtime: runtimeFixture(), tools, operationLog: firstLog, projectContext: projectContext });
    await first.initialize();
    await first.dispatch({ type: 'conversation/send', backendId, prompt: 'Build a genre-neutral score interaction and prove it works.' });
    await waitFor(() => nodes(first).some((node) => node.kind === 'plan' && node.status === 'pending'));
    const pendingRun = first.replay().taskRuns.at(-1);
    assert.equal(pendingRun.status, 'waiting-user');
    assert.equal(pendingRun.acceptance.length, 1);
    assert.equal(pendingRun.acceptance[0].assertion, 'evidence state signal score equals 1');
    const plan = nodes(first).find((node) => node.kind === 'plan' && node.status === 'pending');
    await first.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map((item) => item.id), mode: 'approve' });
    await waitFor(() => first.replay().busy === false);
    const terminal = first.replay().taskRuns.at(-1);
    assert.equal(terminal.status, 'completed'); assert.equal(terminal.phase, 'complete');
    assert.equal(terminal.acceptance[0].status, 'pass'); assert.deepEqual(terminal.acceptance[0].evidenceIds, [evidenceId]);
    assert.equal(terminal.evidence[0].id, evidenceId); assert.equal(terminal.evidence[0].provenanceStatus, 'current');
    assert.ok(terminal.timeline.some((item) => item.phase === 'playing'));
    assert.ok(terminal.timeline.some((item) => item.title === '逐项验收通过'));
    assert.equal(tools.evaluationTaskSpec.id, terminal.taskId);
    assert.equal(tools.evaluationTaskSpec.request, 'Build a genre-neutral score interaction and prove it works.');
    const beforeRestart = JSON.parse(JSON.stringify(terminal));
    await first.dispose(); await firstLog.close();

    const reopenedLog = await openLog(root);
    const restarted = new StudioConversationHost({ runtime: runtimeFixture({ empty: true }), tools: toolsFixture(), operationLog: reopenedLog, projectContext });
    await restarted.initialize();
    assert.deepEqual(JSON.parse(JSON.stringify(restarted.replay().taskRuns.at(-1))), beforeRestart);
    assert.equal(restarted.replay().busy, false);
    await restarted.dispose(); await reopenedLog.close();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('G11 converts a crash-interrupted task into an explicit resumable checkpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-resume-'));
  try {
    const seed = await openLog(root); const run = interruptedTaskRun();
    const artifact = await seed.putArtifact(run, { schemaVersion: 'conversation-task/1' });
    await seed.append({ kind: 'conversation/task-projected', severity: 'info', source: 'studio.conversation-host', correlation: { sessionId, turnId }, payload: { taskId: run.taskId, revision: run.revision, status: run.status, phase: run.phase, artifactId: artifact.id }, artifactRefs: [artifact.id] });
    await seed.close();
    const log = await openLog(root); const host = new StudioConversationHost({ runtime: runtimeFixture({ empty: true }), tools: toolsFixture(), operationLog: log, projectContext });
    await host.initialize();
    const restored = host.replay().taskRuns.at(-1);
    assert.equal(restored.status, 'blocked'); assert.equal(restored.phase, 'blocked'); assert.equal(restored.resumable, true); assert.equal(restored.terminalDiagnostic, 'task.interrupted-by-restart');
    await host.dispatch({ type: 'conversation/retry', backendId, sessionId, turnId });
    await waitFor(() => nodes(host).some((node) => node.kind === 'completion'));
    assert.ok(nodes(host).some((node) => node.kind === 'completion'));
    assert.equal(host.replay().taskRuns.at(-1).status, 'blocked');
    await host.dispose(); await log.close();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('G11 restores retained projections through bounded sequence windows when the journal exceeds the scan budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-windowed-restore-'));
  try {
    const log = await openLog(root, { maxQueryScan: 3 });
    for (let index = 0; index < 13; index += 1) {
      await log.append({
        kind: index === 0 || index === 5 || index === 12 ? 'conversation/task-projected' : 'test/filler',
        severity: 'info',
        source: 'studio.g11-windowed-test',
        correlation: {},
        payload: { index },
      });
    }
    const restored = await queryRetainedOperationEvents(log, ['conversation/task-projected'], 2);
    assert.deepEqual(restored.map((item) => item.sequence), [5, 12]);
    await log.close();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

function runtimeFixture(options = {}) {
  const releases = new Map();
  let starts = 0;
  const emit = (kind, payload) => ({ ...event(kind, payload), turnId: options.turnId ?? turnId });
  const usage = new UsageLedgerStore();
  const backend = {
    descriptor: { schemaVersion: 1, id: backendId, kind: 'harness-api-key', protocolVersion: 'g11-fixture', capabilities: { resume: true, questions: true, structuredTools: true, backendApprovals: false, usage: true, rateLimits: true } },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'g11-fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture model', description: 'fixture', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [{ name: 'fixture', usedPercent: 12 }] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async dispose() {},
    async submitToolResult(id) { releases.get(id)?.(); releases.delete(id); },
  };
  const waitForResult = (id) => new Promise((resolve) => releases.set(id, resolve));
  const profile = { id: 'prompt:g11-general', version: '2.0.0', digest: `sha256:${'a'.repeat(64)}`, modules: [] };
  return {
    ...(options.sessions ? { sessions: options.sessions } : {}),
    context: { prompts: { profile }, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'b'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'c'.repeat(64)}`, cache: { localArtifactHits: 1, localArtifactMisses: 0, deltaReuseBytes: 64, providerCacheEligibleBytes: 128, providerReportedHitTokens: null } }; }, async commit() {} },
    registry: { descriptors: () => [backend.descriptor], get: () => backend }, usage, accounting: new TaskAccountingRegistry(usage),
    turns: {
      async *start(_backendId, input) {
        options.onStart?.(input);
        if (options.empty) { yield emit('completed', { status: 'completed' }); return; }
        starts += 1;
        if (options.parallelRequests) {
          const waits = [];
          for (const request of options.parallelRequests) {
            waits.push(waitForResult(request.id));
            yield emit('tool-request', { toolCallId: request.id, toolId: request.toolId, arguments: request.arguments });
          }
          await Promise.all(waits); yield emit('completed', { status: 'completed' }); return;
        }
        for (const request of options.requests ?? [
          { id: 'tool:g11-plan', toolId: 'studio.plan.propose', arguments: { title: 'Score interaction', summary: 'Create, run and verify one score interaction.', items: [{ label: 'Author score controller', details: 'Create the controller and observable score state.' }], acceptance: [{ label: 'Score becomes one', required: true, category: 'functional', assertion: 'evidence state signal score equals 1' }] } },
          { id: 'tool:g11-edit', toolId: 'entity.create', arguments: { baseRevision: 7, kind: 'cube', name: 'ScoreTarget' } },
          { id: 'tool:g11-inspect', toolId: 'play.inspect', arguments: {} },
          { id: 'tool:g11-evaluate', toolId: 'task.evaluate', arguments: { taskSpec: { schemaVersion: 2, id: 'task:spoofed', request: 'spoofed', visibleConstraints: [], budgetId: 'budget:spoofed', requiredCapabilities: [], acceptance: [{ id: 'acceptance:spoofed', required: true, visibility: 'agent', category: 'functional', assertion: 'evidence state' }] }, observationIds: [evidenceId] } },
        ]) {
          if (options.resumeCheckpoint && ['studio.plan.propose', 'entity.create'].includes(request.toolId)) continue;
          if (starts > 1 && request.toolId === 'studio.plan.propose') continue;
          if (options.completeOnContinuation && starts > 1 && request.toolId === 'entity.create') continue;
          if (options.completeOnContinuation && starts === 1 && ['play.inspect', 'task.evaluate'].includes(request.toolId)) continue;
          if (options.stopAfterEdit && ['play.inspect', 'task.evaluate'].includes(request.toolId)) continue;
          if (options.repair && starts > 1 && ['studio.plan.propose', 'entity.create'].includes(request.toolId)) continue;
          const released = waitForResult(request.id); yield emit('tool-request', { toolCallId: request.id, toolId: request.toolId, arguments: request.arguments }); await released;
          if (options.terminalAfterRepair && request.toolId === 'task.evaluate') {
            for (const [id, toolId, args] of [['tool:g11-evaluate-terminal', 'task.evaluate', request.arguments], ['tool:g11-inspect-terminal', 'play.inspect', {}]]) {
              const released = waitForResult(id); yield emit('tool-request', { toolCallId: id, toolId, arguments: args }); await released;
            }
          }
          if (options.retryEdit && request.toolId === 'entity.create') {
            const id = `${request.id}:retry`; const retried = waitForResult(id);
            yield emit('tool-request', { toolCallId: id, toolId: request.toolId, arguments: request.arguments }); await retried;
          }
        }
        if (options.onCompletedText) yield emit('conversation-node', { status: 'streaming', delta: 'Completed the current step.' });
        yield emit('completed', { status: 'completed' });
      },
      async *resume() { options.onResume?.(); yield emit('completed', { status: 'completed' }); }, async cancel() {}, async recordToolResult() {},
    },
  };
}

function toolsFixture(options = {}) {
  const preparations = new Map();
  const fixture = {
    evaluationTaskSpec: null,
    evaluations: 0,
    definitions: () => [
      { id: 'engine.docs.search', description: 'Search docs', effect: 'observe', risk: 'low', inputSchema: {} },
      { id: 'entity.create', description: 'Create entity', effect: 'reversible-edit', risk: 'medium', inputSchema: {} },
      { id: 'play.inspect', description: 'Inspect Play', effect: 'observe', risk: 'low', inputSchema: {} },
      { id: 'task.evaluate', description: 'Evaluate task', effect: 'observe', risk: 'low', inputSchema: {} },
    ],
    async prepare(call) { options.onPrepare?.(call); const preparation = { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: call.toolId === 'entity.create' ? 'reversible-edit' : 'observe', risk: 'low', documentId: 'document:g11', baseRevision: 7, argumentsDigest: digest('d'), previewDigest: digest('f'), preview: { title: call.toolId, target: 'Current project', summary: call.toolId, diff: '' }, status: 'ready', arguments: call.arguments, taskId: call.taskId }; preparations.set(preparation.id, preparation); return preparation; },
    async execute(id) {
      const prepared = preparations.get(id); if (!prepared) throw new Error('missing preparation');
      if (prepared.toolId === 'engine.docs.search') return result(prepared, { matches: [], requestedCount: prepared.arguments.limit }, 7, 7);
      if (prepared.toolId === 'entity.create' && options.editFailure && !prepared.callId.endsWith(':retry')) throw Object.assign(new Error('Query window contains 31784 retained events; scan budget is 10000.'), { code: 'query-scan-budget-exceeded' });
      if (prepared.toolId === 'entity.create') return result(prepared, { entityId: 'entity:score-target', revision: 7 }, 7, 7);
      if (prepared.toolId === 'play.inspect') return result(prepared, { observation: observation(prepared.taskId) }, 7, 7);
      if (prepared.toolId === 'task.evaluate') {
        fixture.evaluationTaskSpec = prepared.arguments.taskSpec;
        fixture.evaluations += 1;
        const diagnostic = options.terminalAfterRepair && fixture.evaluations > 1 ? 'evaluation.evidence-provenance-mismatch' : options.recoverOnce && fixture.evaluations === 1 ? 'evaluation.screenshot-state-tick-mismatch' : options.diagnostic;
        const acceptanceId = prepared.arguments.taskSpec.acceptance[0].id;
        return result(prepared, { schemaVersion: 2, id: 'evaluation:g11', taskId: prepared.taskId, evaluatorVersion: 'g11-fixture', status: diagnostic ? 'blocked' : 'pass', acceptanceResults: [{ acceptanceId, status: diagnostic ? 'blocked' : 'pass', evidenceIds: [evidenceId], diagnostic: diagnostic ?? null }], budgetStatus: 'within', usageRecordIds: [], costRecordIds: [], turns: [], tools: [], completedAt: '2026-08-29T00:00:30.000Z' }, 7, 7);
      }
      throw new Error(`unexpected tool ${prepared.toolId}`);
    },
  };
  return fixture;
}

function observation(taskId) { return { schemaVersion: 2, id: evidenceId, type: 'state', digest: `sha256:${'e'.repeat(64)}`, taskId, turnId, playId: 'play:g11', documentRevision: 7, scriptDigests: [`sha256:${'1'.repeat(64)}`], tick: 42, frame: 42, viewport: { width: 393, height: 852 }, device: 'phone:g11', capturedAt: '2026-08-29T00:00:20.000Z', byteLength: 128, redacted: false, producerVersion: 'g11-fixture' }; }
function interruptedTaskRun() { return { schemaVersion: 1, revision: 3, taskId: 'task:g11-interrupted', title: 'Interrupted fixture', requestSummary: 'Resume after Studio restart.', status: 'running', phase: 'editing', startedAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:01:00.000Z', backendId, sessionId, turnId, model: { id: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4096 }, promptProfile: { id: 'prompt:g11-general', version: '2.0.0', digest: `sha256:${'a'.repeat(64)}` }, documentRevision: 7, repairIteration: 0, repairLimit: 2, acceptance: [], evidence: [], timeline: [{ id: 'timeline:g11-interrupted', at: '2026-08-29T00:01:00.000Z', phase: 'editing', status: 'active', title: 'Editing', detail: 'Before crash', turnId, toolCallId: null, playId: null, tick: null }], terminalDiagnostic: null, resumable: false }; }
function result(prepared, value, beforeRevision, afterRevision) { return { schemaVersion: 1, callId: prepared.callId, toolId: prepared.toolId, status: 'completed', value, documentId: 'document:g11', beforeRevision, afterRevision }; }
function event(kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
function digest(value) { return `sha256:${value.repeat(64)}`; }
function projectContext() { return { projectId: 'project:g11', documentId: 'document:g11', revision: 7, manifest: {} }; }
function nodes(host) { return host.replay().events.map((item) => item.node); }
function openLog(root, options = {}) { return OperationLog.open({ rootDirectory: root, appVersion: 'g11-test', flushPolicy: 'always', ...options }); }
async function waitFor(predicate) { for (let index = 0; index < 400; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for G11 task state.'); }

 test('turn completion preserves the specific terminal evaluation diagnostic', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-terminal-diagnostic-'));
  const log = await openLog(root);
  const host = new StudioConversationHost({ runtime: runtimeFixture(), tools: toolsFixture({ diagnostic: 'evaluation.evidence-provenance-mismatch' }), operationLog: log, projectContext });
  try {
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Verify the composite object.' });
    await waitFor(() => nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
    const plan = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => nodes(host).some(node => node.kind === 'completion'));
    const run = host.replay().taskRuns.at(-1);
    assert.equal(run.status, 'blocked');
    assert.equal(run.terminalDiagnostic, 'evaluation.evidence-provenance-mismatch');
    assert.equal(run.resumable, false);
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});

 test('same-tick mismatch triggers bounded recapture and completes the original approved task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-recapture-'));
  const log = await openLog(root); const tools = toolsFixture({ recoverOnce: true });
  const host = new StudioConversationHost({ runtime: runtimeFixture({ repair: true }), tools, operationLog: log, projectContext });
  try {
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Verify the composite object.' });
    await waitFor(() => nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
    const plan = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => host.replay().taskRuns.at(-1)?.status === 'completed');
    const run = host.replay().taskRuns.at(-1);
    assert.equal(tools.evaluations, 2);
    assert.equal(run.repairIteration, 1);
    assert.equal(run.terminalDiagnostic, null);
    assert.ok(run.timeline.some(item => item.phase === 'repairing'));
    assert.equal(host.replay().taskRuns.length, 1);
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});


test('unfinished acceptance reports the actual failed authoring tool instead of a generic evidence error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-tool-blocker-'));
  const log = await openLog(root);
  const host = new StudioConversationHost({ runtime: runtimeFixture({ stopAfterEdit: true }), tools: toolsFixture({ editFailure: true }), operationLog: log, projectContext });
  try {
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create an interactive object.' });
    await waitFor(() => nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
    const plan = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => !host.replay().busy);
    const run = host.replay().taskRuns.at(-1);
    assert.equal(run.status, 'blocked');
    assert.equal(run.terminalDiagnostic, 'query-scan-budget-exceeded');
    assert.match(run.timeline.at(-1).detail, /entity.create.*query-scan-budget-exceeded.*31784/);
    assert.doesNotMatch(run.timeline.at(-1).detail, /验收尚未完成/);
    assert.equal(run.acceptance[0].status, 'pending');
    assert.deepEqual(run.evidence, []);
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});


test('a successful tool retry clears its failure so missing acceptance is not blamed on a resolved error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-resolved-tool-'));
  const log = await openLog(root);
  const host = new StudioConversationHost({ runtime: runtimeFixture({ stopAfterEdit: true, retryEdit: true }), tools: toolsFixture({ editFailure: true }), operationLog: log, projectContext });
  try {
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create an interactive object.' });
    await waitFor(() => nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
    const plan = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => !host.replay().busy);
    assert.equal(host.replay().taskRuns.at(-1).terminalDiagnostic, 'task.acceptance-evidence-incomplete');
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});

test('an early completed turn continues the same approved task through real evaluation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-early-completion-'));
  const log = await openLog(root); const requests = [];
  const runtime = runtimeFixture({ completeOnContinuation: true, onCompletedText: true, onStart: input => requests.push(input) });
  const tools = toolsFixture(); const host = new StudioConversationHost({ runtime, tools, operationLog: log, projectContext });
  try {
    await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Build and verify the score interaction.' });
    await waitFor(() => nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
    const plan = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => !host.replay().busy);
    const run = host.replay().taskRuns.at(-1);
    assert.equal(run.status, 'completed'); assert.equal(tools.evaluations, 1);
    assert.equal(requests.length, 2); assert.equal(requests[0].taskId, requests[1].taskId);
    const latestText = new Map(nodes(host).filter(node => node.kind === 'text').map(node => [node.id,node]));
    assert.ok([...latestText.values()].every(node => node.status === 'completed'));
    assert.match(requests[1].prompt, /evidence state signal score equals 1/);
    assert.match(requests[1].prompt, /invoke that tool so Studio can present the actual approval/);
    assert.equal(run.timeline.filter(item => item.title === '继续补齐任务与验收').length, 1);
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});

test('a persisted unfinished checkpoint starts fresh execution instead of replaying old tool requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-fresh-checkpoint-'));
  const log = await openLog(root);
  const run = { ...interruptedTaskRun(), status: 'blocked', phase: 'blocked', resumable: true, terminalDiagnostic: 'task.acceptance-evidence-incomplete', acceptance: [{ id: 'acceptance:checkpoint:1', label: 'Score becomes one', assertion: 'evidence state signal score equals 1', category: 'functional', required: true, visibility: 'agent', status: 'pending', evidenceIds: [], diagnostic: null }] };
  const artifact = await log.putArtifact(run, { schemaVersion: 'conversation-task/1' });
  await log.append({ kind: 'conversation/task-projected', severity: 'info', source: 'studio.conversation-host', correlation: { sessionId, turnId }, payload: { taskId: run.taskId, revision: run.revision, status: run.status, phase: run.phase, artifactId: artifact.id }, artifactRefs: [artifact.id] });
  let resumed = 0; const requests = []; const tools = toolsFixture();
  const host = new StudioConversationHost({ runtime: runtimeFixture({ resumeCheckpoint: true, onStart: input => requests.push(input), onResume: () => resumed++ }), tools, operationLog: log, projectContext });
  try {
    await host.initialize(); await host.dispatch({ type: 'conversation/retry', backendId, sessionId, turnId });
    await waitFor(() => !host.replay().busy);
    assert.equal(resumed, 0); assert.equal(requests.length, 1);
    assert.equal(requests[0].taskId, run.taskId); assert.match(requests[0].prompt, /evidence state signal score equals 1/);
    assert.equal(host.replay().taskRuns.at(-1).status, 'completed');
    assert.deepEqual(tools.evaluationTaskSpec.acceptance.map(item => item.id), ['acceptance:checkpoint:1']);
    assert.equal(nodes(host).filter(node => node.kind === 'plan').length, 0);
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});

test('automatic incomplete-acceptance continuation stops at two attempts without inventing evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-completion-bound-'));
  const log = await openLog(root); const requests = [];
  const host = new StudioConversationHost({ runtime: runtimeFixture({ stopAfterEdit: true, onStart: input => requests.push(input) }), tools: toolsFixture(), operationLog: log, projectContext });
  try {
    await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Finish and verify.' });
    await waitFor(() => nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
    const plan = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => !host.replay().busy);
    const run = host.replay().taskRuns.at(-1);
    assert.equal(requests.length, 3); assert.equal(run.status, 'blocked');
    assert.equal(run.terminalDiagnostic, 'task.acceptance-evidence-incomplete');
    assert.equal(run.evidence.length, 0); assert.equal(run.acceptance[0].status, 'pending');
    assert.equal(run.timeline.filter(item => item.title === '继续补齐任务与验收').length, 2);
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});


test('terminal evaluation clears an earlier queued repair and permits inspection without restarting a blocked task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-terminal-repair-')); let host, log;
  try {
    log = await openLog(root); let starts = 0;
    const tools = toolsFixture({ recoverOnce: true, terminalAfterRepair: true });
    host = new StudioConversationHost({ runtime: runtimeFixture({ terminalAfterRepair: true, onStart() { starts++; } }), tools, operationLog: log, projectContext });
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Verify a staged game.' });
    await waitFor(() => nodes(host).some(node => node.kind === 'plan' && node.status === 'pending'));
    const plan = nodes(host).find(node => node.kind === 'plan' && node.status === 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map(item => item.id), mode: 'approve' });
    await waitFor(() => !host.replay().busy);
    const run = host.replay().taskRuns.at(-1);
    assert.equal(starts, 1); assert.equal(tools.evaluations, 2);
    assert.equal(run.status, 'blocked'); assert.equal(run.phase, 'blocked');
    assert.equal(run.terminalDiagnostic, 'evaluation.evidence-provenance-mismatch');
    assert.ok(!JSON.stringify(run).includes('task.transition-invalid'));
    assert.ok(run.timeline.some(item => item.phase === 'repairing'));
  } finally { await host?.dispose(); await log?.close(); await rm(root, { recursive: true, force: true }); }
});


for (const choice of ['query-expand', 'query-cap']) test(`query quantity ${choice} continues successfully and reuses this task's choice`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-query-allowance-'));
  const log = await openLog(root); const calls = [];
  const requests = [1, 2].map(n => ({ id: `tool:query-${n}`, toolId: 'engine.docs.search', arguments: { query: 'pointer', limit: 20 } }));
  const host = new StudioConversationHost({ runtime: runtimeFixture({ requests }), tools: toolsFixture({ onPrepare: call => calls.push(call) }), operationLog: log, projectContext });
  try {
    await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Find pointer documentation.' });
    await waitFor(() => nodes(host).some(n => n.kind === 'question' && n.status === 'pending'));
    assert.equal(calls.length, 0);
    assert.equal(host.replay().taskRuns.at(-1).status, 'waiting-user');
    const question = nodes(host).find(n => n.kind === 'question' && n.status === 'pending');
    await assert.rejects(host.dispatch({ type: 'conversation/answer-question', nodeId: question.id, answer: { optionIds: ['option:forged'] } }));
    // A malformed answer must not grant a larger query. Use a fresh valid choice on the same barrier.
    await host.dispatch({ type: 'conversation/answer-question', nodeId: question.id, answer: { optionIds: [question.content.options.find(o => o.id.includes(choice)).id] } });
    await waitFor(() => !host.replay().busy);
    assert.deepEqual(calls.map(c => c.arguments.limit), [choice === 'query-expand' ? 20 : 12, choice === 'query-expand' ? 20 : 12]);
    assert.equal(new Set(nodes(host).filter(n => n.kind === 'question').map(n => n.id)).size, 1);
    assert.ok(!nodes(host).some(n => n.kind === 'tool-result' && n.status === 'failed'));
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'A separate new task searches more docs.' });
    await waitFor(() => nodes(host).some(n => n.kind === 'question' && n.status === 'pending' && n.id !== question.id));
    assert.equal(calls.length, 2, 'a previous task cannot grant the new task a query allowance');
    const nextQuestion = nodes(host).filter(n => n.kind === 'question' && n.status === 'pending' && n.id !== question.id).at(-1);
    await host.dispatch({ type: 'conversation/answer-question', nodeId: nextQuestion.id, answer: { optionIds: [nextQuestion.content.options.find(o => o.id.includes('query-cap')).id] } });
    await waitFor(() => !host.replay().busy);
    assert.deepEqual(calls.slice(2).map(c => c.arguments.limit), [12, 12]);
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});

test('query preferences are dynamic and omitted limit uses the configured threshold', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-query-default-')); const log = await openLog(root); const calls = [];
  const limits = { 'engine.docs.search': 25, 'tool.search': 50, 'scene.query': 100, 'scene.diff': 100 };
  const host = new StudioConversationHost({ runtime: runtimeFixture({ requests: [{ id: 'tool:query-default', toolId: 'engine.docs.search', arguments: { query: 'pointer' } }] }), tools: toolsFixture({ onPrepare: call => calls.push(call) }), operationLog: log, projectContext, queryLimits: () => limits });
  try {
    await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Read pointer docs.' }); await waitFor(() => !host.replay().busy);
    assert.equal(calls[0].arguments.limit, 25); assert.ok(!nodes(host).some(n => n.kind === 'question'));
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});


for (const choice of ['query-expand', 'query-cap']) test(`query allowance ${choice} survives host/session restart and resumes the pending read`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-query-restart-'));
  let log, sessions, host;
  const calls = [];
  const requests = [{ id: 'tool:query-durable', toolId: 'engine.docs.search', arguments: { query: 'pointer', limit: 20 } }];
  try {
    log = await openLog(root); sessions = new DurableSessionRuntime(log);
    host = new StudioConversationHost({ runtime: runtimeFixture({ requests, sessions, turnId: 'turn:quota:1' }), tools: toolsFixture({ onPrepare: c => calls.push(c) }), operationLog: log, projectContext, sessionRecovery: { async recover() {} } });
    await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Find pointer docs.' });
    await waitFor(() => !host.replay().busy && nodes(host).some(n => n.kind === 'question' && n.status === 'pending'));
    const pending = nodes(host).find(n => n.kind === 'question' && n.status === 'pending');
    assert.equal(calls.length, 0);
    assert.equal(host.replay().taskRuns.at(-1).status, 'waiting-user');
    assert.ok(host.replay().executionGraphs.flatMap(g => g.nodes).some(n => n.kind === 'question' && n.status === 'waiting'));
    await host.dispose(); await sessions.dispose(); await log.close();
    log = await openLog(root); sessions = new DurableSessionRuntime(log);
    host = new StudioConversationHost({ runtime: runtimeFixture({ requests, sessions, turnId: 'turn:quota:2' }), tools: toolsFixture({ onPrepare: c => calls.push(c) }), operationLog: log, projectContext, sessionRecovery: { async recover() {} } });
    await host.initialize();
    const restored = nodes(host).filter(n => n.id === pending.id).at(-1);
    assert.equal(restored.content.queryLimit.requested, 20);
    await assert.rejects(host.dispatch({ type: 'conversation/answer-question', nodeId: pending.id, answer: { optionIds: ['option:forged'] } }));
    await host.dispatch({ type: 'conversation/answer-question', nodeId: pending.id, answer: { optionIds: [restored.content.options.find(o => o.id.includes(choice)).id] } });
    await waitFor(() => !host.replay().busy && calls.length === 1);
    assert.equal(calls[0].arguments.limit, choice === 'query-expand' ? 20 : 12);
    assert.deepEqual((await sessions.replay(sessionId)).recovery.unresolvedBarrierIds, []);
    assert.ok(!nodes(host).some(n => n.kind === 'tool-result' && n.status === 'failed'));
  } finally { await host?.dispose(); await sessions?.dispose(); await log?.close(); await rm(root, { recursive: true, force: true }); }
});


test('cancelling an unanswered query allowance never executes the read', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-query-cancel-')); const log = await openLog(root); const calls = [];
  const host = new StudioConversationHost({ runtime: runtimeFixture({ requests: [{ id: 'tool:query-cancel', toolId: 'engine.docs.search', arguments: { query: 'pointer', limit: 20 } }] }), tools: toolsFixture({ onPrepare: c => calls.push(c) }), operationLog: log, projectContext });
  try {
    await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Search docs.' });
    await waitFor(() => nodes(host).some(n => n.kind === 'question' && n.status === 'pending'));
    await host.dispatch({ type: 'conversation/cancel', backendId, sessionId, turnId });
    await waitFor(() => !host.replay().busy);
    assert.equal(calls.length, 0);
    assert.equal(nodes(host).filter(n => n.kind === 'question').at(-1).status, 'cancelled');
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});


test('parallel queries share one allowance question while preserving each query', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-query-parallel-')); const log = await openLog(root); const calls = [];
  const parallelRequests = ['pointer', 'camera'].map((query, n) => ({ id: `tool:parallel-query-${n}`, toolId: 'engine.docs.search', arguments: { query, limit: 20 } }));
  const host = new StudioConversationHost({ runtime: runtimeFixture({ parallelRequests }), tools: toolsFixture({ onPrepare: c => calls.push(c) }), operationLog: log, projectContext });
  try {
    await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Search pointer and camera docs.' });
    await waitFor(() => nodes(host).some(n => n.kind === 'question' && n.status === 'pending') && nodes(host).filter(n => n.kind === 'tool-call').length >= 2);
    const questions = nodes(host).filter(n => n.kind === 'question'); assert.equal(new Set(questions.map(n => n.id)).size, 1); assert.equal(calls.length, 0);
    const question = questions.at(-1);
    await host.dispatch({ type: 'conversation/answer-question', nodeId: question.id, answer: { optionIds: [question.content.options.find(o => o.id.includes('query-expand')).id] } });
    await waitFor(() => !host.replay().busy);
    assert.deepEqual(calls.map(c => c.arguments.query).sort(), ['camera', 'pointer']);
    assert.ok(calls.every(c => c.arguments.limit === 20));
  } finally { await host.dispose(); await log.close(); await rm(root, { recursive: true, force: true }); }
});
