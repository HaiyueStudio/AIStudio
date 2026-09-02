import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableSessionRuntime, TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioConversationHost } from '../dist/conversation-host.js';

const backendId = 'backend:g07-retention';
const sessionId = 'session:g07-retention';
const firstTurnId = 'turn:g07-retention-plan';
const workTurnId = 'turn:g07-retention-work';
const model = 'deepseek-v4-flash';

test('declining a durable budget continuation preserves transaction, state, screenshot, evaluator and cost after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-retention-'));
  let log; let sessions; let host;
  try {
    log = await openLog(root); sessions = new DurableSessionRuntime(log);
    const tools = retentionTools(log); const runtime = retentionRuntime(sessions, tools);
    let projectRevision = 7;
    host = new StudioConversationHost({ runtime, tools, operationLog: log, sessionRecovery: { async recover() {} }, projectContext: () => ({ projectId: 'project:g07-retention', documentId: 'document:g07-retention', revision: projectRevision, name: 'Retention fixture', dirty: false, selectedEntityId: null, sceneDigest: digest('1'), scriptDigest: digest('2'), capabilityDigest: digest('3'), capabilityManifest: {}, projectSummary: {} }) });
    tools.onCommit = (revision) => { projectRevision = revision; };
    await host.initialize();
    await host.dispatch({ type: 'agent/configure', backendId, model, reasoningEffort: 'off', outputTokenLimit: 4096, budget: { schemaVersion: 2, id: 'budget:g07-retention', enforcement: 'hard', limits: { inputTokens: 100_000, outputTokens: 10_000, estimatedCostMicros: 1_000_000, wallTimeMs: 60_000, turns: 3, toolCalls: 5, repairIterations: 2, observationBytes: 100_000 } } });
    await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Commit one edit, collect state and screenshot evidence, evaluate it, then stop safely at the next budget boundary.' });
    await waitFor(() => latestNode(host, 'plan', 'pending'));
    const plan = latestNode(host, 'plan', 'pending');
    await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map((item) => item.id), mode: 'approve' });
    await waitFor(() => host.replay().busy === false && latestBudgetQuestion(host));

    const beforeStop = host.replay().taskRuns.at(-1);
    assert.equal(tools.transactionCalls, 1); assert.ok(tools.receiptArtifactId);
    assert.deepEqual(new Set(beforeStop.evidence.map((item) => item.type)), new Set(['state', 'screenshot']));
    assert.equal(beforeStop.evidence.every((item) => item.provenanceStatus === 'current' && item.documentRevision === 8), true, JSON.stringify({ documentRevision: beforeStop.documentRevision, evidence: beforeStop.evidence }));
    assert.equal(beforeStop.evidence.find((item) => item.type === 'screenshot').previewDataUrl.startsWith('data:image/png;base64,'), true);
    assert.deepEqual(beforeStop.acceptance.map((item) => item.status), ['fail', 'pass']);
    assert.deepEqual(new Set(beforeStop.acceptance.flatMap((item) => item.evidenceIds)), new Set(tools.evidenceIds));
    const accountingBeforeStop = host.replay().taskAccounting;
    assert.equal(accountingBeforeStop.usage.inputTokens, 1_000);
    assert.equal(accountingBeforeStop.cost.status, 'estimated'); assert.ok(accountingBeforeStop.cost.amountMicros > 0);
    const receiptBefore = await log.readArtifact(tools.receiptArtifactId); assert.equal(receiptBefore.value.transactionId, 'transaction:g07-retention');

    const question = latestBudgetQuestion(host); const stop = question.content.options.find((option) => String(option.id).includes('budget-stop'));
    await host.dispatch({ type: 'conversation/answer-question', nodeId: question.id, answer: { optionIds: [stop.id] } });
    await waitFor(() => host.replay().busy === false);
    assert.equal(host.replay().taskRuns.at(-1).status, 'cancelled', JSON.stringify(host.replay().taskRuns.at(-1)));
    const stopped = JSON.parse(JSON.stringify(host.replay().taskRuns.at(-1)));
    const stoppedAccounting = JSON.parse(JSON.stringify(host.replay().taskAccounting));
    assert.deepEqual(stopped.evidence, JSON.parse(JSON.stringify(beforeStop.evidence)));
    assert.deepEqual(stopped.acceptance, JSON.parse(JSON.stringify(beforeStop.acceptance)));
    assert.equal(stopped.terminalDiagnostic, 'budget.stopped-after-restart');
    await host.dispose(); host = null; await sessions.dispose(); sessions = null; await log.close(); log = null;

    log = await openLog(root); sessions = new DurableSessionRuntime(log);
    host = new StudioConversationHost({ runtime: emptyRuntime(sessions), tools: retentionTools(log), operationLog: log, sessionRecovery: { async recover() {} }, projectContext: () => ({ projectId: 'project:g07-retention', documentId: 'document:g07-retention', revision: 8, manifest: {} }) });
    await host.initialize();
    const restored = host.replay().taskRuns.at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(restored)), stopped);
    assert.deepEqual(JSON.parse(JSON.stringify(host.replay().taskAccounting)), stoppedAccounting);
    assert.equal(restored.evidence.find((item) => item.type === 'screenshot').previewDataUrl.startsWith('data:image/png;base64,'), true);
    const receiptAfter = await log.readArtifact(tools.receiptArtifactId); assert.equal(receiptAfter.digest, receiptBefore.digest);
    const commits = await log.query({ kinds: ['agent/session-op'], limit: 200, traverseCorrelation: false });
    assert.equal(commits.events.filter((event) => event.payload.sessionOp?.kind === 'document.committed').length, 1);
  } finally {
    await host?.dispose().catch(() => undefined); await sessions?.dispose().catch(() => undefined); await log?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function retentionRuntime(sessions, tools) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const releases = new Map(); let stage = 0; let ledger;
  const backend = backendFixture((toolCallId) => { releases.get(toolCallId)?.(); releases.delete(toolCallId); });
  const runtime = { sessions, usage, accounting, registry: { descriptors: () => [backend.descriptor], get: () => backend }, context: contextFixture(), turns: {
    async *start(_backendId, input) {
      stage += 1; const turnId = stage === 1 ? firstTurnId : workTurnId;
      if (!ledger) {
        ledger = usage.open({ taskId: input.taskId, sessionId, turnId: workTurnId, providerRequestDigest: null, startedAtMs: 1_000 });
        ledger.reconcile({ eventId: 'usage:g07-retention', sequence: 1, mode: 'cumulative', inputTokens: 1_000, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0, observedAtMs: 1_100, final: false });
      }
      if (stage === 1) {
        yield event(turnId, 'tool-request', { toolCallId: 'call:g07-retention-plan', toolId: 'studio.plan.propose', arguments: { title: 'Retention proof', summary: 'Commit, observe, capture and evaluate before a safe budget stop.', items: [{ label: 'Commit one entity', details: 'Create one entity in an atomic Scene transaction.' }, { label: 'Collect durable evidence', details: 'Capture state and screenshot at the committed revision.' }], acceptance: [{ label: 'Score reaches two', required: true, category: 'functional', assertion: 'evidence state signal score equals 2' }, { label: 'Screenshot retained', required: true, category: 'visual', assertion: 'evidence screenshot' }] } });
        await released(releases, 'call:g07-retention-plan');
        yield event(turnId, 'completed', { status: 'cancelled' }); return;
      }
      for (const request of [
        { id: 'call:g07-retention-edit', toolId: 'entity.create', arguments: { baseRevision: 7, kind: 'cube', name: 'Retained Entity' } },
        { id: 'call:g07-retention-state', toolId: 'play.inspect', arguments: {} },
        { id: 'call:g07-retention-shot', toolId: 'play.capture', arguments: {} },
      ]) { yield event(turnId, 'tool-request', { toolCallId: request.id, toolId: request.toolId, arguments: request.arguments }); await released(releases, request.id); }
      yield event(turnId, 'tool-request', { toolCallId: 'call:g07-retention-evaluate', toolId: 'task.evaluate', arguments: { observationIds: tools.evidenceIds } });
      await released(releases, 'call:g07-retention-evaluate');
      yield event(turnId, 'tool-request', { toolCallId: 'call:g07-retention-over-budget', toolId: 'diagnostics.query', arguments: {} });
      await released(releases, 'call:g07-retention-over-budget');
      ledger.reconcile({ eventId: 'usage:g07-retention-final', sequence: 2, mode: 'cumulative', inputTokens: 1_000, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0, observedAtMs: 1_200, final: true });
      yield event(turnId, 'completed', { status: 'cancelled' });
    },
    async *resume() {}, async cancel(_backendId, _sessionId, turnId) { for (const [id, resolve] of releases) { resolve(); releases.delete(id); } }, async recordToolResult() {},
  } };
  return runtime;
}

function emptyRuntime(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const backend = backendFixture(() => {});
  return { sessions, usage, accounting, registry: { descriptors: () => [backend.descriptor], get: () => backend }, context: contextFixture(), turns: { async *start() { yield event(workTurnId, 'completed', { status: 'completed' }); }, async *resume() { yield event(workTurnId, 'completed', { status: 'completed' }); }, async cancel() {}, async recordToolResult() {} } };
}

function retentionTools(log) {
  const preparations = new Map(); const tools = { evidenceIds: [], transactionCalls: 0, receiptArtifactId: null, onCommit: () => {},
    definitions: () => [
      definition('entity.create', 'reversible-edit'), definition('play.inspect', 'observe'), definition('play.capture', 'observe'), definition('task.evaluate', 'observe'), definition('diagnostics.query', 'observe'),
    ],
    async prepare(call) { const effect = call.toolId === 'entity.create' ? 'reversible-edit' : 'observe'; const preparation = { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, taskId: call.taskId, toolId: call.toolId, toolVersion: '1.0.0', effect, risk: 'low', documentId: 'document:g07-retention', baseRevision: call.toolId === 'entity.create' ? 7 : 8, argumentsDigest: digest('4'), previewDigest: digest('5'), preview: { title: call.toolId, target: 'Current project', summary: call.toolId, diff: call.toolId === 'entity.create' ? '+ Retained Entity' : '' }, status: 'ready', arguments: call.arguments }; preparations.set(preparation.id, preparation); return preparation; },
    async cancel() {},
    async executeTransaction(input) {
      tools.transactionCalls += 1; const preparation = preparations.get(input.preparationIds[0]);
      const receipt = { schemaVersion: 1, transactionId: 'transaction:g07-retention', idempotencyKey: 'idempotency:g07-retention', documentId: 'document:g07-retention', beforeRevision: 7, afterRevision: 8, memberDigest: digest('6'), operationDigest: digest('7'), historyEntryId: 'history:g07-retention' };
      const stored = await log.putArtifact(receipt, { schemaVersion: 'scene-transaction-receipt/1' }); tools.receiptArtifactId = stored.id; tools.onCommit(8);
      const transaction = { transactionId: receipt.transactionId, idempotencyKey: receipt.idempotencyKey, receiptDigest: stored.digest, receiptArtifactId: stored.id, memberCount: 1, replayed: false };
      return { ...transaction, beforeRevision: 7, afterRevision: 8, results: [{ schemaVersion: 1, callId: preparation.callId, toolId: preparation.toolId, status: 'completed', value: { entityId: 'entity:g07-retained', revision: 8 }, documentId: receipt.documentId, beforeRevision: 7, afterRevision: 8, historyLabel: 'Agent transaction · retained entity', transaction }] };
    },
    async execute(preparationId) {
      const preparation = preparations.get(preparationId); if (!preparation) throw new Error('missing preparation');
      if (preparation.toolId === 'play.inspect') return result(preparation, { observation: await persistObservation(log, preparation, 'state', { score: 1 }) });
      if (preparation.toolId === 'play.capture') return result(preparation, { observation: await persistObservation(log, preparation, 'screenshot', screenshotPayload()) });
      if (preparation.toolId === 'task.evaluate') {
        const acceptance = preparation.arguments.taskSpec.acceptance; const stateId = tools.evidenceIds[0]; const shotId = tools.evidenceIds[1];
        return result(preparation, { schemaVersion: 2, id: 'evaluation:g07-retention', taskId: preparation.taskId, evaluatorVersion: 'g07-retention-evaluator/1', status: 'fail', acceptanceResults: [{ acceptanceId: acceptance[0].id, status: 'fail', evidenceIds: [stateId], diagnostic: 'evaluation.condition-failed:score:equals' }, { acceptanceId: acceptance[1].id, status: 'pass', evidenceIds: [shotId], diagnostic: null }], budgetStatus: 'within', usageRecordIds: ['usage:g07-retention'], costRecordIds: ['cost:g07-retention'], turns: [], tools: [], completedAt: '2026-09-01T00:00:30.000Z' });
      }
      throw new Error(`unexpected execution ${preparation.toolId}`);
    },
  };
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (id) => { const value = await originalExecute(id); if (value.value?.observation?.id) tools.evidenceIds.push(value.value.observation.id); return value; };
  return tools;
}

async function persistObservation(log, preparation, type, payload) {
  const envelope = { kind: 'haiyue.play-observation.v2', type, taskId: preparation.taskId, turnId: preparation.turnId, playId: 'play:g07-retention', documentRevision: 8, scriptDigests: [digest('8')], tick: 42, frame: 42, viewport: { width: 393, height: 852 }, device: 'phone:g07-retention', capturedAt: '2026-09-01T00:00:20.000Z', redacted: false, producerVersion: 'g07-retention/1', payload };
  const stored = await log.putArtifact(envelope, { schemaVersion: 'haiyue.play-observation.v2' });
  return { schemaVersion: 2, id: stored.id, type, digest: stored.digest, taskId: preparation.taskId, turnId: preparation.turnId, playId: envelope.playId, documentRevision: 8, scriptDigests: envelope.scriptDigests, tick: 42, frame: 42, viewport: envelope.viewport, device: envelope.device, capturedAt: envelope.capturedAt, byteLength: stored.bytes, redacted: false, producerVersion: envelope.producerVersion };
}

function screenshotPayload() { const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Z20yAAAAAElFTkSuQmCC'; return { mediaType: 'image/png', byteLength: Buffer.from(base64, 'base64').byteLength, base64 }; }
function result(preparation, value) { return { schemaVersion: 1, callId: preparation.callId, toolId: preparation.toolId, status: 'completed', value, documentId: preparation.documentId, beforeRevision: 8, afterRevision: 8 }; }
function definition(id, effect) { return { id, description: id, effect, risk: 'low', inputSchema: {} }; }
function backendFixture(submit) { return { descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: model, label: model, description: 'Fixture', reasoningEfforts: ['off'], defaultReasoningEffort: 'off', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async submitToolResult(id) { submit(id); } }; }
function contextFixture() { const profile = { id: 'prompt:g07-retention', version: '1.0.0', digest: digest('9'), modules: [] }; return { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: digest('a'), promptProfile: profile, contextArtifactIds: [], contextDigest: digest('b'), cache: { localArtifactHits: 1, localArtifactMisses: 0, deltaReuseBytes: 128, providerCacheEligibleBytes: 256, providerReportedHitTokens: null } }; } }; }
function event(turnId, kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
function released(releases, id) { return new Promise((resolve) => releases.set(id, resolve)); }
function digest(character) { return `sha256:${character.repeat(64)}`; }
function latestNode(host, kind, status) { return host.replay().events.map((event) => event.node).filter((node) => node.kind === kind && node.status === status).at(-1); }
function latestBudgetQuestion(host) { return host.replay().events.map((event) => event.node).filter((node) => node.kind === 'question' && node.status === 'pending' && node.content.options?.some((option) => String(option.id).includes('budget-stop'))).at(-1); }
function openLog(root) { return OperationLog.open({ rootDirectory: root, appVersion: 'g07-retention-test', flushPolicy: 'always' }); }
async function waitFor(predicate) { for (let index = 0; index < 800; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for G07 retention state.'); }
