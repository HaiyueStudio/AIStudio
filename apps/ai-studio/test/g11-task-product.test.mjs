import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { StudioConversationHost } from '../dist/conversation-host.js';

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

function runtimeFixture(options = {}) {
  const releases = new Map();
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
    context: { prompts: { profile }, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'b'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'c'.repeat(64)}`, cache: { localArtifactHits: 1, localArtifactMisses: 0, deltaReuseBytes: 64, providerCacheEligibleBytes: 128, providerReportedHitTokens: null } }; }, async commit() {} },
    registry: { descriptors: () => [backend.descriptor], get: () => backend }, usage, accounting: new TaskAccountingRegistry(usage),
    turns: {
      async *start() {
        if (options.empty) { yield event('completed', { status: 'completed' }); return; }
        for (const request of [
          { id: 'tool:g11-plan', toolId: 'studio.plan.propose', arguments: { title: 'Score interaction', summary: 'Create, run and verify one score interaction.', items: [{ label: 'Author score controller', details: 'Create the controller and observable score state.' }], acceptance: [{ label: 'Score becomes one', required: true, category: 'functional', assertion: 'evidence state signal score equals 1' }] } },
          { id: 'tool:g11-edit', toolId: 'entity.create', arguments: { baseRevision: 7, kind: 'cube', name: 'ScoreTarget' } },
          { id: 'tool:g11-inspect', toolId: 'play.inspect', arguments: {} },
          { id: 'tool:g11-evaluate', toolId: 'task.evaluate', arguments: { taskSpec: { schemaVersion: 2, id: 'task:spoofed', request: 'spoofed', visibleConstraints: [], budgetId: 'budget:spoofed', requiredCapabilities: [], acceptance: [{ id: 'acceptance:spoofed', required: true, visibility: 'agent', category: 'functional', assertion: 'evidence state' }] }, observationIds: [evidenceId] } },
        ]) {
          const released = waitForResult(request.id); yield event('tool-request', { toolCallId: request.id, toolId: request.toolId, arguments: request.arguments }); await released;
        }
        yield event('completed', { status: 'completed' });
      },
      async *resume() { yield event('completed', { status: 'completed' }); }, async cancel() {}, async recordToolResult() {},
    },
  };
}

function toolsFixture() {
  const preparations = new Map();
  const fixture = {
    evaluationTaskSpec: null,
    definitions: () => [
      { id: 'entity.create', description: 'Create entity', effect: 'reversible-edit', risk: 'medium', inputSchema: {} },
      { id: 'play.inspect', description: 'Inspect Play', effect: 'observe', risk: 'low', inputSchema: {} },
      { id: 'task.evaluate', description: 'Evaluate task', effect: 'observe', risk: 'low', inputSchema: {} },
    ],
    async prepare(call) { const preparation = { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: call.toolId === 'entity.create' ? 'reversible-edit' : 'observe', risk: 'low', documentId: 'document:g11', baseRevision: 7, argumentsDigest: digest('d'), previewDigest: digest('f'), preview: { title: call.toolId, target: 'Current project', summary: call.toolId, diff: '' }, status: 'ready', arguments: call.arguments, taskId: call.taskId }; preparations.set(preparation.id, preparation); return preparation; },
    async execute(id) {
      const prepared = preparations.get(id); if (!prepared) throw new Error('missing preparation');
      if (prepared.toolId === 'entity.create') return result(prepared, { entityId: 'entity:score-target', revision: 7 }, 7, 7);
      if (prepared.toolId === 'play.inspect') return result(prepared, { observation: observation(prepared.taskId) }, 7, 7);
      if (prepared.toolId === 'task.evaluate') {
        fixture.evaluationTaskSpec = prepared.arguments.taskSpec;
        const acceptanceId = prepared.arguments.taskSpec.acceptance[0].id;
        return result(prepared, { schemaVersion: 2, id: 'evaluation:g11', taskId: prepared.taskId, evaluatorVersion: 'g11-fixture', status: 'pass', acceptanceResults: [{ acceptanceId, status: 'pass', evidenceIds: [evidenceId], diagnostic: null }], budgetStatus: 'within', usageRecordIds: [], costRecordIds: [], turns: [], tools: [], completedAt: '2026-08-29T00:00:30.000Z' }, 7, 7);
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
function openLog(root) { return OperationLog.open({ rootDirectory: root, appVersion: 'g11-test', flushPolicy: 'always' }); }
async function waitFor(predicate) { for (let index = 0; index < 400; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for G11 task state.'); }
