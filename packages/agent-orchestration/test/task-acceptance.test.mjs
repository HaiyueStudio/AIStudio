import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedPlaytestTask } from '@haiyue/ai-studio-game-authoring-tools';
import { StudioConversationHost } from '../dist/conversation-host.js';
import { advancePlaytest } from '../dist/task-acceptance.js';
const spec={schemaVersion:2,id:'task:stop-edit',request:'Inspect and repair interaction',visibleConstraints:[],budgetId:'budget:stop-edit',requiredCapabilities:['task.evaluate'],acceptance:[{id:'criterion:motion',required:true,visibility:'agent',category:'functional',assertion:'evidence state'}]};

test('confirmed preview teardown allows script repair; failed stop and terminal states do not reset the loop', async()=>{
 const host=new StudioConversationHost({runtime:{},tools:{definitions:()=>[]},operationLog:{async append(){}},isProjectOpen:()=>false});
 const task=new BoundedPlaytestTask(spec,2);host.playtestTasks.set(spec.id,task);
 try {
  advancePlaytest(task,'playing');
  assert.throws(()=>host.beforeProductTool(spec.id,'script.apply',{},'turn:a','call:apply'),e=>e.code==='task.preview-stop-required');
  host.beforeProductTool(spec.id,'script.propose',{},'turn:a','call:proposal');
  assert.equal(task.snapshot().phase,'playing','preparing a proposal does not pretend preview teardown');
  await host.captureProductToolResult(spec.id,'play.stop',{state:'failed'},'turn:a','call:failed-stop');
  assert.equal(task.snapshot().phase,'playing');
  await host.captureProductToolResult(spec.id,'play.stop',{state:'stopped'},'turn:a','call:stop');
  host.beforeProductTool(spec.id,'script.apply',{},'turn:a','call:repair');
  assert.equal(task.snapshot().phase,'editing');assert.equal(task.snapshot().attempts.length,0);
  advancePlaytest(task,'playing');
  await host.captureProductToolResult(spec.id,'preview.stop',{state:'stopped'},'turn:a','call:stop-again');
  assert.equal(task.snapshot().phase,'editing');
  advancePlaytest(task,'evaluating');
  const evaluation={schemaVersion:2,id:'evaluation:failed',taskId:spec.id,status:'fail',acceptanceResults:[{acceptanceId:'criterion:motion',status:'fail',evidenceIds:['evidence:motion']}],usageRecordIds:[],costRecordIds:[]};
  task.recordEvaluation(evaluation);
  task.beginRepair({turnId:'turn:a',arguments:{repair:'motion'},evidenceIds:['evidence:motion']});
  await host.captureProductToolResult(spec.id,'play.stop',{state:'stopped'},'turn:a','call:repair-stop');
  assert.equal(task.snapshot().phase,'repairing');assert.equal(task.snapshot().attempts.length,1);
  task.block('task.repair-budget-exhausted');
  await host.captureProductToolResult(spec.id,'play.stop',{state:'stopped'},'turn:a','call:terminal-stop');
  assert.equal(task.snapshot().phase,'blocked');assert.equal(task.snapshot().attempts.length,1);
  assert.throws(()=>host.beforeProductTool(spec.id,'script.apply',{},'turn:a','call:blocked-apply'),e=>e.code==='task.repair-budget-exhausted');
 } finally {await host.dispose();}
});

test('editing after validation failure follows the existing legal transition',()=>{
 const task=new BoundedPlaytestTask(spec,2);advancePlaytest(task,'validating');advancePlaytest(task,'editing');assert.equal(task.snapshot().phase,'editing');
});
