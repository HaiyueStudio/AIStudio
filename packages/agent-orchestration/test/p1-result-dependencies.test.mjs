import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { ResultArtifacts } from '../dist/result-artifacts.js';
import { questionBlockedSteps, independentQuestionEdit, validateQuestionSteps } from '../dist/question-dependencies.js';
import { parseAsyncQuestion } from '../dist/async-question.js';

const item = (id, dependsOn=[], scopes=[`entity:${id}`]) => ({id:`item:${id}`,executionStatus:'in_progress',execution:{schemaVersion:1,id,dependsOn,readScopes:scopes,writeScopes:scopes,inputs:[],artifacts:[],verification:[],budget:{toolCalls:4,wallTimeMs:1000},estimatedWorkMs:1000}});
test('question dependency closure only admits precise disjoint approved edits',()=>{
 const items=[item('one'),item('two',['one']),item('three')];
 assert.deepEqual([...questionBlockedSteps(items,['item:one'])],['item:one','item:two']);
 assert.equal(independentQuestionEdit(items,['item:one'],'transform.set',{entityId:'entity:three'}),true);
 for(const tool of ['script.apply','official.browser.navigate','entity.create','component.configure']) assert.equal(independentQuestionEdit(items,['item:one'],tool,{entityId:'entity:three'}),false);
 for(const id of ['entity:one','entity:two','entity:unknown']) assert.equal(independentQuestionEdit(items,['item:one'],'material.set',{entityId:id}),false);
 assert.equal(independentQuestionEdit(items,[],'material.set',{entityId:'entity:three'}),false);
 assert.equal(independentQuestionEdit([item('one',[],['document:current']),item('three')],['item:one'],'material.set',{entityId:'entity:three'}),false);
 assert.throws(()=>validateQuestionSteps(items,['item:missing']));
 assert.throws(()=>parseAsyncQuestion({prompt:'?',options:['a','b'],blockedStepIds:['a','a']}));
 assert.deepEqual(parseAsyncQuestion({prompt:'?',options:['a','b'],blockedStepIds:['item:one']}).blockedStepIds,['item:one']);
});
test('large results are redacted, ranged, durable, permission/revision/TTL scoped and never action-cached',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'p1-results-'));const log=await OperationLog.open({rootDirectory:directory,appVersion:'test'});
 t.after(async()=>{await log.close();await rm(directory,{recursive:true,force:true});});
 let now=1000;let store=new ResultArtifacts(log,()=>now);
 const scope={sessionId:'session:one',turnId:'turn:one',documentId:'doc:one',revision:1,permissions:'permission:one'};
 const value={status:'completed',value:{url:'https://example.org/source',content:'独立研究 '.repeat(4000),authorization:'Bearer fixture-secret-value'}};
 const projected=await store.project(value,'official.web.fetch',{url:'https://example.org/source'},scope);
 assert.equal(projected.projection,'artifact-summary');assert.ok(JSON.stringify(projected).length<2500);assert.ok(!JSON.stringify(projected).includes('fixture-secret-value'));assert.deepEqual(projected.sources,[{url:'https://example.org/source'}]);
 const ref=projected.artifactRef.id;
 const first=await store.read({artifactId:ref,length:128},scope);assert.equal(first.text.length,128);assert.equal(first.nextOffset,128);
 store=new ResultArtifacts(log,()=>now);
 const nextScope={...scope,turnId:'turn:next'};
 assert.equal((await store.reuse('official.web.fetch',{url:'https://example.org/source'},nextScope)).reused,true);
 assert.ok(await store.read({artifactId:ref,offset:128,length:128},nextScope));
 for(const change of [{sessionId:'session:other'},{revision:2},{documentId:'doc:other'},{permissions:'revoked'}]) {
  assert.equal(await store.reuse('official.web.fetch',{url:'https://example.org/source'},{...nextScope,...change}),null);
  await assert.rejects(store.read({artifactId:ref},{...nextScope,...change}));
 }
 for(const toolId of ['official.web.search','official.browser.navigate','official.code.run']) assert.equal(await store.reuse(toolId,{},scope),null);
 await assert.rejects(store.read({artifactId:ref,length:8193},scope));
 now+=60001;await assert.rejects(store.read({artifactId:ref},scope));assert.equal(await store.reuse('official.web.fetch',{url:'https://example.org/source'},scope),null);
});
