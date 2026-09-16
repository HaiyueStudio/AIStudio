import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runSubtasks } from '../dist/index.js';
import { TaskAccountingRegistry, UsageLedgerStore, M12_DEFAULT_PRICING_CATALOG } from '@haiyue/ai-studio-agent-runtime';
import { sha256 } from '@haiyue/ai-studio-operation-log';
import { DEFAULT_TASK_BUDGET } from '../dist/budget-policy.js';
const task = id => ({ id:`item:${id}`, label:`Design ${id}`, execution:{ schemaVersion:1,id:`task:${id}`,dependsOn:[],inputs:[`fact:${id}`],artifacts:[`result:${id}`],readScopes:['document:test'],writeScopes:[],verification:['parent:verify'],budget:{toolCalls:4,wallTimeMs:1000},estimatedWorkMs:20000 } });
function fixture() {
 const ledger = new UsageLedgerStore(), account = new TaskAccountingRegistry(ledger).open({taskId:'task:parent',budget:DEFAULT_TASK_BUDGET,pricingCatalog:M12_DEFAULT_PRICING_CATALOG});
 const controller = new AbortController(); let revision=7,calls=0,active=0,peak=0; const audits=[],received=[];
 const candidate = input => ({schemaVersion:1,taskId:input.planTaskId,baseRevision:input.baseRevision,artifacts:input.artifactKeys.map(key=>({key,kind:'test',content:'Candidate test',sources:input.facts.map(f=>f.ref)}))});
 const options={enabled:true,qualify:async()=> 'evidence:trusted-real-ab',caps:{inputTokens:3000,outputTokens:1000,estimatedCostMicros:10000,wallTimeMs:1000},facts:async(refs,rev)=>refs.map(ref=>({ref,content:ref,digest:sha256(ref),revision:rev})),port:{backendId:'backend:test',model:'fixture-model',async run(input,signal){calls++;active++;peak=Math.max(peak,active);received.push(input);await delay(12);active--;signal.throwIfAborted();return {candidate:candidate(input),turnId:`turn:${input.planTaskId}`};}}};
 const input={selection:{schemaVersion:1,taskIds:['task:first','task:second']},approved:[task('first'),task('second')],backendId:'backend:test',model:'fixture-model',sessionId:'session:parent',turnId:'turn:parent',callId:'call:delegate',account,revision:()=>revision,signal:controller.signal,audit:async(kind,payload)=>audits.push({kind,payload})};
 return {options,input,account,ledger,controller,audits,received,candidate,set revision(v){revision=v},get calls(){return calls},get peak(){return peak}};
}
for(const mode of ['disabled','provider-mismatch','small','coupled','writes','overlap','unqualified','unapproved','budget','bad-facts','secret-facts']) test(`W7 rejects ${mode} before any child request`,async()=>{
 const f=fixture();
 if(mode==='provider-mismatch')f.options.port.model='different-model';
 if(mode==='disabled')f.options.enabled=false;
 if(mode==='small')f.input.approved[0].execution.estimatedWorkMs=20;
 if(mode==='coupled')f.input.approved[0].execution.dependsOn=['task:second'];
 if(mode==='writes')f.input.approved[0].execution.writeScopes=['document:test'];
 if(mode==='overlap')f.input.approved[1].execution.artifacts=['result:first'];
 if(mode==='unqualified')f.options.qualify=async()=>null;
 if(mode==='unapproved')f.input.approved=[];
 if(mode==='budget')f.options.caps.inputTokens=200000;
 if(mode==='bad-facts')f.options.facts=async()=>[];
 if(mode==='secret-facts')f.options.facts=async(refs,revision)=>refs.map(ref=>({ref,revision,content:'Authorization: Bearer fixture-secret',digest:sha256('Authorization: Bearer fixture-secret')}));
 const result=await runSubtasks(f.options,f.input);assert.equal(result.status,'not-delegated');assert.equal(f.calls,0);assert.deepEqual(f.account.reservedWork(),{});
});
test('W7 runs independent work on two lanes, preserves order and minimal facts, retains unknown billing reserves',async()=>{
 const f=fixture(), result=await runSubtasks(f.options,f.input);
 assert.equal(result.status,'completed');assert.equal(f.peak,2);assert.deepEqual(result.candidates.map(c=>c.taskId),['task:first','task:second']);
 assert.deepEqual(f.received[0].facts.map(f=>f.ref),['fact:first']);assert.equal(f.received[0].history,undefined);assert.equal(f.received[0].tools,undefined);
 assert.equal(f.account.reservedWork().inputTokens,6000);assert.equal(f.account.snapshot().usage.inputTokens,0,'reservations are not provider usage');assert.equal(f.audits[0].kind,'admitted');
});
test('W7 rejects unproven sources, stale revisions and conflicting output keys without applying anything',async()=>{
 for(const mode of ['source','revision','key','extra','partial']){const f=fixture(); f.options.port.run=async input=>{const value=f.candidate(input);if(mode==='source')value.artifacts[0].sources=['fact:other'];if(mode==='key')value.artifacts[0].key='result:other';if(mode==='extra')value.authorization='fixture-only';if(mode==='partial')value.artifacts=[];if(mode==='revision')f.revision=8;return {candidate:value,turnId:'turn:child'};};const result=await runSubtasks(f.options,f.input);assert.ok(['partial','stale'].includes(result.status));assert.deepEqual(result.candidates,[]);}
});
test('W7 cancel waits for real child exit and suppresses late publication',async()=>{
 const f=fixture();let startedResolve,exitResolve;const started=new Promise(r=>startedResolve=r),exit=new Promise(r=>exitResolve=r);let settled=false;
 f.options.port.run=async input=>{startedResolve();await exit;return {candidate:f.candidate(input),turnId:'turn:child'};};
 const work=runSubtasks(f.options,f.input).finally(()=>settled=true);await started;f.controller.abort(new Error('cancel'));await delay(20);assert.equal(settled,false);exitResolve();await assert.rejects(work,/cancel/);assert.equal(f.audits.some(a=>a.kind==='candidate'),false);
});
test('W7 reservations are atomic across concurrent batches and a journal failure makes zero calls',async()=>{
 const f=fixture();assert.equal(f.account.reserveWork('external',{inputTokens:198000}),true);const r=await runSubtasks(f.options,f.input);assert.equal(r.reason,'shared-budget');assert.equal(f.calls,0);assert.equal(f.account.reservedWork().inputTokens,198000);
 const g=fixture();g.input.audit=async()=>{throw new Error('journal unavailable')};await assert.rejects(runSubtasks(g.options,g.input),/journal/);assert.equal(g.calls,0);assert.deepEqual(g.account.reservedWork(),{});
});
test('W7 final real ledger releases its own reservation once; missing and parent ledgers cannot release it',()=>{
 const f=fixture();const add=(id)=>{const l=f.ledger.open({taskId:'task:parent',sessionId:'session:child',turnId:id,providerRequestDigest:null,startedAtMs:0});f.account.bindTurn(id,{provider:'deepseek',model:'deepseek-v4-flash',billingMode:'api'});l.reconcile({eventId:`event:${id}`,sequence:1,mode:'cumulative',inputTokens:10,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:2,reasoningTokens:0,observedAtMs:2});l.markTerminal('stop',3);};
 add('turn:parent');assert.equal(f.account.reserveWork('child:first',{inputTokens:100}),true);assert.equal(f.account.settleWork('child:first','turn:parent'),false);assert.equal(f.account.settleWork('child:first','turn:missing'),false);add('turn:new');assert.equal(f.account.settleWork('child:first','turn:new'),true);assert.equal(f.account.reserveWork('child:second',{inputTokens:100}),true);assert.equal(f.account.settleWork('child:second','turn:new'),false);
});
