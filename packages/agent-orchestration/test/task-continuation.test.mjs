import test from 'node:test';
import assert from 'node:assert/strict';
import { taskContinuationRequest, incompleteAcceptanceDetail } from '../dist/task-continuation.js';

test('checkpoint context retains requirements within a UTF-8 budget and identifies omitted criteria', () => {
  const run = { taskId: 'task:test', requestSummary: '魔方'.repeat(1000), documentRevision: 8, status: 'blocked', evidence: [], acceptance: Array.from({length:50},(_,i)=>({id:`criterion:${i}`,label:'交互'.repeat(120),assertion:'evidence state signal count equals 27',status:'pending',required:true,evidenceIds:[],diagnostic:null})) };
  const request = taskContinuationRequest(run);
  assert.ok(Buffer.byteLength(request)<8192);
  const checkpoint=JSON.parse(request.split('\n\n')[1]);
  assert.equal(checkpoint.requiredRemaining,50); assert.ok(checkpoint.omittedCriteria>0);
  assert.equal(checkpoint.omittedCriteria+checkpoint.criteria.length,50);
  assert.equal(checkpoint.documentRevision,8);assert.match(request,/Do not weaken approved criteria/);
  assert.match(incompleteAcceptanceDetail(run),/50 项必需标准未通过/);
});

test('continuation includes only current same-Play evidence and routes effects to their producer',()=>{
 const run={taskId:'task:test',requestSummary:'Click changes color',documentRevision:6,status:'running',acceptance:[{id:'criterion:color',label:'Color changed',required:true,status:'pending',evidenceIds:[],assertion:'evidence state signal effects.materialColorChanged equals true'}],evidence:[
  {id:'artifact:old',type:'state',tick:1,playId:'play:old',documentRevision:6,provenanceStatus:'current'},
  {id:'artifact:stale',type:'state',tick:1,playId:'play:new',documentRevision:5,provenanceStatus:'stale'},
  {id:'artifact:baseline',type:'state',tick:2,playId:'play:new',documentRevision:6,provenanceStatus:'current'},
  {id:'artifact:after',type:'state',tick:5,playId:'play:new',documentRevision:6,provenanceStatus:'current'}]};
 const text=taskContinuationRequest(run),checkpoint=JSON.parse(text.split('\n\n')[1]);
 assert.deepEqual(checkpoint.retainedEvidence.map(x=>x.id),['artifact:after','artifact:baseline']);
 assert.equal(checkpoint.criteria[0].verification.tool,'play.pointer-gesture');
 assert.match(text,/do not restart Play/);assert.ok(Buffer.byteLength(text)<8192);
});
