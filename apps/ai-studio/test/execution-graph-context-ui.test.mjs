import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BackendSessionRuntime,
  DurableSessionRuntime,
  ModelContextRuntime,
} from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioConversationHost } from '../dist/conversation-host.js';

const backendId = 'backend:g09-context';
const sessionId = 'session:g09-context';

test('manual context compaction is durable and replayed into the execution graph without deleting Transcript', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g09-context-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g09-test', flushPolicy: 'always' });
  const sessions = new DurableSessionRuntime(log);
  const modelContexts = new ModelContextRuntime(log, sessions);
  const backendSessions = new BackendSessionRuntime(sessions);
  const backend = backendFixture();
  backendSessions.register(backend);
  let turnIndex = 0;
  const runtime = {
    context: contextFixture(),
    accounting: accountingFixture(),
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    sessions,
    modelContexts,
    backendSessions,
    turns: {
      async *start() {
        turnIndex += 1;
        const turnId = `turn:g09-context:${turnIndex}`;
        yield event(turnId, 'status', { status: 'running', model: 'fixture-model' });
        yield event(turnId, 'conversation-node', { nodeKind: 'text', status: 'streaming', delta: turnIndex < 5 ? 'A'.repeat(3_000) : 'Context fixture complete.' });
        yield event(turnId, 'completed', { status: 'completed' });
      },
      async *resume() {}, async cancel() {}, async recordToolResult() {},
    },
  };
  const host = new StudioConversationHost({ runtime, tools: { definitions: () => [] }, operationLog: log, isProjectOpen: () => false });
  try {
    await host.initialize();
    for (let index = 0; index < 5; index += 1) {
      await host.dispatch({ type: 'conversation/send', backendId, prompt: `Continue the context fixture turn ${index + 1}.` });
      await waitFor(() => host.replay().busy === false);
    }
    await waitFor(() => {
      const graph = host.replay().executionGraphs[0];
      return Boolean(graph && graph.transcript.filter((item) => item.kind === 'message').length >= 10 && (graph.context.pressure?.ratio ?? 0) >= 0.8);
    });
    const before = host.replay().executionGraphs[0];
    assert.ok(before.context.pressure?.ratio >= 0.8, `expected pressure evidence, received ${before.context.pressure?.ratio}`);
    assert.equal(before.context.compactionAvailable, true);
    const transcriptBefore = before.transcript.filter((item) => item.kind === 'message').length;

    try { await host.dispatch({ type: 'conversation/request-compaction', sessionId, requestId: 'request:g09-context:1' }); }
    catch (cause) {
      const failed = await sessions.replay(sessionId);
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)} ${JSON.stringify(failed.ops.filter((op) => op.kind.startsWith('compaction.')).map((op) => op.payload))}`);
    }
    const after = host.replay().executionGraphs[0];
    assert.ok(after.nodes.some((node) => node.kind === 'compaction' && node.status === 'completed'));
    assert.ok(after.transcript.some((item) => item.kind === 'compaction'));
    assert.equal(after.transcript.filter((item) => item.kind === 'message').length, transcriptBefore, 'human Transcript must remain lossless');
    assert.ok(after.context.latestCompaction?.after?.ratio < before.context.pressure.ratio);

    await host.dispatch({ type: 'conversation/request-compaction', sessionId, requestId: 'request:g09-context:1' });
    assert.equal(host.replay().executionGraphs[0].nodes.filter((node) => node.kind === 'compaction').length, after.nodes.filter((node) => node.kind === 'compaction').length, 'duplicate request ids must be idempotent');

    const replayDigest = after.digest;
    const compactionCount = after.nodes.filter((node) => node.kind === 'compaction').length;
    await host.dispose();
    const restarted = new StudioConversationHost({ runtime, tools: { definitions: () => [] }, operationLog: log, isProjectOpen: () => false });
    try {
      await restarted.initialize();
      await waitFor(() => restarted.replay().executionGraphs.some((graph) => graph.sessionId === sessionId));
      assert.equal(restarted.replay().executionGraphs.find((graph) => graph.sessionId === sessionId).digest, replayDigest, 'main-process restart must replay the same semantic graph');
      await restarted.dispatch({ type: 'conversation/request-compaction', sessionId, requestId: 'request:g09-context:1' });
      assert.equal(restarted.replay().executionGraphs.find((graph) => graph.sessionId === sessionId).nodes.filter((node) => node.kind === 'compaction').length, compactionCount, 'durable request identity must survive restart');
    } finally { await restarted.dispose(); }
  } finally {
    await host.dispose();
    await backendSessions.dispose();
    await modelContexts.dispose();
    await sessions.dispose();
    await log.close();
  }
});

function event(turnId, kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }

function backendFixture() {
  return {
    backendId,
    provider: 'fixture-provider',
    descriptor: { schemaVersion: 1, id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: { resume: true, questions: true, structuredTools: true, backendApprovals: true, usage: true, rateLimits: true } },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture model', description: 'fixture', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async capabilities() { return { maxInputTokens: 16_000, nativeCompaction: false, parallelToolCalls: true, codeMode: false, providerUsage: 'unavailable', providerCache: 'unavailable', nativeCompactionTransport: 'unavailable', nativeCompactionMirror: 'fallback-required', diagnostic: null }; },
    async authenticate() { return null; }, async logout() {}, async negotiate() { throw new Error('not used'); }, async *startTurn() {}, async *resumeTurn() {},
    async submitToolResult() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async cancelTurn() {}, async dispose() {},
    async open() { throw new Error('not used'); }, async inspect() { throw new Error('not used'); }, async confirmBoundary() {}, async compact() { return { status: 'unavailable', diagnostic: { code: 'fixture.unavailable', message: 'Use Studio fallback.' } }; }, async detach() {},
  };
}

function contextFixture() {
  const profile = { id: 'prompt:game-authoring-general', version: '3.0.0', digest: `sha256:${'c'.repeat(64)}`, modules: [] };
  return {
    prompts: { profile },
    async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'d'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [`artifact:sha256:${'e'.repeat(64)}`], contextDigest: `sha256:${'f'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 1, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null }, reusedSessionId: null }; },
    async commit() { return { id: `artifact:sha256:${'a'.repeat(64)}` }; },
  };
}

function accountingFixture() {
  const accounts = new Map();
  return {
    open({ taskId, budget }) {
      const decision = { allowed: true, status: 'within', violations: [], warning: null, hardStopLatched: false };
      const snapshot = () => ({ taskId, budget, budgetDecision: decision, consumption: { inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0, wallTimeMs: 0, turns: 1, toolCalls: 0, repairIterations: 0, observationBytes: 0 }, usage: { inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, toolInputBytes: 0, toolOutputBytes: 0, wallTimeMs: 0 }, cost: { status: 'unknown', amountMicros: null, currency: null, cacheSavingMicros: null, explanation: 'Fixture provider has no billing data.', final: false }, turnIds: [] });
      const account = { options: { taskId, budget }, beginTurn: () => decision, bindTurn() {}, preflightTool: () => decision, commitTool: () => decision, expireWallTime: () => decision, reconcile: snapshot, snapshot };
      accounts.set(taskId, account); return account;
    },
    get(taskId) { return accounts.get(taskId); },
  };
}

async function waitFor(predicate) {
  for (let index = 0; index < 400; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for G09 fixture state.');
}
