import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableSessionRuntime, TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioConversationHost } from '../dist/conversation-host.js';
import { parseAsyncQuestion, validateAsyncAnswer } from '../dist/async-question.js';
import { teamAdmission } from '../dist/team-admission.js';
const backendId='backend:async-question', sessionId='session:async-question', turnId='turn:async-question';
const until=async predicate=>{for(let i=0;i<1000;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out');};
const latest=(host,kind)=>[...new Map(host.replay().events.map(e=>[e.node.id,e.node])).values()].filter(n=>n.kind===kind).at(-1);
test('question validation and Team admission never manufacture an answer or qualification',()=>{
 assert.throws(()=>parseAsyncQuestion({prompt:'?',options:['a','a']}));
 assert.throws(()=>validateAsyncAnswer({optionIds:['unknown']},[{id:'a'}]));
 assert.throws(()=>validateAsyncAnswer({text:'',optionIds:[]},[]));
 assert.equal(teamAdmission().status,'unavailable');assert.equal(teamAdmission().upstreamTeamMounted,false);
});
for(const mode of ['live','late','restart','cancel','active-restart','cancel-race'])test(`nonblocking question continues reads and resumes exact owner once (${mode})`,async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'studio-async-question-'));
 const log=await OperationLog.open({rootDirectory:directory,appVersion:'test'});
 let sessions=new DurableSessionRuntime(log), runtime=runtimeFixture(sessions), host;
 t.after(async()=>{await host?.dispose();await sessions.dispose();await log.close();await rm(directory,{recursive:true,force:true});});
 const tools=observeTools();let inputs=[], results=[], releaseRead;const gate=new Promise(r=>releaseRead=r);t.after(()=>releaseRead());
 runtime.registry.get().submitToolResult=async(id,result)=>{results.push({id,result});};
 runtime.turns.start=async function*(_id,input,signal){
  inputs.push(input);const next=inputs.length;
  const event=(kind,payload)=>({schemaVersion:1,backendId,sessionId,turnId:`${turnId}:${next}`,kind,payload});
  yield event('status',{status:'running'});
  if(next===1){
   yield event('tool-request',{toolCallId:'call:ask',toolId:'studio.question.ask',arguments:{prompt:'Choose a color',options:['Blue','Green']}});
   // Flush the closed tool batch before issuing the independent read.
   yield event('status',{status:'running'});
   yield event('tool-request',{toolCallId:'call:read',toolId:'diagnostics.query',arguments:{}});
   yield event('status',{status:'running'});
   await gate;
  }
  yield event('completed',{status:signal?.aborted?'cancelled':'completed'});
 };
 const make=()=>new StudioConversationHost({runtime,tools,operationLog:log,asyncQuestions:true,experimentalTeam:true,sessionRecovery:{async recover(){}}});
 host=make();await host.initialize();await host.dispatch({type:'conversation/send',backendId,prompt:'Ask a question and inspect logs with team admission.'});
 await until(()=>results.length===2);
 const question=latest(host,'question'), taskId=host.replay().taskRuns[0].taskId;
 assert.equal(question.status,'pending');assert.equal(question.content.asyncQuestion,true);
 assert.equal(results[0].result.value.pending,true);assert.equal(tools.executeCalls,1);
 assert.ok(inputs[0].tools.some(t=>t.id==='studio.question.ask'));assert.ok(inputs[0].tools.some(t=>t.id==='studio.team.inspect'));
 // Enforce the write barrier even if the provider attempts to bypass its instructions.
 assert.throws(()=>host.beforeProductTool(taskId,'unknown.write',{},`${turnId}:1`,'call:write'),/pending/);
 await assert.rejects(host.dispatch({type:'conversation/answer-question',nodeId:question.id,answer:{optionIds:['unknown']}}));
 if(mode==='cancel-race'){
  const entered=Promise.withResolvers(), release=Promise.withResolvers();
  const retain=host.retainIntentAmendment.bind(host);
  host.retainIntentAmendment=async(...args)=>{entered.resolve();await release.promise;return retain(...args);};
  const answer=host.dispatch({type:'conversation/answer-question',nodeId:question.id,answer:{text:'Blue'}});
  await entered.promise;runtime.turns.cancel=async()=>releaseRead();
  await host.dispatch({type:'conversation/cancel',backendId,sessionId,turnId:`${turnId}:1`});release.resolve();await answer;
  await until(()=>!host.replay().busy);assert.equal(inputs.length,1);assert.equal(latest(host,'question').status,'cancelled');return;
 }
 if(mode==='cancel'){
  runtime.turns.cancel=async()=>releaseRead();
  await host.dispatch({type:'conversation/cancel',backendId,sessionId,turnId:`${turnId}:1`});
  await until(()=>!host.replay().busy);assert.equal(latest(host,'question').status,'cancelled');
  await assert.rejects(host.dispatch({type:'conversation/answer-question',nodeId:question.id,answer:{text:'Blue'}}),/stale/);
  assert.deepEqual((await sessions.replay(sessionId)).recovery.unresolvedBarrierIds,[]);return;
 }
 if(mode==='active-restart'){runtime.turns.cancel=async()=>releaseRead();}
 if(mode!=='live' && mode!=='active-restart'){releaseRead();await until(()=>!host.replay().busy);assert.equal(host.replay().taskRuns[0].status,'waiting-user');}
 if(mode==='restart' || mode==='active-restart'){
  await host.flushRecords();await host.dispose();await sessions.dispose();sessions=new DurableSessionRuntime(log);
  const old=runtime;runtime=runtimeFixture(sessions);runtime.turns.start=old.turns.start;host=make();await host.initialize();
  assert.equal(latest(host,'question').content.taskId,taskId);
 }
 await host.dispatch({type:'conversation/answer-question',nodeId:question.id,answer:{optionIds:[question.content.options[0].id]}});
 releaseRead();await until(()=>inputs.length===2&&!host.replay().busy);
 assert.equal(inputs[1].taskId,taskId);assert.match(inputs[1].prompt,/Blue/);assert.equal(host.replay().taskRuns.length,1);
 await assert.rejects(host.dispatch({type:'conversation/answer-question',nodeId:question.id,answer:{text:'Again'}}),/stale/);
 assert.equal(inputs.length,2);assert.deepEqual((await sessions.replay(sessionId)).recovery.unresolvedBarrierIds,[]);
});
function runtimeFixture(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage); const profile = { id: 'prompt:g07-barrier', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, modules: [] };
  const backend = { descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async submitToolResult() {} };
  const runtime = { resumeCalls: 0, sessions, usage, accounting, registry: { descriptors: () => [backend.descriptor], get: () => backend }, context: { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'d'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'e'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; } }, turns: { async *start() {}, async *resume() { runtime.resumeCalls += 1; yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'completed', payload: { status: 'completed' } }; }, async cancel() {}, async recordToolResult() {} } };
  return runtime;
}

function observeTools() {
  const tools = { executeCalls: 0, definitions: () => ['project.snapshot', 'diagnostics.query'].map((id) => ({ id, description: id, effect: 'observe', risk: 'low', inputSchema: {} })), async prepare(call) { return { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: 'document:g07-release', baseRevision: 1, argumentsDigest: `sha256:${'4'.repeat(64)}`, previewDigest: `sha256:${'5'.repeat(64)}`, preview: { title: 'Read', target: 'Project', summary: 'Read only', diff: '' }, status: 'ready' }; }, async execute(preparationId) { tools.executeCalls += 1; return { schemaVersion: 1, callId: preparationId.replace('preparation:', ''), toolId: 'diagnostics.query', status: 'completed', value: { retained: true }, documentId: 'document:g07-release', beforeRevision: 1, afterRevision: 1 }; } }; return tools;
}
