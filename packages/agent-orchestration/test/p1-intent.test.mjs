import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRouting } from '@haiyue/ai-studio-agent-runtime';
import { taskIntent, intentRequirements, intentConstraints, isTaskIntent, assertIntentAllows, questionAmendment } from '../dist/task-intent.js';
import { taskSpecFromPlan, taskSpecFromRun, verificationRoute } from '../dist/task-acceptance.js';
import { structuredAssertion } from '../dist/plan-assertion.js';
import { parseEvidenceAssertion, BoundedPlaytestTask } from '@haiyue/ai-studio-game-authoring-tools';

test('P1 source-bound constraints survive TaskSpec compilation and recovery beyond a shortened summary',()=>{
 const intent=taskIntent('把选中的按钮改成红色，保持其他对象不变',['entity:button'],7,['不要创建任何实体']);
 for(const r of intentRequirements(intent)) assert.equal([intent.request,...intent.amendments][r.source.messageIndex].slice(r.source.start,r.source.end),r.text);
 const active={taskId:'task:intent',goal:intent.request,account:{options:{budget:{id:'budget:intent'}}}};
 const plan=taskSpecFromPlan(active,[],intent);
 const restored=taskSpecFromRun({taskId:active.taskId,requestSummary:'truncated',acceptance:[]},JSON.parse(JSON.stringify(intent)));
 assert.deepEqual(restored.visibleConstraints,plan.visibleConstraints);assert.equal(restored.request,intent.request);
 assert.deepEqual(plan.visibleConstraints,['保持其他对象不变','不要创建任何实体']);
 assert.doesNotThrow(()=>assertIntentAllows(intent,'reversible-edit','material.set',{entityId:'entity:button'}));
 for(const [id,args] of [['material.set',{entityId:'entity:other'}],['entity.create',{}],['script.apply',{}],['component.configure',{componentId:'component:unknown'}]]) assert.throws(()=>assertIntentAllows(intent,'reversible-edit',id,args),/preserv|prohibit/i);
});
test('P1 read-only, negated creation and unresolved preservation cannot be bypassed by plan approval',()=>{
 for(const request of ['不要创建任何实体，只检查按钮颜色','只解释一下什么是相机','Only explain how to create a camera','read-only review']) {
  const intent=taskIntent(request,[],null); assert.equal(requestRouting(request).readOnly,true);
  assert.throws(()=>assertIntentAllows(intent,'reversible-edit','camera.author',{}),/read-only/);
  assert.doesNotThrow(()=>assertIntentAllows(intent,'observe','scene.query',{}));
 }
 assert.equal(requestRouting('检查相机，然后创建按钮').readOnly,false);
 assert.equal(requestRouting('Inspect the scene, then create a button').readOnly,false);
 for(const request of ['Inspect the camera, then apply the existing script proposal.','Inspect the scene, then frobnicate the target','检查相机，然后执行方案']) assert.equal(requestRouting(request).readOnly,false);
 for(const [effect,id] of [['reversible-edit','material.set'],['observe','task.evaluate'],['runtime-start','play.start']]) assert.throws(()=>assertIntentAllows(taskIntent('修改按钮，保持背景亮度',[],1),effect,id,{entityId:'entity:button'}),/no supported/);
 assert.throws(()=>assertIntentAllows(taskIntent('把选中按钮改红，保持其他对象不变',[],1),'reversible-edit','material.set',{entityId:'entity:button'}),/submission-bound/);
});
test('P1 retained intent rejects invalid, future and secret-bearing records',()=>{
 const valid=taskIntent('保留背景',[],1);assert.equal(isTaskIntent(valid),true);
 for(const value of [{...valid,version:'intent-constraints/2'},{...valid,selection:['unknown']},{...valid,revision:-1},{...valid,approved:true},{...valid,request:'Authorization: Bearer fixture-secret'}]) assert.equal(isTaskIntent(value),false);
});
test('P1 one evidence AST routes legacy and structured assertions identically',()=>{
 for(const value of [{type:'state',signal:'effects.cameraChanged',operator:'equals',expected:false},{type:'event-trace',signal:'interactions.0.type',operator:'equals',expected:'pointerup'},{type:'lifecycle',signal:'remaining',operator:'equals',expected:0}]) {
  const text=structuredAssertion(value);assert.ok(text);assert.deepEqual(parseEvidenceAssertion(text),value);
  assert.deepEqual(verificationRoute({assertion:`  ${text}  `,category:'functional'}),verificationRoute({assertion:text,category:'functional'}));
 }
 assert.equal(parseEvidenceAssertion('evidence state signal score equals nope'),null);
 assert.equal(verificationRoute({assertion:' evidence state signal effects.cameraChanged equals false ',category:'functional'}).tool,'play.pointer-gesture');
});


test('P1 long inspection does not duplicate the request in constraints; question supplements retain text and selected labels',()=>{
 const request='Only inspect '+ 'the scene details '.repeat(1000);
 const intent=taskIntent(request,[],1);
 assert.deepEqual(intentConstraints(intent),['Read-only: Only inspect']);assert.ok(JSON.stringify(intentRequirements(intent)).length<200);
 const note=questionAmendment({text:'不要创建任何实体',optionIds:['option:keep']},[{id:'option:keep',label:'保持其他对象不变'}]);
 assert.equal(note,'不要创建任何实体\n保持其他对象不变');
 const active={taskId:'task:question',goal:'Modify the button',account:{options:{budget:{id:'budget:question'}}}};
 const loop=new BoundedPlaytestTask(taskSpecFromPlan(active,[]),3);loop.advance('editing');
 loop.retainConstraints(intentConstraints(taskIntent(active.goal,[],1,[note])));
 assert.deepEqual(loop.task.visibleConstraints,['不要创建任何实体','保持其他对象不变']);assert.equal(loop.snapshot().phase,'editing');assert.equal(loop.repairLimit,3);
 loop.retainConstraints([]);assert.equal(loop.task.visibleConstraints.length,2);
});


test('P1 inspection goals route read-only without inventing a permanent edit prohibition',()=>{
 for(const request of ['Inspect the project and propose a plan.','解释一下什么是相机','Explain how to create a camera']) {
  assert.equal(requestRouting(request).readOnly,true);
  assert.equal(requestRouting(request).prohibitEdits,false);
  const intent=taskIntent(request,[],1);
  assert.deepEqual(intentRequirements(intent),[]);
  // Existing plan and tool approvals still govern actual execution in the Host.
  assert.doesNotThrow(()=>assertIntentAllows(intent,'reversible-edit','entity.create',{}));
 }
 const scoped=taskIntent('修改按钮，不要修改相机',[],1);
 assert.equal(intentRequirements(scoped)[0].predicate,'unresolved');
 assert.throws(()=>assertIntentAllows(scoped,'reversible-edit','entity.create',{}),/no supported/);
});
