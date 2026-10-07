import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog, createTeamSessionJournal } from '@haiyue/ai-studio-operation-log';
import { createHarnessStudioRoot } from '../dist/index.js';
import { harnessOwnerContext } from '../dist/ownership.js';
import { createPinnedHarnessAgentTransport } from '../dist/harness-agent.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { response } from './fixtures/messages.mjs';
const input = { sessionId: 'session:team-lead', model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 1024, tools: [], lastConfirmedOpId: 'op:team', prompt: 'Summarize supplied facts.' };
async function fixture(t, admission = { admit: async () => { throw new Error('team.denied'); } }) {
 const directory = await mkdtemp(path.join(tmpdir(), 'studio-team-recovery-'));
 const log = await OperationLog.open({ rootDirectory: directory, appVersion: 'test' });
 const locks = new Set();
 const journal = createTeamSessionJournal(log, { async acquire(id) { if (locks.has(id)) return null; locks.add(id); return { async release() { locks.delete(id); } }; } });
 const roots=[];
 async function open() { const owner=createHarnessStudioRoot(); roots.push(owner);const transport=await createPinnedHarnessAgentTransport({owner,resolveApiKey:async()=> 'fixture-only',teamRecovery:{journal,admission}});return {owner,transport,ctx:harnessOwnerContext(owner)}; }
 t.after(async()=>{ for(const root of roots)await root.dispose();await log.close();await rm(directory,{recursive:true,force:true}); });
 return { open,log,journal,locks };
}

test('official Team journal survives transport restart; stale task CAS is rejected', {timeout:20000}, async t=>{
 const f=await fixture(t);const a=await f.open(); await a.transport.openSession(input);
 const lead=a.ctx.agents.get(SessionId(input.sessionId));assert.ok(lead);
 const task=await a.ctx.agentTeams.createTask(lead,{subject:'Inspect approved facts',description:'Candidate work only.'});
 await a.ctx.agentTeams.updateTask(lead,{taskId:task.id,expectedRevision:1,action:'claim'});
 const before=a.ctx.agentTeams.listTasks(lead);
 await a.owner.dispose();assert.equal(f.locks.size,0);
 const b=await f.open(); await b.transport.openSession(input);
 const restored=b.ctx.agents.get(SessionId(input.sessionId));
 assert.deepEqual(b.ctx.agentTeams.listTasks(restored),before);
 await assert.rejects(b.ctx.agentTeams.updateTask(restored,{taskId:task.id,expectedRevision:1,action:'complete'}),/stale/);
 assert.ok((await f.journal.read(input.sessionId)).flatMap(frame=>frame.events).some(event=>event.type==='team/task'));
});

test('Lead direct steering and restored sessions cannot bypass the request admission gate', {timeout:20000}, async t=>{
 let admissions=0,requests=0;
 const f=await fixture(t,{admit:async()=>{admissions++;throw new Error('team.denied');}});
 t.mock.method(globalThis,'fetch',async()=>{requests++;return response({text:'Unexpected'});});
 const a=await f.open();const events=await Array.fromAsync(a.transport.start(input));
 assert.equal(events.at(-1).status,'failed');assert.equal(requests,0);assert.equal(admissions,1,JSON.stringify(events));
 const lead=a.ctx.agents.get(SessionId(input.sessionId));
 const done=Promise.withResolvers(); const stop=a.ctx.on('session/event',(session,event)=>{if(session===lead.session&&event.type==='turn/end')done.resolve();},{global:true});
 lead.steer(createUserMessage({content:[{type:'text',text:'Peer wakeup'}],source:{kind:'user'}}));await done.promise;stop();
 assert.equal(admissions,2);assert.equal(requests,0);
 await a.owner.dispose(); const b=await f.open();await b.transport.openSession(input);assert.equal(requests,0);
});

test('allowed inference settles actual usage once, after the provider stream exits', {timeout:20000},async t=>{
 const settled=[],admitted=[];
 const f=await fixture(t,{admit:async(request,signal)=>{admitted.push(request);return {signal,settle:async(usage,status)=>settled.push({usage,status})};}});
 t.mock.method(globalThis,'fetch',async()=>response({text:'Done.'}));
 const a=await f.open();const events=await Array.fromAsync(a.transport.start(input));
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events));assert.equal(admitted.length,1);assert.equal(settled.length,1);assert.equal(settled[0].status,'completed');assert.ok(settled[0].usage.inputTokens>0);
 await a.ctx.sessions.flush(a.ctx.agents.get(SessionId(input.sessionId)).session);
 const frames=await f.journal.read(input.sessionId);assert.ok(frames.length>1);
});

test('receipt durable before Lead acknowledgement survives cold recovery without redelivery', {timeout:20000},async t=>{
 const {Session}=await import('@deepseek-ai/dsh-session');
 let admissions=0;const f=await fixture(t,{admit:async()=>{admissions++;throw new Error('Must not dispatch');}});
 const lead=Session.create(SessionId(input.sessionId));const childId='session:team-child';
 const child=Session.create(SessionId(childId),[],{version:4,id:SessionId(childId),createdAt:1,isSeeded:false,parentSession:SessionId(input.sessionId),origin:'subagent'});
 const member={id:childId,name:'researcher',description:'Approved research',provider:'fixture',context:'fresh',phase:'active'};
 lead.append('team/member',{version:2,teamId:lead.id,member:{...member,phase:'provisioning'}});
 lead.append('team/member',{version:2,teamId:lead.id,member});
 const message={id:'team-message-fixture',senderId:lead.id,senderName:'lead',targetId:child.id,content:[{type:'text',text:'Read supplied facts.'}]};
 lead.append('team/message/queued',{version:2,teamId:lead.id,message});
 child.append('user/message',createUserMessage({content:message.content,source:{kind:'team-message',teamId:lead.id,messageId:message.id,senderId:lead.id,senderName:'lead'}}),{surfaceOp:'append'});
 for(const session of [lead,child]) { const lease=await f.journal.acquire(session.id);await f.journal.append({schemaVersion:1,sessionId:session.id,header:session.header,inheritedEventCount:0,offset:0,events:session.snapshotEvents()});await lease.release(); }
 const a=await f.open();const acknowledged=Promise.withResolvers();const stop=a.ctx.on('session/event',(_session,event)=>{if(event.type==='team/message/delivered')acknowledged.resolve();},{global:true});
 await a.transport.openSession(input);await acknowledged.promise;stop();
 const restored=a.ctx.agents.get(SessionId(input.sessionId));await a.ctx.sessions.flush(restored.session);
 assert.equal(admissions,0);assert.equal(restored.session.snapshotEvents().filter(e=>e.type==='team/message/delivered').length,1);
 await a.owner.dispose();const b=await f.open();await b.transport.openSession(input);
 assert.equal(b.ctx.agents.get(SessionId(input.sessionId)).session.snapshotEvents().filter(e=>e.type==='team/message/delivered').length,1);assert.equal(admissions,0);
});

test('the official transport and Host gate share canonical parent usage including cached input', {timeout:20000}, async t=>{
 const {StudioTeamRecoveryAdmission}=await import('@haiyue/ai-studio-agent-orchestration');
 const {TaskAccountingRegistry,UsageLedgerStore,M12_DEFAULT_PRICING_CATALOG}=await import('@haiyue/ai-studio-agent-runtime');
 const {DEFAULT_TASK_BUDGET}=await import('../../agent-orchestration/dist/budget-policy.js');
 // Fixture pricing binds this test model explicitly; it is not a live tariff assertion.
 const catalog={...M12_DEFAULT_PRICING_CATALOG,entries:[{...M12_DEFAULT_PRICING_CATALOG.entries.find(e=>e.model==='deepseek-v4-flash'),model:input.model}]};
 const usage=new UsageLedgerStore();const account=new TaskAccountingRegistry(usage).open({taskId:'task:parent',budget:DEFAULT_TASK_BUDGET,pricingCatalog:catalog});
 let gate;const f=await fixture(t,{admit:(...args)=>gate.admit(...args)});
 gate=new StudioTeamRecoveryAdmission(f.log,usage,{authorize:async()=>({account,signal:new AbortController().signal,qualificationRef:'artifact:fixture-team-evidence',caps:{inputTokens:8000,outputTokens:2000,estimatedCostMicros:10000,wallTimeMs:5000}})});
 await gate.bind({sessionId:input.sessionId,leadSessionId:input.sessionId,parentTaskId:account.options.taskId,budgetId:account.options.budget.id,planTaskId:null,model:input.model});
 t.mock.method(globalThis,'fetch',async()=>response({text:'Done.'}));
 const a=await f.open();const events=await Array.fromAsync(a.transport.start(input));assert.equal(events.at(-1).status,'completed',JSON.stringify(events));
 assert.equal(account.snapshot().usage.inputTokens,100);assert.equal(account.snapshot().usage.cachedInputTokens,80);assert.equal(account.snapshot().usage.outputTokens,7);assert.deepEqual(account.reservedWork(),{});
 await gate.dispose();
});

test('pending mailbox cold-resumes the official child through the same admission boundary', {timeout:20000},async t=>{
 const {Session}=await import('@deepseek-ai/dsh-session');
 const checked=Promise.withResolvers();let requests=0;
 const f=await fixture(t,{admit:async(request)=>{checked.resolve(request);throw new Error('team.parent-not-authorized');}});
 t.mock.method(globalThis,'fetch',async()=>{requests++;return response({text:'Unexpected'});});
 const lead=Session.create(SessionId(input.sessionId)),childId='session:cold-child';
 const child=Session.create(SessionId(childId),[],{version:4,id:SessionId(childId),createdAt:1,isSeeded:false,parentSession:lead.id,origin:'subagent',delegationDepth:1});
 const member={id:childId,name:'researcher',description:'Approved research',provider:'fixture',context:'fresh',phase:'provisioning'};
 lead.append('team/member',{version:2,teamId:lead.id,member});lead.append('team/member',{version:2,teamId:lead.id,member:{...member,phase:'active'}});
 lead.append('team/message/queued',{version:2,teamId:lead.id,message:{id:'team-message-cold',senderId:lead.id,senderName:'lead',targetId:child.id,content:[{type:'text',text:'Continue bounded research.'}]}});
 child.append('turn/start',{turn:1});
 child.append('subagent/descriptor',{version:3,mode:'continuable',provider:'fixture',label:'Approved research',agentProvider:'deepseek-official',agentModel:input.model,agentReasoningEffort:'off'});
 child.append('user/message',createUserMessage({content:[{type:'text',text:'Initial facts'}],source:{kind:'user'}}),{surfaceOp:'append'});
 child.append('turn/end',{turn:1,reason:{kind:'completed'}});
 for(const session of [lead,child]){const lease=await f.journal.acquire(session.id);await f.journal.append({schemaVersion:1,sessionId:session.id,header:session.header,inheritedEventCount:0,offset:0,events:session.snapshotEvents()});await lease.release();}
 const a=await f.open();await a.transport.openSession(input);const request=await checked.promise;
 assert.equal(request.sessionId,childId);assert.equal(request.leadSessionId,lead.id);assert.equal(requests,0);
 await a.owner.dispose();assert.equal(f.locks.size,0);
});

test('Session handles expose buffered appends, enforce one writer and flush on close',async t=>{
 const f=await fixture(t);const a=await f.open();const p=a.ctx.sessionPersistence,id=SessionId('session:handles');
 const writer=await p.create({version:4,id,createdAt:1,isSeeded:false});assert.equal((await p.stat(id)).eventCount,0);
 await assert.rejects(p.open(id,'write'),/owned/i);const reader=await p.open(id,'read');
 const {Session}=await import('@deepseek-ai/dsh-session');const detached=Session.create(id);detached.append('team/task',{version:2,teamId:id,task:{id:'task-1',revision:1,subject:'Read',description:'Facts',status:'pending',blockedBy:[],writeScopes:[]}});
 await writer.append(detached.snapshotEvents());assert.equal((await reader.read()).events.length,1);assert.equal((await p.stat(id)).eventCount,1);
 assert.deepEqual(await f.journal.read(id),[],'append may buffer until the durability barrier');
 await writer.close();assert.equal((await f.journal.read(id)).flatMap(frame=>frame.events).length,1);
 await assert.rejects(writer.read(),/closed/i);await reader.close();
});

test('hidden model reasoning and stream chunks do not enter durable Team replay',async t=>{
 const {frames,data}=await import('./fixtures/messages.mjs');
 const f=await fixture(t,{admit:async(_request,signal)=>({signal,settle:async()=>{}})});
 t.mock.method(globalThis,'fetch',async()=>{
  const wire=frames({text:'Visible answer.'});for(const item of wire)if('index'in item)item.index++;
  wire.splice(1,0,{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'private-reasoning-fixture'}},{type:'content_block_stop',index:0});
  return new Response(wire.map(data).join(''),{headers:{'content-type':'text/event-stream'}});
 });
 const a=await f.open();assert.equal((await Array.fromAsync(a.transport.start(input))).at(-1).status,'completed');await a.owner.dispose();
 const framesSaved=await f.journal.read(input.sessionId);const serialized=JSON.stringify(framesSaved);assert.ok(serialized.includes('Visible answer.'));assert.equal(serialized.includes('private-reasoning-fixture'),false);
 for(const event of framesSaved.flatMap(frame=>frame.events))if(event.type==='assistant/message')assert.deepEqual(event.data.stream,[]);
 const b=await f.open();const continued=await Array.fromAsync(b.transport.start({...input,prompt:'Continue from the visible answer.'}));
 assert.equal(continued.at(-1).status,'completed',JSON.stringify(continued));assert.match(continued.at(-1).turnId,/:turn:2$/);
});
