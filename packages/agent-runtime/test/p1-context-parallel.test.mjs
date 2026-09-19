import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { PromptContextRuntime } from '../dist/index.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const base={conversationKey:'conversation:p1',backendId:'backend:p1',taskId:'task:p1',request:'Inspect selected object',tools:[]};
async function fixture(t,retrieval) {
 const root=await mkdtemp('/private/tmp/aistudio-p1-context-'),log=await OperationLog.open({rootDirectory:root,appVersion:'p1-test'});
 t.after(async()=>{await log.close();await rm(root,{recursive:true,force:true});});
 return {log,runtime:new PromptContextRuntime(log,undefined,retrieval)};
}
test('P1 exact context overlaps index refresh; retrieval waits for refresh and uses the same revision',{timeout:5000},async t=>{
 const ready=deferred(),queried=deferred();let refreshed=false,searches=0;
 const {runtime}=await fixture(t,{async initialize(){},async search(input){searches++;assert.ok(refreshed);assert.equal(input.projectRevision,7);return {hits:[]};}});
 const project={projectId:'project:p1',documentId:'document:p1',revision:7,manifest:{},focusEntityIds:['entity:one'],exact:{async query(){queried.resolve();return {entities:[],complete:true};}}};
 const work=runtime.prepare({...base,project,knowledgeReady:ready.promise});
 await queried.promise;assert.equal(searches,0,'exact query must run before refresh releases');refreshed=true;ready.resolve();
 const context=await work;assert.equal(searches,1);assert.ok(context.contextArtifactIds.length);
});
test('P1 optional retrieval rejection preserves exact facts and records an explicit degraded state',async t=>{
 const {runtime}=await fixture(t,{async initialize(){},async search(){throw Error('offline');}});
 const context=await runtime.prepare({...base,project:null});assert.match(context.prompt,/knowledgeStatus.*unavailable/);
});
test('P1 cancellation during retrieval prevents late context publication',{timeout:5000},async t=>{
 const started=deferred(),release=deferred(),controller=new AbortController();
 const {runtime}=await fixture(t,{async initialize(){},async search(input){started.resolve();await release.promise;input.signal.throwIfAborted();return {hits:[]};}});
 const work=runtime.prepare({...base,project:null,signal:controller.signal});await started.promise;controller.abort(Error('cancelled'));await assert.rejects(work,/cancelled/);release.resolve();
 assert.equal(runtime.pendingContexts.size,0);
});
