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
