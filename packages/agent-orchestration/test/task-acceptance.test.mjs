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


test('verification routes data and visual requirements consistently across restored plans', async()=>{
 const {verificationRoute,taskSpecFromPlan,taskSpecFromRun}=await import('../dist/task-acceptance.js');
 const {taskContinuationRequest}=await import('../dist/task-continuation.js');
 const acceptance=[
  {id:'criterion:transform',label:'Object rotates',category:'functional',assertion:'evidence state signal state.entities.0.rotation.1 gte 1',required:true,status:'pending',evidenceIds:[]},
  {id:'criterion:errors',label:'No errors',category:'functional',assertion:'evidence runtime-errors signal count equals 0',required:true,status:'pending',evidenceIds:[]},
  {id:'criterion:appearance',label:'Rendered appearance',category:'visual',assertion:'evidence screenshot',required:true,status:'pending',evidenceIds:[]}
 ];
 assert.equal(verificationRoute(acceptance[0]).method,'data');
 assert.equal(verificationRoute(acceptance[1]).tool,'play.inspect');
 assert.equal(verificationRoute(acceptance[2]).tool,'play.capture');
 assert.equal(verificationRoute({assertion:'evidence lifecycle',category:'lifecycle'}).tool,'play.stop');
 const run={taskId:'task:routes',requestSummary:'Verify game',documentRevision:1,status:'running',acceptance,evidence:[]};
 const active={taskId:run.taskId,goal:run.requestSummary,account:{options:{budget:{id:'budget:routes'}}}};
 assert.deepEqual(taskSpecFromPlan(active,acceptance).requiredCapabilities,taskSpecFromRun(run).requiredCapabilities);
 assert.deepEqual(taskSpecFromRun({...run,acceptance:acceptance.slice(0,2)}).requiredCapabilities,['task.evaluate','play.inspect']);
 const checkpoint=JSON.parse(taskContinuationRequest(run).split('\n\n')[1]);
 assert.deepEqual(checkpoint.criteria.map(c=>c.verification.method),['data','data','visual-review']);
 assert.match(checkpoint.criteria[2].verification.guidance,/presence alone does not prove/);
});

test('gesture baseline and final evidence are both retained for later evaluation',async()=>{
 const host=new StudioConversationHost({runtime:{},tools:{definitions:()=>[]},operationLog:{async append(){}},isProjectOpen:()=>false});
 const make=(id,tick)=>({schemaVersion:2,id,type:'state',taskId:spec.id,turnId:'turn:a',playId:'play:a',documentRevision:6,tick,frame:tick,capturedAt:new Date().toISOString(),byteLength:100,producerVersion:'test/1'});
 host.taskRuns.set(spec.id,{taskId:spec.id,documentRevision:6,phase:'playing',evidence:[],timeline:[],revision:1});
 host.evidenceReadModel=async artifact=>({...artifact,provenanceStatus:'current'});host.changed=()=>{};
 try{
  await host.captureProductToolResult(spec.id,'play.pointer-gesture',{baseline:make('evidence:baseline',1),observations:[make('evidence:after',3)]},'turn:a','call:gesture');
  assert.deepEqual(host.taskRuns.get(spec.id).evidence.map(item=>item.id),['evidence:baseline','evidence:after']);
 }finally{await host.dispose();}
});

test('an unavailable required evidence field prevents gameplay repair even alongside another failed condition',async()=>{
 const host=new StudioConversationHost({runtime:{},tools:{definitions:()=>[]},operationLog:{async append(){}},isProjectOpen:()=>false});
 const taskSpec={...spec,acceptance:[...spec.acceptance,{...spec.acceptance[0],id:'criterion:missing',assertion:'evidence state signal state.entities.0.geometry.kind equals "rounded-box"'}]};
 const task=new BoundedPlaytestTask(taskSpec,3);advancePlaytest(task,'evaluating');host.playtestTasks.set(spec.id,task);
 host.taskRuns.set(spec.id,{taskId:spec.id,documentRevision:6,phase:'evaluating',evidence:[{id:'evidence:a',provenanceStatus:'current'}],timeline:[],revision:1});host.changed=()=>{};
 try{
  await host.captureProductToolResult(spec.id,'task.evaluate',{schemaVersion:2,id:'evaluation:test',taskId:spec.id,status:'fail',acceptanceResults:[{acceptanceId:'criterion:motion',status:'fail',evidenceIds:['evidence:a'],diagnostic:'evaluation.condition-failed:motion:equals'},{acceptanceId:'criterion:missing',status:'blocked',evidenceIds:['evidence:a'],diagnostic:'evaluation.signal-unavailable:state.entities.0.geometry.kind'}],usageRecordIds:[],costRecordIds:[],completedAt:new Date().toISOString(),evaluatorVersion:'test/1'},'turn:a','call:evaluate');
  assert.equal(task.snapshot().phase,'blocked');assert.equal(task.snapshot().attempts.length,0);
  assert.match(host.taskRuns.get(spec.id).timeline.at(-1).detail,/不是游戏功能失败/);
 }finally{await host.dispose();}
});
