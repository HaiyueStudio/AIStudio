import { suggestExperiences } from '../dist/experience-suggestions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageLedgerStore, TaskAccountingRegistry } from '@haiyue/ai-studio-agent-runtime';
import { deepenTaskReview } from '../dist/task-review-deep.js';
import { analyzeTaskReview } from '../dist/task-review-rules.js';
const at='2026-10-11T00:00:00.000Z';
const report=analyzeTaskReview('project:a',{taskId:'task:a',revision:1,title:'游戏任务',status:'failed',startedAt:at,updatedAt:at,repairIteration:0,acceptance:[]},[{schemaVersion:1,projectId:'project:a',record:{schemaVersion:1,id:'record:1',projectId:'project:a',sessionId:'session:a',turnId:'turn:a',kind:'tool-result',toolId:'scene.query',status:'failed',startedAt:at,finishedAt:at,durationMs:1,dataArtifactId:'artifact:a'},data:{parameters:{text:'RAW_TOOL_DATA_MUST_STAY_LOCAL'},toolCallId:'call:a',result:{error:{code:'tool.arguments-invalid'}}}}]);
const config={schemaVersion:2,backendId:'backend:test',model:'deepseek-chat',reasoningEffort:'low',outputTokenLimit:8192,taskBudgetId:'budget:a',promptProfile:{id:'prompt:test',version:'1',digest:'a'.repeat(64)},requestedCapabilities:[]};
const candidate={summary:'先读取参数约束，减少重复失败。',findings:[{code:'review.arguments',severity:'warning',title:'调用参数需复核',detail:'出现一次参数错误。',recommendation:'调用前确认契约。',recordIds:['record:1']}]};
function fixture(mode='valid', kind='harness-api-key') {
  const usage=new UsageLedgerStore(), events=[], artifacts=[], detached=[], inputs=[], cancels=[];
  const backend={requestContextMode:kind==='harness-api-key'?'per-request':undefined,descriptor:{kind},async detach(id){detached.push(id);}};
  const runtime={usage,accounting:new TaskAccountingRegistry(usage),registry:{get:()=>backend},context:{async prepareIsolated(prompt){assert.ok(Buffer.byteLength(prompt)<=24576);return {prompt,contextArtifactIds:[]};}},turns:{
    async *start(backendId,input,signal){
      inputs.push(input); const ledger=usage.open({taskId:input.taskId,sessionId:'session:review',turnId:'turn:review',providerRequestDigest:'a'.repeat(64),startedAtMs:Date.now()});
      const event=(kind,payload)=>({schemaVersion:1,backendId,sessionId:'session:review',turnId:'turn:review',kind,payload});
      yield event('status',{});
      if(mode==='cancel') { await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}); }
      ledger.reconcile({eventId:'usage:a',sequence:1,mode:'cumulative',inputTokens:100,outputTokens:50,observedAtMs:Date.now()});yield event('usage',{});
      const proposal={schemaVersion:1,summary:'建议收窄条件，需验证。',proposals:[{findingIndex:mode==='suggestion-foreign'?11:0,draft:{title:'先检查参数',condition:'调用场景工具时',recommendation:'依据参数定义填写调用。',keywords:['场景']},positiveRequest:'修改场景对象',negativeRequest:'增加音乐'}]};
      const value=mode.startsWith('suggestion')?proposal:structuredClone(candidate);if(mode==='foreign')value.findings[0].recordIds=['record:other']; if(mode==='secret')value.summary='SECRET_CANARY';
      yield event(mode==='approval'?'approval':'tool-request',{toolId:mode==='mutation'?'scene.create':mode.startsWith('suggestion')?'studio.experience.suggest':'studio.review.submit',toolCallId:'call:review',arguments:mode==='invalid'?{summary:3}:value});
      ledger.markTerminal('cancelled',Date.now());yield event('completed',{status:'cancelled'});
    },async cancel(...args){cancels.push(args);}
  }};
  const log={async putArtifact(value){artifacts.push(value);return {id:`artifact:account:${artifacts.length}`};},async append(event){events.push(event);}};
  return {runtime,log,events,artifacts,detached,inputs,cancels};
}
for(const kind of ['harness-api-key','codex-app-server']) test(`manual ${kind} review uses one fresh session, current model, evidence-only tool and separate accounting`,async()=>{
  const f=fixture('valid',kind), result=await deepenTaskReview(f.runtime,f.log,report,config,new AbortController().signal);
  assert.equal(result.model,config.model); assert.equal(result.findings[0].recordIds[0],'record:1');
  assert.equal(f.inputs.length,1); assert.equal(f.inputs[0].sessionId,undefined); assert.notEqual(f.inputs[0].taskId,report.taskId);
  assert.deepEqual(f.inputs[0].tools.map(t=>t.id),['studio.review.submit']);assert.ok(!f.inputs[0].prompt.includes('RAW_TOOL_DATA_MUST_STAY_LOCAL'));
  assert.equal(f.inputs[0].config.outputTokenLimit,4096); assert.equal(!!f.inputs[0].isolatedRequestLimits,kind==='harness-api-key');
  assert.equal(f.cancels.length,1);assert.deepEqual(f.detached,['session:review']);assert.equal(f.events[0].kind,'agent/task-review-usage');assert.equal(f.artifacts[0].usage.outputTokens,50);
  if(kind==='codex-app-server')assert.match(result.usageLabel,/不支持硬输出/);
});
for(const mode of ['foreign','mutation','approval','invalid']) test(`review rejects ${mode}, retains accounting and detaches session`,async()=>{
  const f=fixture(mode);await assert.rejects(()=>deepenTaskReview(f.runtime,f.log,report,config,new AbortController().signal));
  assert.deepEqual(f.detached,['session:review']);assert.equal(f.events[0].payload.status,'failed');
});
test('model-returned secrets are redacted before publication',async()=>{const f=fixture('secret');assert.equal((await deepenTaskReview(f.runtime,f.log,report,config,new AbortController().signal)).summary,'[REDACTED]');});
test('large evidence reports fit the actual isolated context bound with explicit omitted counts',async()=>{
  const f=fixture(),large={...report,title:'较长游戏需求'.repeat(150),coverage:{...report.coverage,records:300},evidence:[report.evidence[0],...Array.from({length:299},(_,i)=>({...report.evidence[0],recordId:`record:${i}:${'x'.repeat(180)}`,toolId:'工具'.repeat(70)}))],findings:Array.from({length:24},()=>({...report.findings[0],title:'参数错误'.repeat(40),detail:'完整诊断'.repeat(250),recommendation:'建议检查'.repeat(250)}))};
  await deepenTaskReview(f.runtime,f.log,large,config,new AbortController().signal);
  assert.ok(Buffer.byteLength(f.inputs[0].prompt)<=23000);assert.match(f.inputs[0].prompt,/omittedEvidence/);
});
test('cancellation releases review ownership without a late result',async()=>{
  const f=fixture('cancel'),controller=new AbortController();const run=deepenTaskReview(f.runtime,f.log,report,config,controller.signal);
  while(!f.inputs.length)await new Promise(resolve=>setTimeout(resolve,1)); controller.abort();await assert.rejects(run);assert.deepEqual(f.detached,['session:review']);assert.equal(f.events[0].payload.status,'failed');
});

for(const kind of ['harness-api-key','codex-app-server'])test('automatic '+kind+' candidate analysis uses a bounded fresh session and evidence-only submission',async()=>{
 const f=fixture('suggestion',kind);const result=await suggestExperiences(f.runtime,f.log,report,[],config,new AbortController().signal);
 assert.equal(result.value.proposals.length,1);assert.equal(result.metadata.model,config.model);assert.equal(f.inputs.length,1);assert.equal(f.inputs[0].sessionId,undefined);
 assert.deepEqual(f.inputs[0].tools.map(t=>t.id),['studio.experience.suggest']);assert.equal(f.events[0].kind,'agent/experience-ai-usage');assert.equal(f.inputs[0].config.outputTokenLimit,4096);assert.deepEqual(f.detached,['session:review']);
 assert.ok(!f.inputs[0].prompt.includes('RAW_TOOL_DATA_MUST_STAY_LOCAL'));assert.match(f.inputs[0].prompt,/findingIndex/);assert.equal(!!f.inputs[0].isolatedRequestLimits,kind==='harness-api-key');
});
test('automatic analysis rejects references to findings that were not provided',async()=>{const f=fixture('suggestion-foreign');await assert.rejects(suggestExperiences(f.runtime,f.log,report,[],config,new AbortController().signal),/来源发现/);assert.equal(f.events[0].payload.status,'failed');assert.deepEqual(f.detached,['session:review']);});
