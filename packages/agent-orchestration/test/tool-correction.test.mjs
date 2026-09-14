import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioConversationHost } from '../dist/conversation-host.js';
import { projectToolModelResult } from '../dist/conversation-presentation.js';
import { toolFailureFeedback, toolCorrectionGuidance } from '../dist/tool-correction.js';
import { validatePlanProposal } from '../dist/plan-policy.js';

const failure = { toolId: 'studio.plan.propose', code: 'plan.payload-invalid', message: 'acceptance[0].required must be boolean', retryable: false };
function fixture(limit = 2) {
  const host = new StudioConversationHost({ runtime: {}, tools: { definitions: () => [] }, operationLog: { async append() {} }, isProjectOpen: () => false });
  let charged = 0;
  const run = { taskId: 'task:correction', revision: 1, status: 'running', phase: 'planning', terminalDiagnostic: null, timeline: [], evidence: [] };
  host.taskRuns.set(run.taskId, run);
  host.active = { taskId: run.taskId, toolFailures: new Map([[failure.toolId, failure]]), blockers: [`${failure.toolId}: ${failure.code}`], account: { options: { budget: { limits: { repairIterations: limit } } }, repair: () => ({ allowed: ++charged <= limit }) } };
  host.changed = () => {};
  return { host, run, charged: () => charged, request: (status = 'completed', signal = new AbortController().signal) => host.requestToolCorrection(status, signal, 'turn:correction') };
}

test('failed tool projections retain diagnostics and correction instructions while successful payloads remain compact', () => {
  const input = { status: 'failed', error: { code: failure.code, message: failure.message }, privateLargeResult: 'x'.repeat(30000) };
  for (const projection of ['summary', 'digest-only']) {
    const output = projectToolModelResult(input, projection);
    assert.equal(output.error.message, failure.message);
    assert.equal(output.correction.action, 'revise-and-resubmit');
    assert.equal(output.correction.automaticReplay, false);
    assert.match(output.correction.instruction, /Preserve all user requirements/);
    assert.ok(JSON.stringify(output).length < 2000);
    assert.equal(output.privateLargeResult, undefined);
  }
  assert.equal(projectToolModelResult({status:'completed',value:{large:'x'.repeat(10000)}}, 'digest-only').error, undefined);
  assert.deepEqual(toolFailureFeedback({ status:'cancelled',error:{code:failure.code} }), {});
});

test('reported malformed acceptance item gives precise repair instructions without silently changing requirements', () => {
  const proposal = { title:'Cube', summary:'Build and verify cube', items:[{label:'Build',details:'Build cube'}], assemblies:[], acceptance:[{label:'No runtime errors',required:'true',category:'functional',assertion:'evidence runtime-errors signal count equals 0'}] };
  assert.throws(() => validatePlanProposal(proposal), error => error.code === failure.code && /required must be boolean; received string/.test(error.message));
  assert.equal(proposal.acceptance[0].required, 'true');
  const fixed = {...proposal, acceptance:[{...proposal.acceptance[0],required:true}]};
  assert.deepEqual(validatePlanProposal(fixed).acceptance, fixed.acceptance);
});

test('ending after a correctable tool failure schedules a budgeted continuation and preserves failure history', () => {
  const {host,request,charged} = fixture();
  assert.equal(request(), true); assert.equal(charged(), 1);
  assert.match(host.active.continuationInstruction, /studio.plan.propose/);
  assert.match(host.active.continuationInstruction, /required must be boolean/);
  assert.equal(host.taskRuns.get('task:correction').status, 'running');
  assert.equal(host.active.toolFailures.size, 1);
  assert.equal(request(), false, 'do not schedule twice for the same completion');
  host.active.continuationRequested = false;
  assert.equal(request(), true); assert.equal(charged(), 2);
  host.active.continuationRequested = false;
  assert.equal(request(), false, 'no unbounded continuation if model ignores feedback');
  assert.equal(charged(), 2);
});

test('backend completion enters correction before the task is marked blocked', async () => {
  const {host}=fixture();host.commitContext=async()=>{};
  await host.captureEvent({}, {kind:'completed', backendId:'backend:test',sessionId:'session:test',turnId:'turn:test',payload:{status:'completed'}}, new AbortController().signal);
  assert.equal(host.active.continuationRequested,true);
  assert.equal(host.taskRuns.get('task:correction').status,'running');
  assert.equal(host.taskRuns.get('task:correction').terminalDiagnostic,null);
});

test('automatic correction respects cancellation, human barriers, other failures and configured budgets', () => {
  for (const status of ['cancelled','failed','interrupted']) assert.equal(fixture().request(status), false);
  assert.equal(fixture(0).request(), false);
  const aborted = new AbortController(); aborted.abort(); assert.equal(fixture().request('completed',aborted.signal), false);
  for (const patch of [{suspendedBarrierId:'barrier:pending'},{budgetCheckpoint:{}},{continuationRequested:true}]) {
    const f=fixture(); Object.assign(f.host.active,patch); assert.equal(f.request(),false);assert.equal(f.charged(),0);
  }
  for (const code of ['tool.outcome-unknown','approval.denied','codex.rpc-error','task.repair-budget-exhausted','tool.failed']) {
    const f=fixture();f.host.active.toolFailures.set(failure.toolId,{...failure,code,retryable:true});
    assert.equal(f.request(),false);assert.equal(toolCorrectionGuidance(code),null);
  }
  const blocked=fixture();blocked.host.taskRuns.set(blocked.run.taskId,{...blocked.run,status:'blocked',terminalDiagnostic:'task.repair-budget-exhausted'});assert.equal(blocked.request(),false);
  const other=fixture();other.host.active.blockers.push('tool.outcome-unknown');assert.equal(other.request(),false);
  const budget=fixture();budget.host.active.account.repair=()=>({allowed:false});assert.equal(budget.request(),false);assert.equal(budget.host.active.continuationRequested,undefined);
});

test('real tool commit returns failure feedback to backend; corrected success clears only the resolved blocker', async () => {
  const {host}=fixture();const delivered=[], projected=[];
  host.active.toolFailures.clear();host.active.blockers.length=0;
  host.options.runtime.turns={async recordToolResult(){}};
  host.recordTaskAccounting=async()=>{};host.appendToolSessionOp=async()=>{};
  host.project=(...args)=>projected.push(args);
  const context={toolId:failure.toolId,toolCallId:'call:bad',toolNodeId:'node:bad',args:{title:'Cube'},node:{outputProjection:'digest-only'},event:{backendId:'backend:test',sessionId:'session:test',turnId:'turn:test'},provenance:{backendId:'backend:test',sessionId:'session:test',turnId:'turn:test'},backend:{async submitToolResult(id,result){delivered.push({id,result});}}};
  const body={status:'failed',backendResult:{status:'failed',error:{code:failure.code,message:failure.message}},toolCallStatus:'failed',toolCallContent:{},resultStatus:'failed',resultContent:{summary:failure.message},resultValue:null,fact:null,blocker:`${failure.toolId}: ${failure.code}`,mutation:false,cancelTurnAfterCommit:false,latencyMs:1,finishedAt:new Date().toISOString()};
  const batch={outputBytes:0}; const signal=new AbortController().signal;
  await host.commitToolBody(batch,context,body,signal);
  assert.equal(delivered[0].result.error.message,failure.message);
  assert.equal(delivered[0].result.correction.action,'revise-and-resubmit');
  assert.equal(host.active.toolFailures.size,1);
  host.active.blockers.push('another unresolved failure');
  await host.commitToolBody(batch,{...context,toolCallId:'call:fixed',toolNodeId:'node:fixed'},{...body,status:'completed',backendResult:{status:'completed'},toolCallStatus:'completed',resultStatus:'completed',resultContent:{summary:'Plan validated'},blocker:null},signal);
  assert.equal(host.active.toolFailures.size,0);
  assert.deepEqual(host.active.blockers,['another unresolved failure']);
  assert.ok(projected.some(args=>args[0]==='node:bad'&&args[2]==='failed'),'original failure remains visible');
  assert.ok(projected.some(args=>args[0]==='node:fixed'&&args[2]==='completed'));
  assert.equal(host.taskRuns.get('task:correction').timeline.at(-1).title,'工具修正后已完成');
});
