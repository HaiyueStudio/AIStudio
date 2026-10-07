import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {OperationLog} from '@haiyue/ai-studio-operation-log';
import {TaskAccountingRegistry,UsageLedgerStore,M12_DEFAULT_PRICING_CATALOG} from '@haiyue/ai-studio-agent-runtime';
import {StudioTeamRecoveryAdmission} from '../dist/index.js';import {DEFAULT_TASK_BUDGET} from '../dist/budget-policy.js';
async function fixture(t) {
 const directory=await mkdtemp(path.join(tmpdir(),'team-admission-'));const log=await OperationLog.open({rootDirectory:directory,appVersion:'test'});
 const usage=new UsageLedgerStore(),account=new TaskAccountingRegistry(usage).open({taskId:'task:parent',budget:DEFAULT_TASK_BUDGET,pricingCatalog:M12_DEFAULT_PRICING_CATALOG}),controller=new AbortController();
 const caps={inputTokens:4000,outputTokens:1000,estimatedCostMicros:10000,wallTimeMs:1000};
 const authority={authorize:async()=>({account,signal:controller.signal,qualificationRef:'artifact:qualified-team',caps})};
 const gate=new StudioTeamRecoveryAdmission(log,usage,authority);
 const binding={sessionId:'session:lead',leadSessionId:'session:lead',parentTaskId:account.options.taskId,budgetId:account.options.budget.id,planTaskId:null,model:'deepseek-v4-flash'};
 await gate.bind(binding);
 const request={sessionId:binding.sessionId,leadSessionId:binding.leadSessionId,model:binding.model,requestId:'request:one',inputTokenBound:2000,outputTokenLimit:500,toolNames:[]};
 t.after(async()=>{await gate.dispose();await log.close();await rm(directory,{recursive:true,force:true});});return {directory,log,usage,account,controller,caps,authority,gate,binding,request};
}
for(const kind of ['unknown-member','tools','unqualified','cancelled','input-cap','output-cap','unknown-price','budget']) test(`Team denies ${kind} before dispatch`,async t=>{
 const f=await fixture(t);const r={...f.request};
 if(kind==='unknown-member')r.sessionId='session:unknown';if(kind==='tools')r.toolNames=['write'];if(kind==='unqualified')f.authority.authorize=async()=>null;if(kind==='cancelled')f.controller.abort();if(kind==='input-cap')r.inputTokenBound=99999;if(kind==='output-cap')r.outputTokenLimit=99999;if(kind==='unknown-price')f.caps.estimatedCostMicros=1;if(kind==='budget')f.account.reserveWork('other',{inputTokens:199999});
 await assert.rejects(f.gate.admit(r,new AbortController().signal));
 assert.equal((await f.log.query({kinds:['conversation/team-request-started'],limit:200,traverseCorrelation:false})).events.length,0);
});
test('Team actual usage uses parent ledger and a durable receipt blocks duplicate dispatch',async t=>{
 const f=await fixture(t);const permit=await f.gate.admit(f.request,new AbortController().signal);
 await permit.settle({inputTokens:10,outputTokens:4},'completed');await permit.settle(null,'failed');
 assert.equal(f.account.snapshot().usage.inputTokens,10);assert.deepEqual(f.account.reservedWork(),{});
 await assert.rejects(f.gate.admit(f.request,new AbortController().signal),/already-dispatched/);
 const restarted=new StudioTeamRecoveryAdmission(f.log,f.usage,f.authority);
 await assert.rejects(restarted.admit(f.request,new AbortController().signal),/already-dispatched/);
 const next=await restarted.admit({...f.request,requestId:'request:two'},new AbortController().signal);await next.settle({inputTokens:20,outputTokens:5},'completed');await restarted.dispose();
 assert.equal(f.account.snapshot().usage.inputTokens,30);
});
test('crash after request admission blocks automatic replay and does not reset unknown cost',async t=>{
 const f=await fixture(t);const permit=await f.gate.admit(f.request,new AbortController().signal);
 const restarted=new StudioTeamRecoveryAdmission(f.log,new UsageLedgerStore(),f.authority);
 await assert.rejects(restarted.admit({...f.request,requestId:'request:two'},new AbortController().signal),/reconciliation-required/);
 await permit.settle(null,'cancelled');assert.equal(f.account.snapshot().cost.final,false);assert.ok(f.account.reservedWork().inputTokens>0);await restarted.dispose();
});
test('restored paid receipts require the reconciled parent ledger, never a fresh zero-cost account',async t=>{
 const f=await fixture(t);const permit=await f.gate.admit(f.request,new AbortController().signal);await permit.settle({inputTokens:10,outputTokens:4},'completed');
 const restarted=new StudioTeamRecoveryAdmission(f.log,new UsageLedgerStore(),f.authority);await assert.rejects(restarted.admit({...f.request,requestId:'request:two'},new AbortController().signal),/reconciliation-required/);await restarted.dispose();
});
test('cancel and disposal wait for the real provider to drain before releasing wall reservation',async t=>{
 const f=await fixture(t);const permit=await f.gate.admit(f.request,new AbortController().signal);let disposed=false;
 const work=f.gate.dispose().then(()=>disposed=true);await Promise.resolve();assert.equal(permit.signal.aborted,true);assert.equal(disposed,false);
 await permit.settle({inputTokens:2,outputTokens:1},'cancelled');await work;assert.equal(disposed,true);assert.deepEqual(f.account.reservedWork(),{});
});
