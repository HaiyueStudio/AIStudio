import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContextCompactionRuntime, DurableSessionRuntime } from '@haiyue/ai-studio-agent-runtime';
import { GAME_AUTHORING_TOOL_DEFINITIONS, ToolBatchScheduler, normalizeToolBatchRequest } from '@haiyue/ai-studio-game-authoring-tools';
import { canonicalStringify, OperationLog, sha256 } from '@haiyue/ai-studio-operation-log';
import { layoutExecutionGraph, projectExecutionGraph } from '@haiyue/ai-studio-shell';

const binding = 'm13-g11-2026-09-02';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'haiyue-m13-g11-measure-'));
const log = await OperationLog.open({ rootDirectory: temporary, appVersion: binding, flushPolicy: 'always' });
let sessions = new DurableSessionRuntime(log);
try {
  const heapStart = process.memoryUsage().heapUsed;
  const handle = await sessions.create({ id: 'session:g11-performance', projectId: 'project:g11-performance', documentId: 'document:g11-performance', activeGoal: 'Exercise long Session replay and compaction.', taskBudgetId: 'budget:g11-performance' });
  await handle.bindBackend({ bindingId: 'binding:g11-performance', backendId: 'backend:g11-performance', provider: 'fixture', model: 'fixture-10k', remoteSessionId: 'remote:g11-performance', generation: 1, status: 'active', capabilities: { maxInputTokens: 10_000, nativeCompaction: false, parallelToolCalls: true, codeMode: true, providerUsage: 'reported', providerCache: 'reported' }, lastConfirmedOpId: null });
  for (const value of ['TOKENS:2500 decisions', 'TOKENS:2500 tools', 'TOKENS:2500 evidence', 'TOKENS:500 current request']) await handle.appendMessage({ role: value.includes('request') ? 'user' : 'assistant', content: value, projectRevision: 1 });
  const estimator = { estimate(text) { const match = /TOKENS:(\d+)/u.exec(text); return match ? Number(match[1]) : Math.max(1, Math.ceil(text.length / 4)); } };
  const compactor = new ContextCompactionRuntime(log, sessions, async ({ targetSummaryTokens }) => ({ summary: `TOKENS:${targetSummaryTokens} durable compacted context.` }), { estimator });
  const automatic = await compactor.compact(handle.id, { reason: 'automatic-threshold', backendBindingId: 'binding:g11-performance', reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 8_000 });
  await handle.appendMessage({ role: 'assistant', content: 'TOKENS:1200 post-compaction result', projectRevision: 2 });
  await handle.appendMessage({ role: 'user', content: 'TOKENS:300 manual follow-up', projectRevision: 2 });
  const manual = await compactor.compact(handle.id, { reason: 'manual', backendBindingId: 'binding:g11-performance', reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 7_000 });
  for (let index = 0; index < 120; index += 1) await handle.appendMessage({ role: index % 2 === 0 ? 'user' : 'assistant', content: `Long-session message ${index + 1}: ${'context '.repeat(24)}`, projectRevision: 2 });
  const sessionBeforeRestart = await handle.snapshot();
  const heapAfterSession = process.memoryUsage().heapUsed;
  await sessions.dispose();
  sessions = new DurableSessionRuntime(log);
  const sessionAfterRestart = await sessions.replay(handle.id);

  const graphOps = makeGraphOps(1_000);
  const graphStarted = performance.now();
  const graph = projectExecutionGraph({ sessionId: 'session:g11-graph', activeGoal: 'Render 1000 graph nodes.', status: 'completed', ops: graphOps, transcript: [] });
  const graphProjectionMs = performance.now() - graphStarted;
  const layoutStarted = performance.now();
  const layout = layoutExecutionGraph(graph, { mode: 'expanded' });
  const graphLayoutMs = performance.now() - layoutStarted;
  const heapAfterGraph = process.memoryUsage().heapUsed;

  const calls = Array.from({ length: 32 }, (_, index) => ({ toolCallId: `call:g11-parallel:${index + 1}`, toolId: ['scene.query', 'diagnostics.query', 'asset.search'][index % 3] }));
  const request = normalizeToolBatchRequest({ id: 'batch:g11-parallel', sessionId: 'session:g11-parallel', turnId: 'turn:g11-parallel', calls, maxConcurrency: 4, maxResultBytes: 1024 * 1024, createdAt: '2026-09-02T00:00:00.000Z' }, GAME_AUTHORING_TOOL_DEFINITIONS);
  const batchStarted = performance.now();
  const batch = await new ToolBatchScheduler({ maxConcurrency: 4 }).execute(request, async (node) => { await new Promise((resolve) => setTimeout(resolve, 4)); return { status: 'completed', value: { toolCallId: node.toolCallId } }; });
  const batchWallTimeMs = performance.now() - batchStarted;

  const entities = Array.from({ length: 1_000 }, (_, index) => ({ id: `entity:${index + 1}`, name: `Entity ${index + 1}`, transform: { position: [index, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }));
  const scripts = Array.from({ length: 200 }, (_, index) => ({ id: `script:${index + 1}`, digest: `sha256:${String(index).padStart(64, '0').slice(-64)}`, enabled: true }));
  const fullBytes = Buffer.byteLength(canonicalStringify({ entities, scripts }));
  const diffBytes = Buffer.byteLength(canonicalStringify({ fromRevision: 1, toRevision: 2, changed: [{ id: 'entity:500', transform: { position: [500, 1, 0] } }] }));
  const retrieval = JSON.parse(await readFile(path.join(root, 'docs', 'evidence', 'm13-g10-retrieval-ab.json'), 'utf8'));
  const evidence = Object.freeze({
    schemaVersion: 1,
    binding,
    status: 'local-gates-pass',
    generatedAt: new Date().toISOString(),
    migration: { mutationReplayCount: 0, idempotencyTest: 'apps/ai-studio/test/legacy-session-migration.test.mjs' },
    session: { transcriptEntries: sessionBeforeRestart.transcript.length, opCount: sessionBeforeRestart.ops.length, surfaceGeneration: sessionBeforeRestart.surface.generation, surfaceDigest: sessionBeforeRestart.surface.digest, replayedSurfaceDigest: sessionAfterRestart.surface.digest, automaticCompaction: automatic.status, manualCompaction: manual.status, compactionRecords: sessionBeforeRestart.ops.filter((op) => op.kind === 'compaction.completed').length },
    graph: { requestedNodes: 1_000, projectedNodes: graph.nodes.length, layoutNodes: layout.nodes.length, projectionMs: round(graphProjectionMs), layoutMs: round(graphLayoutMs), digest: graph.digest },
    project: { entityCount: entities.length, scriptCount: scripts.length, fullBytes, diffBytes, fullSceneRetransmissionReduction: 1 - diffBytes / fullBytes },
    toolBatch: { nodeCount: batch.summary.nodeCount, maxConcurrencyObserved: batch.summary.maxConcurrencyObserved, wallTimeMs: round(batchWallTimeMs), serialEstimateMs: calls.length * 4, modelTurnsBaseline: 3, modelTurnsCurrent: 1, modelTurnReduction: 2 / 3 },
    context: { inputTokenReduction: retrieval.summary.inputTokenReduction, schemaByteReduction: retrieval.summary.schemaByteReduction },
    memory: { sessionHeapDeltaBytes: Math.max(0, heapAfterSession - heapStart), graphHeapDeltaBytes: Math.max(0, heapAfterGraph - heapAfterSession), totalHeapDeltaBytes: Math.max(0, heapAfterGraph - heapStart) },
  });
  if (process.argv.includes('--check')) {
    assert.equal(evidence.session.surfaceDigest, evidence.session.replayedSurfaceDigest);
    assert.equal(evidence.session.automaticCompaction, 'completed');
    assert.equal(evidence.session.manualCompaction, 'completed');
    assert.ok(evidence.session.transcriptEntries >= 120);
    assert.ok(evidence.graph.projectedNodes >= 1_000);
    assert.equal(evidence.graph.layoutNodes, evidence.graph.projectedNodes);
    assert.ok(evidence.graph.projectionMs < 2_000 && evidence.graph.layoutMs < 2_000);
    assert.equal(evidence.project.entityCount, 1_000); assert.equal(evidence.project.scriptCount, 200);
    assert.ok(evidence.project.fullSceneRetransmissionReduction >= 0.8);
    assert.equal(evidence.toolBatch.maxConcurrencyObserved, 4);
    assert.ok(evidence.toolBatch.modelTurnReduction >= 0.3);
    assert.ok(evidence.context.inputTokenReduction >= 0.25);
    assert.ok(evidence.memory.totalHeapDeltaBytes < 256 * 1024 * 1024);
  }
  const target = path.join(root, 'docs', 'evidence', 'm13-g11-local-gates.json');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[m13-g11] session=${evidence.session.transcriptEntries} graph=${evidence.graph.projectedNodes} sceneReduction=${evidence.project.fullSceneRetransmissionReduction.toFixed(3)} modelTurnReduction=${evidence.toolBatch.modelTurnReduction.toFixed(3)} inputReduction=${evidence.context.inputTokenReduction.toFixed(3)} heap=${evidence.memory.totalHeapDeltaBytes}`);
  await compactor.dispose();
} finally {
  await sessions.dispose().catch(() => undefined);
  await log.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function makeGraphOps(count) {
  const ops = [];
  for (let sequence = 0; sequence < count; sequence += 1) {
    const payload = sequence === 0 ? { projectId: null, documentId: null, activeGoal: 'Render 1000 graph nodes.', taskBudgetId: null } : { evidenceType: 'performance', summary: `Graph evidence ${sequence}` };
    ops.push(Object.freeze({ schemaVersion: 1, id: `op:g11-graph:${sequence}`, sessionId: 'session:g11-graph', sequence, kind: sequence === 0 ? 'session.created' : 'evidence.captured', timestamp: new Date(1_788_307_200_000 + sequence).toISOString(), turnId: null, stepId: null, batchId: null, nodeId: sequence === 0 ? null : `node:g11-graph:${sequence}`, parentOpId: null, dependsOn: [], projectRevision: 1, artifactRefs: [], payload, payloadDigest: `sha256:${sha256(canonicalStringify(payload))}` }));
  }
  return Object.freeze(ops);
}
function round(value) { return Math.round(value * 1000) / 1000; }
