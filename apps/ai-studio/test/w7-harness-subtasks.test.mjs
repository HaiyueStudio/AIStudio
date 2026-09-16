import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHarnessStudioRoot } from '@haiyue/ai-studio-harness-bridge';
import { createPinnedHarnessAgentTransport } from '@haiyue/ai-studio-harness-bridge/agent';
import { HarnessApiKeyBackend } from '@haiyue/ai-studio-agent-backends';
import { AgentBackendRegistry, AgentTurnRuntime, PromptContextRuntime, TaskAccountingRegistry, M12_DEFAULT_PRICING_CATALOG } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog, sha256 } from '@haiyue/ai-studio-operation-log';
import { runSubtasks, createRuntimeSubtaskPort } from '@haiyue/ai-studio-agent-orchestration';
import { DEFAULT_TASK_BUDGET } from '../../../packages/agent-orchestration/dist/budget-policy.js';
for (const mode of ['candidate', 'over-budget', 'no-structured-result']) test(`W7 pinned Harness isolated requests and cleanup: ${mode}`, {timeout:20000},async t=>{
 const directory=await mkdtemp('/private/tmp/aistudio-w7-'); const root=createHarnessStudioRoot();
 const transport=await createPinnedHarnessAgentTransport({owner:root,resolveApiKey:async()=> 'fixture-only',contextWindow:200000});
 const backend=new HarnessApiKeyBackend({transport,clearApiKey:async()=>{}}),registry=new AgentBackendRegistry();registry.register(backend);
 const log=await OperationLog.open({rootDirectory:directory,appVersion:'w7-test'}),context=new PromptContextRuntime(log),turns=new AgentTurnRuntime(registry,log,context),accounting=new TaskAccountingRegistry(turns.usage);
 const account=accounting.open({taskId:'task:parent',budget:DEFAULT_TASK_BUDGET,pricingCatalog:M12_DEFAULT_PRICING_CATALOG});let requests=0;const detached=[];
 t.mock.method(globalThis,'fetch',async(_url,init)=>{requests++;const body=JSON.parse(init.body);assert.equal(body.tools.length,1);assert.ok(body.max_tokens<=2048);const prompt=body.messages.find(m=>m.role==='user').content;assert.equal(prompt.includes('parent-history-marker'),false);const fact=prompt.includes('fact:first')?'first':'second';assert.equal(prompt.includes(`fact:${fact==='first'?'second':'first'}`),false);
 const delta=mode==='no-structured-result'?{content:'No structured result'}:{tool_calls:[{index:0,id:`candidate-${fact}`,type:'function',function:{name:body.tools[0].function.name,arguments:JSON.stringify({schemaVersion:1,taskId:`task:${fact}`,baseRevision:7,artifacts:[{key:`result:${fact}`,kind:'proposal',content:'Candidate from isolated fact',sources:[`fact:${fact}`]}]})}}]};
 return new Response(`data: ${JSON.stringify({id:`w7-${requests}`,choices:[{index:0,delta,finish_reason:mode==='no-structured-result'?'stop':'tool_calls'}],usage:{prompt_tokens:100,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100,completion_tokens:10,completion_tokens_details:{reasoning_tokens:0},total_tokens:110}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
 });
 try{
 const config={schemaVersion:2,backendId:backend.descriptor.id,model:'deepseek-v4-flash',reasoningEffort:'off',outputTokenLimit:2048,taskBudgetId:DEFAULT_TASK_BUDGET.id,promptProfile:context.prompts.profile,requestedCapabilities:[]};
 const port=createRuntimeSubtaskPort({registry,turns,context,accounting},backend.descriptor.id,config,async id=>{detached.push(id);await backend.detach(id);});
 const approved=['first','second'].map(name=>({id:`item:${name}`,label:`Design ${name}`,execution:{schemaVersion:1,id:`task:${name}`,dependsOn:[],inputs:[`fact:${name}`],artifacts:[`result:${name}`],readScopes:['document:test'],writeScopes:[],verification:['parent:verify'],budget:{toolCalls:1,wallTimeMs:10000},estimatedWorkMs:20000}}));
 const result=await runSubtasks({enabled:true,port,qualify:async()=> 'evidence:fixture-only-not-production',caps:{inputTokens:mode==='over-budget'?100:32768,outputTokens:2048,estimatedCostMicros:100000,wallTimeMs:10000},facts:async(refs,revision)=>refs.map(ref=>({ref,content:ref,digest:sha256(ref),revision}))},{selection:{schemaVersion:1,taskIds:approved.map(a=>a.execution.id)},approved,backendId:backend.descriptor.id,model:config.model,sessionId:'session:parent',turnId:'turn:parent',callId:'call:delegate',account,revision:()=>7,signal:new AbortController().signal,audit:async(kind,payload)=>{await log.putArtifact({kind,payload},{schemaVersion:'w7-test/1'});}});
 assert.equal(requests,mode==='over-budget'?0:2);assert.equal(result.status,mode==='candidate'?'completed':'partial');assert.equal(detached.length,2);
 if(mode==='candidate'){assert.equal(account.snapshot().usage.inputTokens,200);assert.equal(account.snapshot().usage.outputTokens,20);assert.equal(account.snapshot().consumption.turns,2);assert.equal(new Set(detached).size,2);assert.ok(turns.usage.snapshots().every(s=>s.record.taskId==='task:parent'&&s.record.final));}
 t.diagnostic(JSON.stringify({mode,requests,detached:detached.length,status:result.status}));
 }finally{await turns.dispose();await root.dispose();await log.close();await rm(directory,{recursive:true,force:true});}
});
