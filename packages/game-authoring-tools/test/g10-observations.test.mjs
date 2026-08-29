import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { BoundedPlaytestTask, DeterministicTaskEvaluator, PlayObservationRepository } from '../dist/index.js';

const digest = `sha256:${'a'.repeat(64)}`;
const call = Object.freeze({ schemaVersion: 1, id: asStableId('call:g10'), sessionId: asStableId('session:g10'), turnId: asStableId('turn:g10'), taskId: asStableId('task:g10'), toolId: asStableId('play.inspect'), toolVersion: '1.0.0', arguments: Object.freeze({}) });

test('G10 persists bounded state and PNG observations before returning references', async (t) => {
  const fixture = await createFixture(t);
  const state = await fixture.repository.persistState(call, observation({ state: { score: 4 } }));
  assert.match(state.artifact.id, /^artifact:sha256:/);
  assert.equal(state.artifact.taskId, call.taskId);
  assert.deepEqual(state.projection, { state: { score: 4 } });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const capture = await fixture.repository.persistCapture(call, { ...observation({}), mediaType: 'image/png', byteLength: png.length, base64: png.toString('base64') });
  assert.deepEqual(capture.projection, { mediaType: 'image/png', byteLength: 8 });
  assert.equal('base64' in capture.projection, false);
  const stored = await fixture.log.readArtifact(capture.artifact.id);
  assert.equal(stored.value.payload.base64, png.toString('base64'));
});

test('G10 rejects oversized, missing, stale and mixed-provenance evidence fail closed', async (t) => {
  const fixture = await createFixture(t);
  const tooLarge = { ...observation({}), mediaType: 'image/png', byteLength: 376 * 1024 + 1, base64: '' };
  await assert.rejects(fixture.repository.persistCapture(call, tooLarge), hasCode('observation.screenshot-too-large'));
  await assert.rejects(fixture.repository.read(asStableId(`artifact:sha256:${'f'.repeat(64)}`)), hasCode('observation.missing'));

  const current = await fixture.repository.persistState(call, observation({ score: 1 }));
  const foreignCall = { ...call, taskId: asStableId('task:foreign'), turnId: asStableId('turn:foreign') };
  const foreign = await fixture.repository.persistState(foreignCall, observation({ score: 1 }));
  const evaluator = new DeterministicTaskEvaluator(fixture.repository, () => 7);
  const mixed = await evaluator.evaluate(evaluationInput(taskSpec([{ id: 'acceptance:score', category: 'functional', assertion: 'evidence state signal score equals 1' }]), [current.artifact.id, foreign.artifact.id]));
  assert.equal(mixed.status, 'blocked');
  assert.equal(mixed.acceptanceResults[0].diagnostic, 'evaluation.evidence-task-mismatch');

  const wrongViewport = await fixture.repository.persistState(call, { ...observation({ score: 1 }), viewport: { width: 1280, height: 720 }, device: 'desktop' }, 'event-trace');
  const provenance = await evaluator.evaluate(evaluationInput(taskSpec([
    { id: 'acceptance:score', category: 'functional', assertion: 'evidence state signal score equals 1' },
    { id: 'acceptance:trace', category: 'functional', assertion: 'evidence event-trace' },
  ]), [current.artifact.id, wrongViewport.artifact.id]));
  assert.equal(provenance.status, 'blocked');
  assert.equal(provenance.acceptanceResults[0].diagnostic, 'evaluation.evidence-provenance-mismatch');

  const staleEvaluator = new DeterministicTaskEvaluator(fixture.repository, () => 8);
  const stale = await staleEvaluator.evaluate(evaluationInput(taskSpec([{ id: 'acceptance:score', category: 'functional', assertion: 'evidence state signal score equals 1' }]), [current.artifact.id]));
  assert.equal(stale.status, 'blocked');
  assert.equal(stale.acceptanceResults[0].diagnostic, 'evaluation.evidence-stale-revision');
});

test('G10 deterministic evaluator fails seeded compile/runtime/physics/interaction/visual defects then passes fresh evidence', async (t) => {
  const fixture = await createFixture(t);
  const evaluator = new DeterministicTaskEvaluator(fixture.repository, () => 7);
  const task = taskSpec([
    { id: 'acceptance:compile', category: 'functional', assertion: 'evidence runtime-errors signal compileErrors equals 0' },
    { id: 'acceptance:runtime', category: 'functional', assertion: 'evidence runtime-errors signal runtimeErrors equals 0' },
    { id: 'acceptance:physics', category: 'functional', assertion: 'evidence state signal physicsGrounded equals true' },
    { id: 'acceptance:interaction', category: 'functional', assertion: 'evidence event-trace signal clickObserved equals true' },
    { id: 'acceptance:visual', category: 'visual', assertion: 'evidence visual-analysis signal hudReadable equals true' },
  ]);
  const bad = await persistSet(fixture.repository, 10, { compileErrors: 1, runtimeErrors: 1, physicsGrounded: false, clickObserved: false, hudReadable: false });
  const failed = await evaluator.evaluate(evaluationInput(task, bad));
  assert.equal(failed.status, 'fail');
  assert.equal(failed.acceptanceResults.filter((item) => item.status === 'fail').length, 5);
  const good = await persistSet(fixture.repository, 20, { compileErrors: 0, runtimeErrors: 0, physicsGrounded: true, clickObserved: true, hudReadable: true });
  const passed = await evaluator.evaluate(evaluationInput(task, good));
  assert.equal(passed.status, 'pass');
  assert.ok(passed.acceptanceResults.every((item) => item.evidenceIds.length === 1));
});

test('G10 screenshot presence cannot satisfy a semantic visual assertion without verifier analysis', async (t) => {
  const fixture = await createFixture(t);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const capture = await fixture.repository.persistCapture(call, { ...observation({}, 30), mediaType: 'image/png', byteLength: png.length, base64: png.toString('base64') });
  const evaluator = new DeterministicTaskEvaluator(fixture.repository, () => 7);
  const result = await evaluator.evaluate(evaluationInput(taskSpec([{ id: 'acceptance:visual', category: 'visual', assertion: 'evidence screenshot signal hudReadable equals true' }]), [capture.artifact.id]));
  assert.equal(result.status, 'blocked');
  assert.equal(result.acceptanceResults[0].diagnostic, 'evaluation.visual-verifier-required');
});

test('G10 screenshot projection hides secret bytes, CAS tamper fails closed and quota isolates tasks', async (t) => {
  const fixture = await createFixture(t);
  const secret = 'G10_SECRET_CANARY_DO_NOT_EXPOSE';
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(secret)]);
  const capture = await fixture.repository.persistCapture(call, { ...observation({}, 40), mediaType: 'image/png', byteLength: png.length, base64: png.toString('base64') });
  assert.doesNotMatch(JSON.stringify(capture.projection), new RegExp(secret));
  const events = await fixture.log.query({ limit: 20, traverseCorrelation: false });
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));

  const digestValue = capture.artifact.id.slice('artifact:sha256:'.length);
  const artifactPath = path.join(fixture.root, 'artifacts', 'sha256', `${digestValue}.json`);
  const record = JSON.parse(await readFile(artifactPath, 'utf8'));
  record.value.payload.byteLength += 1;
  await writeFile(artifactPath, JSON.stringify(record));
  await assert.rejects(fixture.repository.read(capture.artifact.id), hasCode('observation.integrity-failed'));

  const limited = new PlayObservationRepository(fixture.log, 900);
  await limited.persistState(call, observation({ value: 'first' }, 50));
  await assert.rejects(limited.persistState(call, observation({ value: 'second-and-different' }, 51)), hasCode('observation.quota-exceeded'));
  const otherTask = { ...call, taskId: asStableId('task:g10-other') };
  const isolated = await limited.persistState(otherTask, observation({ value: 'other-task' }, 52));
  assert.equal(isolated.artifact.taskId, otherTask.taskId);
});

test('G10 repair state machine requires failed evidence, stops no-change repeats and completes only with cited evidence', () => {
  const task = taskSpec([{ id: 'acceptance:score', category: 'functional', assertion: 'evidence state signal score equals 1' }]);
  const evidenceId = asStableId(`artifact:sha256:${'b'.repeat(64)}`);
  const failed = evaluation(task, 'fail', evidenceId);
  const guarded = new BoundedPlaytestTask(task, 2);
  guarded.advance('editing'); guarded.advance('validating'); guarded.advance('playing'); guarded.advance('evaluating'); guarded.recordEvaluation(failed);
  guarded.beginRepair({ turnId: asStableId('turn:repair-1'), arguments: { patch: 1 }, evidenceIds: [evidenceId] });
  guarded.advance('editing'); guarded.advance('validating'); guarded.advance('playing'); guarded.advance('evaluating'); guarded.recordEvaluation(failed);
  const repeated = guarded.beginRepair({ turnId: asStableId('turn:repair-2'), arguments: { patch: 1 }, evidenceIds: [evidenceId] });
  assert.equal(repeated.phase, 'blocked');
  assert.equal(repeated.diagnostic, 'task.repair-no-change-repeat');
  assert.deepEqual(repeated.terminalEvidenceIds, [evidenceId]);

  const completed = new BoundedPlaytestTask(task, 1);
  completed.advance('editing'); completed.advance('validating'); completed.advance('playing'); completed.advance('evaluating');
  const snapshot = completed.recordEvaluation(evaluation(task, 'pass', evidenceId));
  assert.equal(snapshot.phase, 'complete');
  assert.deepEqual(snapshot.completionEvidenceIds, [evidenceId]);
  assert.deepEqual(snapshot.terminalEvidenceIds, [evidenceId]);

  for (const diagnostic of ['task.renderer-crash', 'task.device-lost', 'task.budget-exhausted']) {
    const interrupted = new BoundedPlaytestTask(task, 1);
    interrupted.advance('editing');
    const terminal = interrupted.block(diagnostic, [evidenceId]);
    assert.equal(terminal.phase, 'blocked'); assert.equal(terminal.diagnostic, diagnostic); assert.deepEqual(terminal.terminalEvidenceIds, [evidenceId]);
  }
  const cancelled = new BoundedPlaytestTask(task, 1).cancel([evidenceId]);
  assert.equal(cancelled.phase, 'cancelled'); assert.deepEqual(cancelled.terminalEvidenceIds, [evidenceId]);
});

async function persistSet(repository, tick, values) {
  const base = observation({}, tick);
  const runtime = await repository.persistState(call, { ...base, value: { compileErrors: values.compileErrors, runtimeErrors: values.runtimeErrors } }, 'runtime-errors');
  const state = await repository.persistState(call, { ...base, value: { physicsGrounded: values.physicsGrounded } }, 'state');
  const interaction = await repository.persistState(call, { ...base, value: { clickObserved: values.clickObserved } }, 'event-trace');
  const visual = await repository.persistAnalysis(call, { ...base, value: {} }, { hudReadable: values.hudReadable });
  return [runtime.artifact.id, state.artifact.id, interaction.artifact.id, visual.artifact.id];
}

function observation(value, tick = 10) { return Object.freeze({ playId: asStableId('preview:g10'), documentRevision: 7, scriptDigests: Object.freeze([digest]), tick, frame: tick, viewport: Object.freeze({ width: 393, height: 852 }), device: 'iphone-15', capturedAt: new Date(1_700_000_000_000 + tick).toISOString(), value: Object.freeze(value) }); }
function taskSpec(entries) { return Object.freeze({ schemaVersion: 2, id: asStableId('task:g10'), request: 'Verify game', visibleConstraints: Object.freeze([]), budgetId: asStableId('budget:g10'), requiredCapabilities: Object.freeze([asStableId('play.inspect')]), acceptance: Object.freeze(entries.map((item) => Object.freeze({ ...item, id: asStableId(item.id), required: true, visibility: 'agent' }))) }); }
function evaluationInput(taskSpecValue, observationIds) { return Object.freeze({ taskSpec: taskSpecValue, observationIds, budgetStatus: 'within', usageRecordIds: [], costRecordIds: [] }); }
function evaluation(task, status, evidenceId) { return Object.freeze({ schemaVersion: 2, id: asStableId(`evaluation:${status}`), taskId: task.id, evaluatorVersion: 'fixture', status, acceptanceResults: Object.freeze([{ acceptanceId: task.acceptance[0].id, status, evidenceIds: Object.freeze([evidenceId]), diagnostic: status === 'pass' ? null : 'seeded' }]), budgetStatus: 'within', usageRecordIds: Object.freeze([]), costRecordIds: Object.freeze([]), turns: Object.freeze([]), tools: Object.freeze([]), completedAt: new Date().toISOString() }); }
function hasCode(code) { return (cause) => cause?.code === code; }
async function createFixture(t) { const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g10-')); t.after(() => rm(root, { recursive: true, force: true })); const log = await OperationLog.open({ rootDirectory: root, appVersion: 'test', maxArtifactBytes: 512 * 1024 }); t.after(() => log.close()); return { root, log, repository: new PlayObservationRepository(log) }; }
