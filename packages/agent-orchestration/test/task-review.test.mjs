import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAgentReview } from '@haiyue/ai-studio-contracts';
import { OperationLog, ProjectAgentHistory } from '@haiyue/ai-studio-operation-log';
import { analyzeTaskReview } from '../dist/task-review-rules.js';
import { ProjectTaskReviews } from '../dist/project-task-reviews.js';

const at = '2026-10-11T01:00:00.000Z';
const task = { schemaVersion:1,revision:3,taskId:'task:a',title:'搭建并验证游戏',status:'blocked',startedAt:at,updatedAt:'2026-10-11T01:01:00.000Z',repairIteration:2,acceptance:[] };
function detail(id, kind = 'tool-result', status = 'failed', code = 'tool.arguments-invalid', turnId = 'turn:a') {
  return {schemaVersion:1,projectId:'project:a',record:{schemaVersion:1,id:`record:${id}:${kind}`,projectId:'project:a',kind,status,sessionId:'session:a',turnId,toolId:'scene.query',startedAt:at,finishedAt:at,durationMs:10,dataArtifactId:`artifact:${id}:${kind}`},data:{toolCallId:`call:${id}`,parameters:{revision:1},result:{status,callId:`call:${id}`,value:{code,...(code==='barrier.waiting-user'?{preserved:true}:{})}}}};
}
test('rules deduplicate calls/results and revisions; separate approval, cancellation, environment and repeated failures',() => {
  const paused = detail('pause','tool-result','cancelled','barrier.waiting-user');
  const diagnostic = detail('network','diagnostic','failed'); diagnostic.data = {code:'codex.server-error'};
  const input = [detail('1','tool-call'),detail('1'),detail('1'),detail('2'),paused,detail('cancel','tool-result','cancelled'),diagnostic];
  const report = analyzeTaskReview('project:a',task,input);
  assert.deepEqual(report.metrics,{toolCalls:4,failed:2,cancelled:1,suspended:1,repeatedFailures:1,userMessages:0,durationMs:60000,repairs:2});
  assert.ok(report.findings.some(f=>f.code==='environment'));
  assert.equal(report.findings.find(f=>f.code==='repeated-tool-failure').recordIds.length,2);
  assert.equal(report.coverage.records,6);
  assert.equal(report.sourceDigest,analyzeTaskReview('project:a',task,input).sourceDigest);
});
test('valid, invalid, unknown-version and secret-bearing report fixtures are checked at the boundary',() => {
  const valid = analyzeTaskReview('project:a',task,[detail('1')]); assert.equal(parseAgentReview(valid).taskId,'task:a');
  for (const invalid of [{...valid,schemaVersion:2},{...valid,extra:true},{...valid,title:'Bearer SECRET_CANARY_TOKEN'},{...valid,metrics:{...valid.metrics,failed:-1}},{...valid,findings:[{...valid.findings[0],recordIds:['record:foreign']}]}]) assert.throws(()=>parseAgentReview(invalid));
  const redacted = analyzeTaskReview('project:a',{...task,title:'SECRET_CANARY'},[detail('1')]); assert.equal(redacted.title,'[REDACTED]');
});
test('coverage is explicit and evidence selection never leaves broken finding references',() => {
  const records = Array.from({length:350},(_,i)=>detail(String(i)));
  records[0].data.legacyRecord = true;
  const report = analyzeTaskReview('project:a',task,records,2,true);
  assert.equal(report.coverage.partial,true); assert.equal(report.coverage.omittedEvidence,50); assert.equal(report.metrics.failed,350);
  assert.ok(report.findings.every(f=>f.recordIds.every(id=>report.evidence.some(e=>e.recordId===id))));
});
test('same read is a hint only after three successes without intervening other operations',() => {
  const reads=Array.from({length:3},(_,i)=>detail(String(i),'tool-result','completed'));
  for(const read of reads) read.record.toolId='project.snapshot';
  assert.ok(analyzeTaskReview('project:a',task,reads).findings.some(f=>f.code==='repeated-read'));
  reads[1].record.toolId='scene.create';
  assert.ok(!analyzeTaskReview('project:a',task,reads).findings.some(f=>f.code==='repeated-read'));
});

test('project disposal and resumed-task revisions reject late deep reports without overwriting saved rules',async()=>{
  for(const mode of ['dispose','resume']) {
    const report=analyzeTaskReview('project:a',task,[detail('1')]);let release,entered=false,writes=0;
    let state={busy:false,taskRuns:[task]};
    const log={status:()=>({nextSequence:1,retainedFromSequence:0}),async query(){return {events:[{sequence:0,kind:'agent/task-review',payload:{taskId:report.taskId,taskRevision:report.taskRevision,sourceDigest:report.sourceDigest},correlation:{projectId:'project:a'},artifactRefs:['artifact:report']}],nextCursor:undefined};},async readArtifact(){return {value:report};},async putArtifact(){writes++;return {id:'artifact:new'};},async append(){writes++;}};
    const reviews=new ProjectTaskReviews({projectId:'project:a',log,snapshot:()=>state,flush:async()=>{},changed:()=>{},deepen:async()=>{entered=true;await new Promise(resolve=>release=resolve);return {createdAt:at,backendId:'backend:a',model:'model',summary:'candidate',findings:[],usageLabel:'unknown',accountingArtifactId:'artifact:usage'};}});
    await reviews.list();const pending=reviews.deepen('task:a',new AbortController().signal);const rejected=assert.rejects(pending);
    while(!entered)await new Promise(resolve=>setTimeout(resolve,1));
    let disposing;
    if(mode==='dispose')disposing=reviews.dispose();else state={busy:false,taskRuns:[{...task,revision:4,status:'waiting-user'}]};
    release();await rejected;await (disposing??reviews.dispose());assert.equal(writes,0);
  }
});

test('automatic reports persist, remain project-scoped, update on resume, and do not duplicate on restart',async t => {
  const root = await mkdtemp(path.join(tmpdir(),'haiyue-review-'));
  const source = await OperationLog.open({rootDirectory:path.join(root,'global'),appVersion:'test'});
  let history = await ProjectAgentHistory.open({projectId:'project:a',directory:path.join(root,'project','.aistudio','agent'),source,storage:'project'});
  let state = {busy:true,taskRuns:[task]}; let changed=0;
  const create = () => new ProjectTaskReviews({projectId:'project:a',log:history.log,snapshot:()=>state,flush:()=>history.flush(),changed:()=>changed++,deepen:async()=>{throw new Error('must be manual');}});
  let reviews = create();
  t.after(async()=>{await reviews.dispose();await history.dispose();await source.close();await rm(root,{recursive:true,force:true});});
  for (const [i,turn] of [[1,'turn:a'],[2,'turn:b']]) {
    const d=detail(String(i),'tool-result','failed','tool.arguments-invalid',turn);
    const a=await history.log.putArtifact(d.data,{schemaVersion:'agent-execution-data/1'});
    await history.log.append({kind:'conversation/task-projected',severity:'info',source:'test',correlation:{sessionId:'session:a',turnId:turn},payload:{taskId:'task:a'}});
    await history.log.append({kind:'agent/execution-record',severity:'info',source:'test',correlation:{sessionId:'session:a',turnId:turn},payload:{record:{...d.record,dataArtifactId:a.id}},artifactRefs:[a.id]});
  }
  // Same session, foreign task: it must never be attributed by session/time alone.
  const foreign=detail('foreign'); const foreignData=await history.log.putArtifact(foreign.data);
  await history.log.append({kind:'agent/execution-record',severity:'info',source:'test',payload:{taskId:'task:other',record:{...foreign.record,dataArtifactId:foreignData.id}},artifactRefs:[foreignData.id]});
  reviews.observe(); assert.equal((await reviews.list()).records.length,0);
  state={busy:false,taskRuns:[{...task,status:'waiting-user'}]}; reviews.observe(); assert.equal((await reviews.list()).records.length,0);
  state={busy:false,taskRuns:[task]}; reviews.observe(); const page=await reviews.list(); assert.equal(page.records.length,1,JSON.stringify(page));
  const original=await reviews.read('task:a'); assert.equal(original.metrics.toolCalls,2); assert.equal(original.metrics.repeatedFailures,1);
  reviews.observe(); await reviews.list(); await history.flush();
  assert.equal((await history.log.query({kinds:['agent/task-review'],limit:100})).events.length,1);
  await reviews.dispose(); await history.dispose();
  history=await ProjectAgentHistory.open({projectId:'project:a',directory:path.join(root,'project','.aistudio','agent'),source,storage:'project'}); reviews=create();
  reviews.observe(); await reviews.list(); assert.equal((await reviews.read('task:a')).sourceDigest,original.sourceDigest);
  state={busy:false,taskRuns:[{...task,revision:4,status:'completed'}]};reviews.observe();await reviews.list();
  assert.equal((await reviews.read('task:a')).outcome,'completed');
  await history.flush(); assert.equal((await history.log.query({kinds:['agent/task-review'],limit:100})).events.length,2);assert.ok(changed>=3);
});

test('historical reviews beyond the recent event window page lazily and keep a bounded cache',async()=>{
 const artifacts=new Map(),events=[];let reads=0;
 for(let i=0;i<155;i++){const report=analyzeTaskReview('project:a',{...task,taskId:'task:old:'+i,title:'Old task '+i},[detail('1')]);const artifact='artifact:old:'+i;artifacts.set(artifact,report);events.push({sequence:i,timestamp:at,kind:'agent/task-review',correlation:{projectId:'project:a'},artifactRefs:[artifact],payload:{taskId:report.taskId,taskRevision:report.taskRevision,sourceDigest:report.sourceDigest}});}
 const log={status:()=>({nextSequence:60000,retainedFromSequence:0}),async query(q){return {events:events.filter(e=>e.sequence>(q.afterSequence??-1)&&e.sequence<q.beforeSequence),nextCursor:undefined};},async readArtifact(id){reads++;return {value:artifacts.get(id)};}};
 const create=()=>new ProjectTaskReviews({projectId:'project:a',log,snapshot:()=>({busy:true,taskRuns:[]}),flush:async()=>{},changed:()=>{},deepen:async()=>{throw new Error('unused');}});
 let reviews=create();let page=await reviews.list();assert.equal(page.total,155);assert.equal(page.records.length,50);assert.equal(reads,50);assert.equal(page.records[0].taskId,'task:old:154');
 const seen=new Set(page.records.map(r=>r.taskId));while(page.nextCursor){page=await reviews.list(page.nextCursor);page.records.forEach(r=>seen.add(r.taskId));}assert.equal(seen.size,155);assert.equal(page.records.length,5);assert.ok(reviews.reports.size<=100);
 assert.equal((await reviews.read('task:old:0')).taskId,'task:old:0');await assert.rejects(reviews.list('1:50'),/已变化/);
 await reviews.dispose();reviews=create();assert.equal((await reviews.read('task:old:0')).title,'Old task 0');await reviews.dispose();
});
test('a corrupt newest historical report stays visible and never falls back to older advice',async()=>{
 const report=analyzeTaskReview('project:a',task,[detail('1')]);
 const events=[{sequence:0,artifactRefs:['artifact:old']},{sequence:1,artifactRefs:['artifact:bad']}].map(e=>({...e,timestamp:at,kind:'agent/task-review',correlation:{projectId:'project:a'},payload:{taskId:task.taskId,taskRevision:task.revision,sourceDigest:report.sourceDigest}}));
 const log={status:()=>({nextSequence:60000,retainedFromSequence:0}),async query(q){return {events:events.filter(e=>e.sequence>(q.afterSequence??-1)&&e.sequence<q.beforeSequence)};},async readArtifact(id){return {value:id==='artifact:old'?report:{...report,schemaVersion:99}};}};
 const reviews=new ProjectTaskReviews({projectId:'project:a',log,snapshot:()=>({busy:false,taskRuns:[task]}),flush:async()=>{},changed:()=>{},deepen:async()=>{throw new Error('unused');}});
 const page=await reviews.list();assert.equal(page.total,1);assert.match(page.error,/损坏/);assert.match(page.records[0].title,/无法读取/);await assert.rejects(reviews.read(task.taskId));await reviews.dispose();
});

test('resumed tasks can analyze old retained execution evidence beyond fifty thousand unrelated events',async()=>{
 const data=detail('old'),artifacts=new Map([['artifact:data',data.data]]);let sequence=60000;
 const events=[{sequence:1,kind:'conversation/task-projected',correlation:{projectId:'project:a',sessionId:'session:a',turnId:'turn:a'},payload:{taskId:'task:a'}},{sequence:2,kind:'agent/execution-record',correlation:{projectId:'project:a'},payload:{record:{...data.record,dataArtifactId:'artifact:data'}}}];
 const log={status:()=>({nextSequence:sequence,retainedFromSequence:0}),async query(q){return {events:events.filter(e=>q.kinds.includes(e.kind)&&e.sequence>(q.afterSequence??-1)&&e.sequence<q.beforeSequence)};},async readArtifact(id){return {value:artifacts.get(id)};},async putArtifact(value){const id='artifact:saved:'+artifacts.size;artifacts.set(id,value);return {id};},async append(value){const event={...value,sequence:sequence++,timestamp:at};events.push(event);return event;}};
 const reviews=new ProjectTaskReviews({projectId:'project:a',log,snapshot:()=>({busy:false,taskRuns:[task]}),flush:async()=>{},changed:()=>{},deepen:async()=>{throw new Error('unused');}});
 await reviews.list();const report=await reviews.read(task.taskId);assert.equal(report.metrics.toolCalls,1);assert.equal(report.coverage.partial,false);assert.equal(report.coverage.missing,0);await reviews.dispose();
});
