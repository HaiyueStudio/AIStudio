import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EvaluationRunner,
  createBlankFixtureAdapter,
  createReferenceFixtureAdapter,
  encodeEvaluationReport,
  loadEvaluationAssets,
  normalizeReplay,
} from '../src/index.mjs';

const assets = await loadEvaluationAssets();
const referenceRunner = () => new EvaluationRunner({
  assets,
  adapterFactory: () => createReferenceFixtureAdapter(assets.referenceEvidence),
});

test('enumeration is stable across three modes and all request variants', () => {
  const tasks = referenceRunner().enumerate();
  assert.equal(tasks.length, 56);
  assert.deepEqual(tasks, referenceRunner().enumerate());
  assert.equal(tasks.filter((entry) => entry.mode === 'seeded-defect').length, 14);
  assert.equal(tasks.filter((entry) => entry.mode === 'cold-create').length, 21);
  assert.equal(tasks.filter((entry) => entry.mode === 'warm-repair').length, 21);
});

test('reference fixture passes all cases and blank implementation fails all cases', async () => {
  const reference = await referenceRunner().runSuite();
  const blank = await new EvaluationRunner({ assets, adapterFactory: () => createBlankFixtureAdapter() }).runSuite();
  assert.deepEqual(reference.summary, { total: 7, passed: 7, failed: 0 });
  assert.deepEqual(blank.summary, { total: 7, passed: 0, failed: 7 });
  assert.ok(blank.runs.every((run) => run.acceptanceResults.every((result) => result.status === 'fail')));
  assert.ok(reference.runs.every((run) => run.accounting.taskId && run.accounting.budgetId && run.accounting.budgetStatus === 'within'));
  assert.ok(reference.runs.every((run) => run.accounting.turns.length === run.execution.turns && run.accounting.turns.every((turn) => turn.usageRecordIds.length > 0)));
  assert.ok(reference.runs.every((run) => run.accounting.tools.length === run.execution.toolCalls && run.accounting.tools.every((tool) => tool.usageRecordIds.length > 0)));
});

test('every seeded defect fails exactly its declared stable acceptance IDs', async () => {
  const runner = referenceRunner();
  for (const task of runner.enumerate({ modes: ['seeded-defect'], includeVariants: false })) {
    const result = await runner.runCase(task);
    const testCase = assets.suite.cases.find((entry) => entry.id === task.caseId);
    const seed = testCase.failureSeeds.find((entry) => entry.id === task.failureSeedId);
    const failed = result.acceptanceResults.filter((entry) => entry.status === 'fail').map((entry) => entry.acceptanceId).sort();
    assert.deepEqual(failed, [...seed.expectedFailedAcceptanceIds].sort(), task.failureSeedId);
  }
});

test('runner resets to a deterministic blank document and emits canonical deterministic reports', async () => {
  const adapters = [];
  const runner = new EvaluationRunner({
    assets,
    adapterFactory: () => {
      const adapter = createReferenceFixtureAdapter(assets.referenceEvidence);
      adapters.push(adapter);
      return adapter;
    },
  });
  const first = await runner.runSuite();
  const second = await runner.runSuite();
  assert.equal(encodeEvaluationReport(first), encodeEvaluationReport(second));
  assert.equal(adapters.length, 14);
  for (const adapter of adapters) {
    assert.equal(adapter.resets.length, 1);
    const blank = adapter.resets[0].document;
    assert.equal(blank.revision, 0);
    assert.deepEqual(blank.entities, []);
    assert.deepEqual(blank.components, []);
    assert.deepEqual(blank.scripts, []);
    assert.deepEqual(blank.assets, []);
  }
});

test('replay schedules use fixed ticks or named triggers without wall-clock sleeps', () => {
  for (const testCase of assets.suite.cases) {
    const replay = normalizeReplay(testCase.inputReplay);
    assert.equal(replay.clock, 'fixed-tick');
    assert.ok(replay.steps.every((step) => ['tick', 'trigger'].includes(step.schedule.kind)));
    assert.ok(replay.steps.every((step) => !Object.hasOwn(step, 'delayMs')));
    assert.deepEqual(
      replay.steps.map((step) => step.parameters ?? null),
      testCase.inputReplay.steps.map((step) => step.parameters ?? null),
    );
  }
});
