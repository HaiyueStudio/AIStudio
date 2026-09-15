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
  for (const example of ['evidence runtime-errors signal count equals 0', 'evidence state signal gameplay.0.value.metrics.score gte 1', 'evidence state signal gameplay.0.value.phase equals "ready"']) {
    assert.ok(schema.description.includes(example));
    assert.match(example, new RegExp(schema.anyOf.find(branch => branch.type === 'string').pattern, 'u'));
    assert.equal(isSupportedEvidenceAssertion(example), true);
    assert.equal(validatePlanProposal(proposal(example)).acceptance[0].assertion, example);
  }
});

test('invalid assertions identify the field and teach correction without removing acceptance requirements', () => {
  for (const assertion of ['操作后分数增加到 1。', 'After input, observed score equals 1.', 'evidence state signal phase equals ready', `evidence state signal ${'a'.repeat(161)} equals 1`]) {
    assert.throws(() => validatePlanProposal(proposal(assertion)), error => {
      assert.equal(error.code, 'plan.payload-invalid');
      assert.match(error.message, /acceptance\[0\]\.assertion/);
      assert.match(error.message, /structured.*(?:object|assertion)|complete corrected plan/);
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

 test('plans reject evidence with no production producer before user approval', () => {
  for (const assertion of ['evidence visual-analysis signal visible equals true', 'evidence performance signal fps gte 30']) {
    assert.throws(() => validatePlanProposal(proposal(assertion)), error => error.code === 'plan.evidence-producer-unavailable');
  }
  assert.doesNotThrow(() => validatePlanProposal(proposal('evidence performance signal finite equals true')));
});

test('semicolon-separated conditions from the reported cube plan become separate executable checks', () => {
  const conditions = ['evidence state signal gameplay.0.value.status.phase equals "ready"', 'evidence state signal gameplay.0.value.metrics.cubieCount equals 27', 'evidence state signal gameplay.0.value.metrics.roundedCubieCount equals 27', 'evidence state signal gameplay.0.value.metrics.pbrPartCount gte 27'];
  const input = proposal(conditions.join('; ')); const before = JSON.stringify(input);
  const plan = validatePlanProposal(input);
  assert.deepEqual(plan.acceptance.map(item => item.assertion), conditions);
  assert.ok(plan.acceptance.every(item => item.required && item.category === 'functional'));
  assert.deepEqual(plan.acceptance.map(item => item.label), conditions.map((_, i) => `Input updates score（${i + 1}/4）`));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(validatePlanProposal({ ...input, acceptance: plan.acceptance }).acceptance, plan.acceptance, 'canonical plans are stable on replay');
});

test('compound parsing preserves semicolons inside JSON strings and nested values', () => {
  const first = `evidence state signal message equals ${JSON.stringify('ready; "go"；end\\path')}`;
  const second = `evidence state signal object equals ${JSON.stringify({ label: 'a;b', nested: ['c;d'] })}`;
  const third = 'evidence runtime-errors signal count equals 0';
  const input = proposal(`${first}； ${second}; ${third}`); input.acceptance[0].required = false;
  assert.deepEqual(validatePlanProposal(input).acceptance.map(item => item.assertion), [first, second, third]);
  assert.ok(validatePlanProposal(input).acceptance.every(item => item.required === false));
});

test('compound validation rejects an invalid member without silently dropping requirements', () => {
  for (const bad of ['unparseable prose', '', 'evidence state signal phase equals ready']) {
    assert.throws(() => validatePlanProposal(proposal(`evidence state; ${bad}; evidence runtime-errors signal count equals 0`)), error => error.code === 'plan.payload-invalid' && /条件 2\/3/.test(error.message) && error.message.length < 700);
  }
  assert.throws(() => validatePlanProposal(proposal('evidence state; evidence visual-analysis')), error => error.code === 'plan.evidence-producer-unavailable' && /条件 2/.test(error.message));
  const input = proposal('evidence state; evidence screenshot'); input.acceptance = Array.from({ length: 26 }, () => input.acceptance[0]);
  assert.throws(() => validatePlanProposal(input), /expands to 52/);
  assert.throws(() => validatePlanProposal(proposal('x'.repeat(2001))), /up to 2000 characters/);
});

test('approved assembly requirements are structured and retained across plan serialization', async () => {
  const { canonicalPlan } = await import('../dist/plan-policy.js');
  const assemblies = [{assemblyId:'cabinet',label:'Cabinet panels',partKeys:['body','front','back'],distinctColors:3,minimumInstances:4}];
  const result = validatePlanProposal({...proposal('evidence state'),assemblies});
  assert.deepEqual(result.assemblies,assemblies);
  assert.deepEqual(JSON.parse(canonicalPlan({...result,attempts:0,mutationCount:0})).assemblies,assemblies);
  assert.throws(() => validatePlanProposal({...proposal('evidence state'),assemblies:[...assemblies,...assemblies]}), /unique/);
  assert.throws(() => validatePlanProposal({...proposal('evidence state'),assemblies:[{...assemblies[0],minimumInstances:0}]}));
});

test('reject unavailable engine-owned evidence paths before approving a plan',()=>{
 for(const path of ['state.entities.0.geometry.kind','state.entities.0.material','state.entities.0.pointer.events','effects.colorChanged']){
  assert.throws(()=>validatePlanProposal(proposal(`evidence state signal ${path} equals true`)),e=>e.code==='plan.payload-invalid'&&e.message.includes(path));
 }
 assert.throws(()=>validatePlanProposal(proposal('evidence event-trace signal events.0.type equals "click"')),/interactions/);
 for(const assertion of ['evidence state signal effects.materialColorChanged equals true','evidence state signal effects.cameraChanged equals false','evidence state signal state.entities.0.materialColor equals [1,0,0,1]','evidence event-trace signal interactions.0.type equals "click"','evidence state signal gameplay.0.value.customState equals true']) assert.equal(validatePlanProposal(proposal(assertion)).acceptance[0].assertion,assertion);
});

test('event-trace gesture wrapper is normalized before approval without changing the requirement',()=>{
 const original='evidence event-trace signal gesture.interactions.0.type equals "click"';
 const input=proposal(original),result=validatePlanProposal(input);
 assert.equal(result.acceptance[0].assertion,'evidence event-trace signal interactions.0.type equals "click"');
 assert.equal(result.acceptance[0].required,true);assert.equal(result.acceptance[0].category,'functional');assert.equal(result.acceptance[0].label,input.acceptance[0].label);
 assert.equal(input.acceptance[0].assertion,original,'raw request remains unchanged');
 const state='evidence state signal gesture.interactions.3.entityId equals "entity:target"';
 assert.equal(validatePlanProposal(proposal(state)).acceptance[0].assertion,state);
 assert.throws(()=>validatePlanProposal(proposal('evidence event-trace signal gesture.effects.cameraChanged equals true')),/not an event-trace field/);
});


test('structured comparisons serialize deterministically before approval without altering expected JSON types',()=>{
 const schema=PLAN_TOOL_DEFINITION.inputSchema.properties.acceptance.items.properties.assertion.anyOf[0];
 assert.deepEqual(schema.required,['type','signal','operator','expected']);
 for(const expected of [false,0,null,'ready',[],{message:'a; b',nested:[1,true]}]){
  const assertion={type:'state',signal:'gameplay.0.value.result',operator:'equals',expected};
  const input=proposal(assertion),before=JSON.stringify(input),result=validatePlanProposal(input);
  assert.equal(result.acceptance[0].assertion,`evidence state signal gameplay.0.value.result equals ${JSON.stringify(expected)}`);
  assert.equal(JSON.stringify(input),before);assert.equal(result.acceptance[0].required,true);
 }
 for(const assertion of [{type:'state',signal:'effects.cameraChanged',operator:'equals'},{type:'state',signal:'effects.cameraChanged',expected:false},{type:'state',signal:'effects.cameraChanged',operator:'equals',expected:NaN},{type:['state'],signal:'effects.cameraChanged',operator:'equals',expected:false}]){
  assert.throws(()=>validatePlanProposal(proposal(assertion)),e=>e.code==='plan.payload-invalid');
 }
});

test('notation repair handles symbolic comparisons and trailing JSON commas without inventing missing values',()=>{
 for(const [input,expected] of [
  ['evidence state signal effects.cameraChanged == false','evidence state signal effects.cameraChanged equals false'],
  ['evidence state signal gameplay.0.value.data equals {\n  \"a\": [1,2]\n}', 'evidence state signal gameplay.0.value.data equals {\"a\":[1,2]}'],
  ['evidence state signal gameplay.0.value.count >= 9','evidence state signal gameplay.0.value.count gte 9'],
  ['evidence state signal gameplay.0.value.data equals {"members":[1,2,],"label":",]",}','evidence state signal gameplay.0.value.data equals {"members":[1,2],"label":",]"}'],
 ]) assert.equal(validatePlanProposal(proposal(input)).acceptance[0].assertion,expected);
 for(const tail of ['equals','equals [,]','equals [1,,]','equals ready','equals {"a":}','> 1']) assert.throws(()=>validatePlanProposal(proposal('evidence state signal gameplay.0.value.data '+tail)),e=>e.code==='plan.payload-invalid');
});

test('reported incomplete unchangedEntityIds predicate explains both semantic defects and remains correctable',()=>{
 const input=proposal('evidence state signal effects.unchangedEntityIds');
 input.acceptance=Array.from({length:5},(_,i)=>i===4?input.acceptance[0]:{...input.acceptance[0],assertion:'evidence runtime-errors signal count equals 0'});
 assert.throws(()=>validatePlanProposal(input),e=>e.code==='plan.payload-invalid' && /acceptance\[4\]/.test(e.message) && /Missing operator and expected value/.test(e.message) && /effects.unchangedEntityIds does not exist/.test(e.message));
 assert.equal(input.acceptance.length,5);
 assert.throws(()=>validatePlanProposal(proposal({type:'state',signal:'effects.unchangedEntityIds',operator:'equals',expected:[]})),/not a gesture effect/);
});
