import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_TOOL_DEFINITION, validatePlanProposal } from '../dist/plan-policy.js';
import { isSupportedEvidenceAssertion } from '@haiyue/ai-studio-game-authoring-tools';

const proposal = assertion => ({ title: 'Interaction plan', summary: 'Observe a state change after an input.', items: [{ label: 'Observe state', details: 'Produce state evidence with a score signal after input.' }], acceptance: [{ label: 'Input updates score', required: true, category: 'functional', assertion }] });

test('plan schema explains executable assertions and the difference between evidence presence and correctness', () => {
  const schema = PLAN_TOOL_DEFINITION.inputSchema.properties.acceptance.items.properties.assertion;
  assert.match(schema.description, /JSON value/);
  assert.match(schema.description, /Signal paths must match the observation payload/);
  assert.match(schema.description, /presence only, not correctness/);
  for (const example of ['evidence runtime-errors signal count equals 0', 'evidence state signal score gte 1', 'evidence state signal phase equals "ready"']) {
    assert.ok(schema.description.includes(example));
    assert.match(example, new RegExp(schema.pattern, 'u'));
    assert.equal(isSupportedEvidenceAssertion(example), true);
    assert.equal(validatePlanProposal(proposal(example)).acceptance[0].assertion, example);
  }
});

test('invalid assertions identify the field and teach correction without removing acceptance requirements', () => {
  for (const assertion of ['操作后分数增加到 1。', 'After input, observed score equals 1.', 'evidence state signal phase equals ready', `evidence state signal ${'a'.repeat(161)} equals 1`]) {
    assert.throws(() => validatePlanProposal(proposal(assertion)), error => {
      assert.equal(error.code, 'plan.payload-invalid');
      assert.match(error.message, /acceptance\[0\]\.assertion/);
      assert.match(error.message, /evidence <type>.*<JSON value>/);
      assert.match(error.message, /do not omit criteria/);
      return true;
    });
  }
});

test('plan validation preserves corrected requirements and still rejects invalid criterion metadata', () => {
  const input = proposal('evidence state signal score equals 1');
  assert.deepEqual(validatePlanProposal(input).acceptance, input.acceptance);
  for (const replacement of [{ required: 'true' }, { category: 'unknown' }, { label: '' }, { extra: true }]) {
    assert.throws(() => validatePlanProposal({ ...input, acceptance: [{ ...input.acceptance[0], ...replacement }] }), /acceptance\[0\] requires/);
  }
  const { acceptance, ...legacy } = input;
  assert.deepEqual(validatePlanProposal(legacy).acceptance, []);
});
