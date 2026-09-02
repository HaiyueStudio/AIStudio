import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const evidence = JSON.parse(await read('docs/evidence/m13-g11-local-gates.json'));
assert.equal(evidence.binding, 'm13-g11-2026-09-02');
assert.equal(evidence.status, 'local-gates-pass');
assert.equal(evidence.migration.mutationReplayCount, 0);
assert.equal(evidence.session.surfaceDigest, evidence.session.replayedSurfaceDigest);
assert.equal(evidence.session.automaticCompaction, 'completed');
assert.equal(evidence.session.manualCompaction, 'completed');
assert.ok(evidence.session.transcriptEntries >= 120);
assert.ok(evidence.graph.projectedNodes >= 1_000 && evidence.graph.layoutNodes >= 1_000);
assert.ok(evidence.project.entityCount >= 1_000 && evidence.project.scriptCount >= 200);
assert.ok(evidence.project.fullSceneRetransmissionReduction >= 0.8);
assert.ok(evidence.toolBatch.modelTurnReduction >= 0.3);
assert.ok(evidence.context.inputTokenReduction >= 0.25);
assert.ok(evidence.memory.totalHeapDeltaBytes < 256 * 1024 * 1024);

const migration = await read('apps/ai-studio/src/legacy-session-migration.ts');
for (const phrase of ['legacy-migration-started', 'legacy-migration-completed', 'mutationReplayCount: 0', 'already-durable']) assert.match(migration, new RegExp(phrase, 'u'));
const host = await read('apps/ai-studio/src/conversation-host.ts');
assert.match(host, /restoreTaskRuns\(\); await this\.migrateLegacySessions\(\);/u);
assert.match(host, /Claim the launch slot before the first asynchronous context read/u);
const runner = await read('scripts/g12/real-cold-case-electron.mjs');
for (const phrase of ['recordM13Turn', 'DurableSessionRuntime', 'ModelContextRuntime', 'projectExecutionGraph', 'tool.outcome-unknown', 'replayedSurfaceDigest', 'replayedDigest', 'budgetContinuations', 'user-authorized-formal-matrix', 'budget.formal-cap']) assert.match(runner, new RegExp(phrase.replaceAll('.', '\\.'), 'u'));

const formalArgument = process.argv.find((entry) => entry.startsWith('--formal-checkpoint='));
if (formalArgument) {
  const checkpointPath = path.resolve(formalArgument.slice('--formal-checkpoint='.length));
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  assert.equal(checkpoint.evidenceClass, 'formal');
  assert.equal(checkpoint.results.length, 14);
  assert.equal(new Set(checkpoint.results.map((entry) => `${entry.backend}/${entry.genre}`)).size, 14);
  for (const entry of checkpoint.results) {
    assert.equal(entry.status, 'pass', `${entry.backend}/${entry.genre} did not pass`);
    const report = JSON.parse(await readFile(path.join(entry.caseRoot, 'task-report.json'), 'utf8'));
    assert.ok(report.usageRecords.length > 0, `${entry.backend}/${entry.genre} missing usage`);
    assert.ok(report.costRecords.length > 0, `${entry.backend}/${entry.genre} missing cost`);
    assert.ok(report.cache !== undefined, `${entry.backend}/${entry.genre} missing cache provenance`);
    assert.ok(report.evidenceManifest?.artifacts?.some((artifact) => artifact.type === 'state'), `${entry.backend}/${entry.genre} missing state`);
    assert.ok(report.evidenceManifest?.artifacts?.some((artifact) => artifact.type === 'screenshot'), `${entry.backend}/${entry.genre} missing screenshot`);
    assert.equal(report.evaluation?.status, 'pass', `${entry.backend}/${entry.genre} missing evaluator pass`);
    assert.ok(report.m13?.turns?.length > 0, `${entry.backend}/${entry.genre} missing M13 turns`);
    assert.equal(report.m13.replayVerified, true, `${entry.backend}/${entry.genre} replay digest drift`);
    assert.ok(report.m13.turns.some((turn) => turn.session?.artifactId), `${entry.backend}/${entry.genre} missing Session evidence`);
    assert.ok(report.m13.turns.some((turn) => turn.contextFrame?.artifactId), `${entry.backend}/${entry.genre} missing ContextFrame evidence`);
    assert.ok(report.m13.turns.some((turn) => turn.toolBatch?.artifactId), `${entry.backend}/${entry.genre} missing Tool Batch evidence`);
    assert.ok(report.m13.turns.some((turn) => turn.graph?.artifactId), `${entry.backend}/${entry.genre} missing Graph evidence`);
  }
  console.log(`[m13-g11-formal] matrix=${checkpoint.matrixId} cases=14 replay=14/14 evidence=14/14`);
} else console.log(`[m13-g11] local=pass migration=idempotent session=${evidence.session.transcriptEntries} graph=${evidence.graph.projectedNodes} sceneReduction=${evidence.project.fullSceneRetransmissionReduction.toFixed(3)}`);
