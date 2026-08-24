import assert from 'node:assert/strict';
import test from 'node:test';
import { deepClone } from '../src/canonical.mjs';
import {
  loadEvaluationAssets,
  validateEvaluationSuiteSchema,
  verifySuiteRelationships,
} from '../src/index.mjs';

const assets = await loadEvaluationAssets();

test('suite covers seven genres with variants, budgets, declared capabilities and corroborated screenshots', () => {
  assert.deepEqual(assets.suite.cases.map((entry) => entry.genre).sort(), [
    'falling-blocks', 'jigsaw', 'match-3', 'platformer', 'racing', 'shooter', 'snake',
  ]);
  for (const testCase of assets.suite.cases) {
    assert.ok(testCase.requestVariants.length >= 2, testCase.id);
    assert.ok(testCase.failureSeeds.length >= 2, testCase.id);
    assert.equal(testCase.inputReplay.driver, 'fixed', testCase.id);
    for (const acceptance of testCase.acceptance.visual) {
      assert.ok(acceptance.evidence.includes('screenshot'), acceptance.id);
      assert.ok(acceptance.evidence.some((type) => type === 'state' || type === 'event-trace'), acceptance.id);
    }
  }
  assert.ok(assets.suite.sharedBudgets.maxAgentTurns > 0);
  assert.ok(assets.suite.sharedBudgets.maxToolCalls > 0);
});

test('schema rejects invalid budgets', () => {
  const suite = deepClone(assets.suite);
  suite.sharedBudgets.maxAgentTurns = 0;
  assert.throws(
    () => validateEvaluationSuiteSchema({ suite, schema: assets.schema }),
    (error) => error.code === 'eval.suite-schema-invalid',
  );
});

test('relationship validator rejects unknown capabilities, duplicate IDs and unordered ticks', () => {
  const args = () => ({ oracle: assets.oracle, referenceEvidence: assets.referenceEvidence, capabilityIds: assets.capabilityIds });

  const unknownCapability = deepClone(assets.suite);
  unknownCapability.cases[0].requiredCapabilities.push('engine.unknown');
  assert.throws(() => verifySuiteRelationships({ suite: unknownCapability, ...args() }), (error) => error.code === 'eval.capability-unknown');

  const duplicateId = deepClone(assets.suite);
  duplicateId.cases[1].id = duplicateId.cases[0].id;
  assert.throws(() => verifySuiteRelationships({ suite: duplicateId, ...args() }), (error) => error.code === 'eval.id-duplicate');

  const unorderedTicks = deepClone(assets.suite);
  unorderedTicks.cases[0].inputReplay.steps[1].at = 'tick:200';
  unorderedTicks.cases[0].inputReplay.steps[2].at = 'tick:100';
  assert.throws(() => verifySuiteRelationships({ suite: unorderedTicks, ...args() }), (error) => error.code === 'eval.replay-tick-order-invalid');
});
