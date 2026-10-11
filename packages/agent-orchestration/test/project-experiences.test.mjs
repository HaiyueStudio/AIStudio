import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog, ProjectAgentHistory } from '@haiyue/ai-studio-operation-log';
import { parseAgentExperience, parseExperienceAdoption, parseExperienceDraft, parseExperienceLibrary, parseExperienceSelection } from '@haiyue/ai-studio-contracts';
import { PromptContextRuntime } from '@haiyue/ai-studio-agent-runtime';
import { parseExperienceArchive, parseExperienceArchiveChange, parseExperienceHistoryQuery, parseExperienceReuseChange, parseExperienceReuseState } from '@haiyue/ai-studio-contracts';
import { ProjectExperiences } from '../dist/project-experiences.js';

const at='2026-10-11T00:00:00.000Z';
const finding={code:'tool-failure',severity:'warning',title:'棋盘朝向错误',detail:'平面默认位于 XY。',recommendation:'创建棋盘时检查坐标平面，再校验实际旋转。',recordIds:['record:1']};
const report={schemaVersion:1,ruleVersion:'1.0.0',projectId:'project:a',taskId:'task:source',taskRevision:3,title:'制作棋盘',outcome:'blocked',generatedAt:at,sourceDigest:'a'.repeat(64),coverage:{records:1,missing:0,partial:false,omittedEvidence:0},metrics:{toolCalls:1,failed:1,cancelled:0,suspended:0,repeatedFailures:0,userMessages:1,durationMs:100,repairs:0},findings:[finding],evidence:[{recordId:'record:1',kind:'tool-result',toolId:'scene.create',status:'failed',startedAt:at,durationMs:20}],deep:null};
const draft={title:'棋盘朝向',condition:'创建位于水平面的棋盘时',recommendation:'先检查平面的坐标系，再设置朝向并验证。',keywords:['棋盘','scene.create']};
const adoption={schemaVersion:1,projectId:'project:a',taskId:'task:source',reviewDigest:report.sourceDigest,findingSource:'rules',finding,draft};
const valid={schemaVersion:1,id:'experience:a',projectId:'project:a',revision:1,enabled:true,createdAt:at,updatedAt:at,...draft,source:{taskId:'task:source',taskRevision:3,reviewDigest:report.sourceDigest,reviewArtifactId:'artifact:review',findingSource:'rules',finding}};

test('experience contracts reject unknown versions, secrets, foreign identities and malformed applicability',()=>{
  assert.deepEqual(parseAgentExperience(valid),valid);assert.deepEqual(parseExperienceAdoption(adoption),adoption);
  for(const value of [{...valid,schemaVersion:2},{...valid,extra:true},{...valid,title:'Bearer SECRET_CANARY'},{...valid,condition:'api_key=CANARY'},{...valid,revision:0},{...valid,keywords:[]},{...valid,keywords:['*']},{...valid,keywords:['重复','重复']}]) assert.throws(()=>parseAgentExperience(value));
  assert.throws(()=>parseExperienceDraft({...draft,path:'C:/project'}));
  assert.throws(()=>parseExperienceAdoption({...adoption,schemaVersion:2}));
  assert.throws(()=>parseExperienceLibrary({schemaVersion:1,projectId:'project:b',revision:1,entries:[valid]}));
  assert.throws(()=>parseExperienceSelection({schemaVersion:1,projectId:'project:a',libraryRevision:1,libraryArtifactId:null,entries:[{experience:valid,matchedKeywords:['棋盘']}]}));
  assert.throws(()=>parseExperienceSelection({schemaVersion:1,projectId:'project:a',libraryRevision:1,libraryArtifactId:'artifact:library',entries:[{experience:{...valid,enabled:false},matchedKeywords:['棋盘']}]}));
});

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'haiyue-experiences-'));
  const log=await OperationLog.open({rootDirectory:path.join(root,'global'),appVersion:'test'});
  const directory=path.join(root,'project','.aistudio','agent');
  let history=await ProjectAgentHistory.open({projectId:'project:a',directory,source:log,storage:'project'});
  let current=report,busy=false,changes=0,reviewGate=null,reviewEntered=false,failReuse=false,failArchive=false,artifactGate=null,artifactEntered=false;
  const create=()=>new ProjectExperiences({projectId:'project:a',log:{...history.log,append:async(...args)=>{if(failArchive&&args[0].payload?.archive)throw new Error('injected archive failure');if(failReuse&&args[0].kind==='agent/experience-reuse-updated')throw new Error('injected reuse failure');return history.log.append(...args);},putArtifact:async(...args)=>{if(['agent-experience-reuse/1','agent-experience-archive/1'].includes(args[1]?.schemaVersion)){artifactEntered=true;await artifactGate;}return history.log.putArtifact(...args);}},busy:()=>busy,review:async()=>{reviewEntered=true;await reviewGate;return current;},flush:()=>history.flush(),changed:()=>changes++});
  let store=create();await store.initialize();
  t.after(async()=>{await store.dispose();await history.dispose();await log.close();await rm(root,{recursive:true,force:true});});
  return {root,log,directory,get history(){return history;},get store(){return store;},set report(v){current=v;},set busy(v){busy=v;},set reviewGate(v){reviewGate=v;reviewEntered=false;},get reviewEntered(){return reviewEntered;},set failReuse(v){failReuse=v;},set failArchive(v){failArchive=v;},set artifactGate(v){artifactGate=v;artifactEntered=false;},get artifactEntered(){return artifactEntered;},get changes(){return changes;},async reopen(){await store.dispose();await history.dispose();history=await ProjectAgentHistory.open({projectId:'project:a',directory,source:log,storage:'project'});store=create();await store.initialize();}};
}

const reuseChange=(paused,expectedRevision=0)=>({schemaVersion:1,projectId:'project:a',expectedRevision,paused});
test('reuse switch contracts validate versions, revision, booleans and reject secret-bearing or additional fields',()=>{
  const state={schemaVersion:1,projectId:'project:a',revision:0,paused:false,updatedAt:null};
  assert.deepEqual(parseExperienceReuseState(state),state);assert.deepEqual(parseExperienceReuseChange(reuseChange(true)),reuseChange(true));
  for(const patch of [{schemaVersion:2},{projectId:'SECRET_CANARY'},{expectedRevision:-1},{paused:'true'},{path:'C:/unsafe'}])assert.throws(()=>parseExperienceReuseChange({...reuseChange(true),...patch}));
  for(const patch of [{schemaVersion:2},{projectId:'SECRET_CANARY'},{revision:-1},{paused:true},{updatedAt:'invalid'},{extra:1}])assert.throws(()=>parseExperienceReuseState({...state,...patch}));
});

test('pause works while busy, preserves advice, survives restart and resets provider context before reuse resumes',async t=>{
  const f=await fixture(t);const entry=await f.store.adopt(adoption),context=new PromptContextRuntime(f.log);
  const input={conversationKey:'conversation:pause',backendId:'backend:a',taskId:'task:new',request:'棋盘',tools:[],project:{projectId:'project:a',documentId:'document:a',revision:1,manifest:{name:'A'}}};
  await context.prepare({...input,experiences:await f.store.select('棋盘','task:new')});await context.commit({...input,sessionId:'session:advice',turnId:'turn:advice',projectId:'project:a'});
  f.busy=true;await f.store.setReuse(reuseChange(true));await assert.rejects(f.store.update(entry.id,1,false,draft),/等待/);
  const paused=await f.store.select('棋盘','task:new');assert.deepEqual(paused.entries,[]);assert.equal(paused.libraryArtifactId,null);
  const prepared=await context.prepare({...input,experiences:paused});assert.equal(prepared.reusedSessionId,null);assert.doesNotMatch(prepared.prompt,/棋盘朝向/);
  await f.reopen();assert.equal((await f.store.list()).reuse.paused,true);assert.equal((await f.store.list()).entries[0].enabled,true);
  await assert.rejects(f.store.setReuse(reuseChange(false,0)),/已变化/);await assert.rejects(f.store.setReuse({...reuseChange(false,1),projectId:'project:b'}),/项目/);
  await f.store.setReuse(reuseChange(false,1));assert.equal((await f.store.select('棋盘','task:new')).entries[0].experience.id,entry.id);
  const events=(await f.history.log.query({kinds:['agent/experience-reuse-updated'],limit:10})).events;assert.deepEqual(events.map(e=>e.payload.paused),[true,false]);
});

test('a pause wins over an in-flight source lookup and failed durable changes do not report success',async t=>{
  const f=await fixture(t);await f.store.adopt(adoption);f.failReuse=true;await assert.rejects(f.store.setReuse(reuseChange(true)),/injected/);f.failReuse=false;
  assert.equal((await f.store.list()).reuse.paused,false);
  let release;f.reviewGate=new Promise(resolve=>release=resolve);const selecting=f.store.select('棋盘','task:new');
  while(!f.reviewEntered)await new Promise(resolve=>setTimeout(resolve,1));
  await f.store.setReuse(reuseChange(true));release();assert.deepEqual((await selecting).entries,[]);f.reviewGate=null;
  const duplicated=await f.store.setReuse(reuseChange(true,1));assert.equal(duplicated.revision,1);
});

test('corrupt pause records fail closed and cancellation/disposal cannot append a late switch',async t=>{
  for(const mode of ['cancel','dispose']){
    const f=await fixture(t);let release;f.artifactGate=new Promise(resolve=>release=resolve);const abort=new AbortController();
    const pending=f.store.setReuse(reuseChange(true),abort.signal),rejected=assert.rejects(pending);
    while(!f.artifactEntered)await new Promise(resolve=>setTimeout(resolve,1));
    const disposing=mode==='dispose'?f.store.dispose():null;if(mode==='cancel')abort.abort();release();await rejected;await disposing;
    assert.equal((await f.history.log.query({kinds:['agent/experience-reuse-updated'],limit:10})).events.length,0);
  }
  const f=await fixture(t);await f.store.adopt(adoption);await f.store.setReuse(reuseChange(true));
  const bad=await f.history.log.putArtifact({schemaVersion:99});await f.history.log.append({kind:'agent/experience-reuse-updated',severity:'info',source:'test',correlation:{projectId:'project:a'},payload:{revision:2,paused:false},artifactRefs:[bad.id]});
  await f.reopen();assert.match((await f.store.list()).reuseError,/损坏/);await assert.rejects(f.store.select('棋盘','task:new'),/损坏/);await assert.rejects(f.store.setReuse(reuseChange(false,1)),/损坏/);
});

test('review-confirmed advice is idempotent, revision guarded, bounded, disableable and portable with its source',async t=>{
  const f=await fixture(t); assert.equal((await f.store.select('创建棋盘','task:new')).entries.length,0);
  const entry=await f.store.adopt(adoption);assert.equal(f.changes,1);
  assert.deepEqual(await f.store.adopt(adoption),entry);assert.equal(f.changes,1);
  assert.equal((await f.store.select('请创建棋盘','task:new')).entries[0].experience.id,entry.id);
  assert.equal((await f.store.select('添加音乐','task:new')).entries.length,0);
  assert.equal((await f.store.select('创建棋盘','task:source')).entries.length,0,'source task cannot feed its own advice back to itself');
  await assert.rejects(f.store.update(entry.id,2,false,draft),/已变化/);
  const disabled=await f.store.update(entry.id,1,false,draft);assert.equal(disabled.revision,2);
  assert.equal((await f.store.select('创建棋盘','task:new')).entries.length,0);
  assert.equal((await f.store.adopt(adoption)).enabled,false,'duplicate adoption cannot resurrect disabled advice');
  await f.reopen();assert.equal((await f.store.list()).entries[0].enabled,false);
  await f.store.update(entry.id,2,true,{...draft,recommendation:'检查 XZ 平面，并使用当前工具版本验证。'});
  const selected=await f.store.select('创建棋盘','task:new');assert.match(selected.entries[0].experience.recommendation,/XZ/);
  await f.store.setReuse(reuseChange(true));
  const copied=path.join(f.root,'copied');await f.history.flush();await cp(f.directory,copied,{recursive:true});
  const fresh=await OperationLog.open({rootDirectory:path.join(f.root,'fresh'),appVersion:'test'});
  const archive=await ProjectAgentHistory.open({projectId:'project:a',directory:copied,source:fresh,storage:'project'});
  const restored=new ProjectExperiences({projectId:'project:a',log:archive.log,busy:()=>false,review:async()=>report,flush:()=>archive.flush(),changed:()=>{}});
  try{const list=await restored.list();assert.equal(list.entries[0].revision,3);assert.equal(list.reuse.paused,true);assert.deepEqual((await restored.select('棋盘','task:new')).entries,[]);assert.equal((await archive.log.readArtifact(list.entries[0].source.reviewArtifactId)).value.sourceDigest,report.sourceDigest);}finally{await restored.dispose();await archive.dispose();await fresh.close();}
});

test('foreign, stale, incomplete or fabricated review evidence cannot become active experience',async t=>{
  const f=await fixture(t);
  for(const value of [{...adoption,projectId:'project:b'},{...adoption,taskId:'task:foreign'},{...adoption,reviewDigest:'b'.repeat(64)},{...adoption,finding:{...finding,recommendation:'fabricated'}}]) await assert.rejects(f.store.adopt(value));
  f.report={...report,coverage:{...report.coverage,partial:true}};await assert.rejects(f.store.adopt(adoption),/证据/);
  f.report=report;f.busy=true;await assert.rejects(f.store.adopt(adoption),/等待/);f.busy=false;
  await f.store.adopt(adoption);f.report={...report,taskRevision:4,sourceDigest:'b'.repeat(64)};
  assert.equal((await f.store.select('棋盘','task:new')).entries.length,0,'resumed source invalidates reuse');
});

test('selection caps count/bytes and does not rank unrelated advice into the context',async t=>{
  const f=await fixture(t);
  for(let i=0;i<6;i++) {const next={...finding,title:`棋盘发现 ${i}`};f.report={...report,findings:[next]};await f.store.adopt({...adoption,finding:next,draft:{...draft,title:`棋盘经验 ${i}`}});}
  f.report=report;
  const result=await f.store.select('棋盘','task:new');assert.equal(result.entries.length,3);assert.ok(Buffer.byteLength(JSON.stringify(result.entries))<=12000);
  assert.equal((await f.store.select('音乐音量','task:new')).entries.length,0);
});

test('prepared context contains source-bound advice, audits actual citations and recreates provider session after disabling it',async t=>{
  const f=await fixture(t);const entry=await f.store.adopt(adoption);const context=new PromptContextRuntime(f.log);
  const project={projectId:'project:a',documentId:'document:a',revision:1,manifest:{name:'A'}};
  const input={conversationKey:'conversation:a',backendId:'backend:a',taskId:'task:new',request:'棋盘',tools:[],project};
  const selection=await f.store.select(input.request,input.taskId);
  const first=await context.prepare({...input,experiences:selection});assert.match(first.prompt,/Optional historical project advice/);assert.match(first.prompt,/棋盘朝向/);
  await context.assertReadable(first.contextArtifactIds);
  const audit=(await f.log.query({kinds:['agent/experience-context-prepared'],limit:50})).events.at(-1);
  assert.deepEqual(audit.payload.experienceIds,[entry.id]);const artifact=await f.log.readArtifact(audit.artifactRefs[0]);assert.equal(artifact.value.selection.libraryArtifactId,selection.libraryArtifactId);
  await context.commit({...input,sessionId:'session:a',turnId:'turn:1',projectId:'project:a'});
  assert.equal((await context.prepare({...input,experiences:selection})).reusedSessionId,'session:a');
  await f.store.update(entry.id,1,false,draft);
  const next=await context.prepare({...input,experiences:await f.store.select(input.request,input.taskId)});
  assert.equal(next.reusedSessionId,null);assert.doesNotMatch(next.prompt,/棋盘朝向/);
  const uses=await f.store.list();assert.equal(uses.uses.filter(u=>u.experienceIds.includes(entry.id)).length,2);
  await assert.rejects(context.prepare({...input,project:{...project,projectId:'project:b'},experiences:selection}),/active project/);
});

test('corrupt newest snapshot fails closed instead of reviving an older enabled entry',async t=>{
  const f=await fixture(t);await f.store.adopt(adoption);
  const bad=await f.history.log.putArtifact({schemaVersion:999});await f.history.log.append({kind:'agent/experience-library-updated',severity:'info',source:'test',correlation:{projectId:'project:a'},payload:{revision:2},artifactRefs:[bad.id]});
  await f.reopen();assert.match((await f.store.list()).error,/损坏/);await assert.rejects(f.store.select('棋盘','task:new'),/损坏/);
});

test('cancel/dispose during review validation cannot save late advice',async t=>{
  for(const mode of ['cancel','dispose']){
    const f=await fixture(t);let release;f.reviewGate=new Promise(resolve=>release=resolve);
    const abort=new AbortController();const pending=f.store.adopt(adoption,abort.signal);const rejected=assert.rejects(pending);
    while(!f.reviewEntered)await new Promise(resolve=>setTimeout(resolve,1));
    const disposing=mode==='dispose'?f.store.dispose():null;if(mode==='cancel')abort.abort();release();await rejected;await disposing;
    const events=await f.history.log.query({kinds:['agent/experience-library-updated'],limit:10});assert.equal(events.events.length,0);assert.equal(f.changes,0);
  }
});

test('context budget omits whole optional advice without reporting it as cited or cutting required context',async t=>{
  const f=await fixture(t);await f.store.adopt(adoption);const experiences=await f.store.select('棋盘','task:new');
  const context=new PromptContextRuntime(f.log,undefined,undefined,{compactContext:false});const facts=Array.from({length:12},(_,i)=>i+':'+'v'.repeat(495));
  await context.commit({conversationKey:'conversation:large',backendId:'backend:a',taskId:'task:history',sessionId:'session:large',turnId:'turn:large',projectId:null,goals:facts,decisions:facts,toolFacts:facts,acceptance:facts,blockers:facts});
  const tools=Array.from({length:22},(_,i)=>({id:'tool:long-'+i,description:'d'.repeat(1000),inputSchema:{type:'object'}}));
  const prepared=await context.prepare({conversationKey:'conversation:large',backendId:'backend:a',taskId:'task:new',request:'r'.repeat(32000),tools,experiences,project:{projectId:'project:a',documentId:'document:a',revision:4,manifest:{},exact:{query:({revision})=>({revision,items:[{id:'entity:one',value:{name:'SCENE_DETAIL'.repeat(1000)}}],truncated:false}),diff(){throw new Error('unexpected');}}}});
  assert.ok(Buffer.byteLength(prepared.prompt)<=98304);assert.doesNotMatch(prepared.prompt,/棋盘朝向|SCENE_DETAIL/);assert.ok(prepared.prompt.endsWith('r'.repeat(32000)));assert.match(prepared.prompt,/Work only through the supplied Studio tools/);
  assert.equal((await f.log.query({kinds:['agent/experience-context-prepared'],limit:10})).events.length,0);
});

const archiveChange=(entry,libraryRevision,action='archive')=>({schemaVersion:1,projectId:'project:a',id:entry.id,expectedRevision:entry.revision,libraryRevision,action});
test('archive contracts reject extra fields, secrets, unknown versions and malformed paging',()=>{
 const command=archiveChange(valid,1),record={schemaVersion:1,projectId:'project:a',archivedAt:at,experience:valid};
 assert.deepEqual(parseExperienceArchiveChange(command),command);assert.deepEqual(parseExperienceArchive(record),record);
 assert.deepEqual(parseExperienceHistoryQuery({projectId:'project:a',cursor:'12:20'}),{projectId:'project:a',cursor:'12:20'});
 for(const patch of [{schemaVersion:9},{id:'SECRET_CANARY'},{action:'delete'},{libraryRevision:-1},{expectedRevision:0},{path:'C:/arbitrary'}])assert.throws(()=>parseExperienceArchiveChange({...command,...patch}));
 for(const patch of [{schemaVersion:9},{projectId:'project:b'},{archivedAt:'invalid'},{experience:{...valid,title:'api_key=CANARY'}},{extra:true}])assert.throws(()=>parseExperienceArchive({...record,...patch}));
 for(const cursor of ['-1:20','1:9999999999999999999999','SECRET_CANARY',{},null])assert.throws(()=>parseExperienceHistoryQuery({projectId:'project:a',cursor}));
 assert.throws(()=>parseExperienceHistoryQuery({projectId:'project:a',limit:10000}));
});
test('archive frees working capacity, pages retained advice and restores from copied project evidence',async t=>{
 const f=await fixture(t),first=await f.store.adopt(adoption);
 const entries=Array.from({length:100},(_,i)=>({...first,id:'experience:seed:'+i}));
 const library=await f.history.log.putArtifact({schemaVersion:1,projectId:'project:a',revision:2,entries});
 await f.history.log.append({kind:'agent/experience-library-updated',severity:'info',source:'test',correlation:{projectId:'project:a'},payload:{revision:2},artifactRefs:[library.id]});await f.reopen();
 await assert.rejects(f.store.adopt(adoption),/100/);
 let revision=2;
 for(const entry of entries.slice(0,21)){await f.store.archive(archiveChange(entry,revision++));}
 const page=await f.store.archivePage();assert.equal(page.records.length,20);assert.equal(page.total,21);assert.equal((await f.store.archivePage(page.nextCursor)).records.length,1);
 const next=await f.store.adopt(adoption);assert.equal((await f.store.list()).entries.length,80);
 await assert.rejects(f.store.archivePage(page.nextCursor),/已变化/);
 await f.store.archive(archiveChange(next,++revision));await assert.rejects(f.store.adopt(adoption),/已归档/);
 await f.reopen();assert.equal((await f.store.archivePage()).total,22);assert.ok((await f.store.select('棋盘','task:new')).entries.every(e=>!entries.slice(0,21).some(a=>a.id===e.experience.id)));
 const copied=path.join(f.root,'archive-copy');await f.history.flush();await cp(f.directory,copied,{recursive:true});const fresh=await OperationLog.open({rootDirectory:path.join(f.root,'archive-global'),appVersion:'test'});
 const saved=await ProjectAgentHistory.open({projectId:'project:a',directory:copied,source:fresh,storage:'project'});
 const store=new ProjectExperiences({projectId:'project:a',log:saved.log,busy:()=>false,review:async()=>report,flush:()=>saved.flush(),changed:()=>{}});
 try{const archives=await store.archivePage();const archived=archives.records[0].archive;assert.equal(archived.experience.id,next.id);assert.equal((await saved.log.readArtifact(archived.experience.source.reviewArtifactId)).value.sourceDigest,report.sourceDigest);
 const restored=await store.archive(archiveChange(archived.experience,archives.revision,'restore'));assert.equal(restored.revision,next.revision+2);assert.equal((await store.archivePage()).total,21);assert.ok((await store.list()).entries.some(e=>e.id===next.id));
 }finally{await store.dispose();await saved.dispose();await fresh.close();}
});
test('archive commits atomically and rejects stale, busy, foreign or cancelled writes',async t=>{
 const f=await fixture(t),entry=await f.store.adopt(adoption),command=archiveChange(entry,1);
 f.failArchive=true;await assert.rejects(f.store.archive(command),/injected/);f.failArchive=false;assert.equal((await f.store.archivePage()).total,0);assert.equal((await f.store.list()).entries.length,1);
 f.busy=true;await assert.rejects(f.store.archive(command),/等待/);f.busy=false;
 await assert.rejects(f.store.archive({...command,projectId:'project:b'}),/项目/);await assert.rejects(f.store.archive({...command,expectedRevision:99}),/已变化/);
 let release;f.artifactGate=new Promise(r=>release=r);const abort=new AbortController(),pending=f.store.archive(command,abort.signal),rejected=assert.rejects(pending);while(!f.artifactEntered)await new Promise(r=>setTimeout(r,1));abort.abort();release();await rejected;f.artifactGate=null;
 assert.equal((await f.store.archivePage()).total,0);await f.store.archive(command);await f.reopen();assert.equal((await f.store.list()).entries.length,0);assert.equal((await f.store.archivePage()).total,1);
});

test('damaged archives remain discoverable without resurrecting removed advice',async t=>{
 const f=await fixture(t),entry=await f.store.adopt(adoption),command=archiveChange(entry,1);
 const library=await f.history.log.putArtifact({schemaVersion:1,projectId:'project:a',revision:2,entries:[]}),broken=await f.history.log.putArtifact({schemaVersion:99});
 await f.history.log.append({kind:'agent/experience-library-updated',severity:'info',source:'test',correlation:{projectId:'project:a'},payload:{revision:2,archive:command},artifactRefs:[library.id,broken.id]});await f.reopen();
 const page=await f.store.archivePage();assert.equal(page.total,1);assert.match(page.records[0].error,/损坏/);assert.deepEqual((await f.store.select('棋盘','task:new')).entries,[]);
 await assert.rejects(f.store.archive({...command,action:'restore',libraryRevision:2}));await assert.rejects(f.store.adopt(adoption),/已归档/);
});


test('structured matching rules preserve legacy data and reject invalid, unknown-version and secret-bearing rules',()=>{
 const matching={schemaVersion:1,minimumMatches:2,requiredKeywords:['棋盘'],excludedKeywords:['音乐']};
 assert.deepEqual(parseExperienceDraft({...draft,matching}).matching,matching);
 assert.deepEqual(parseAgentExperience({...valid,matching}).matching,matching);
 for(const patch of [{schemaVersion:2},{minimumMatches:0},{minimumMatches:3},{minimumMatches:1.5},{requiredKeywords:['旋转']},{requiredKeywords:['棋盘','棋盘']},{excludedKeywords:['棋盘']},{excludedKeywords:['api_key=CANARY']},{excludedKeywords:['SECRET_CANARY']},{extra:true}])assert.throws(()=>parseExperienceDraft({...draft,matching:{...matching,...patch}}));
 assert.throws(()=>parseExperienceDraft({...draft,keywords:['Canvas','ＣＡＮＶＡＳ'],matching:{...matching,requiredKeywords:[]}}));
 assert.deepEqual(parseExperienceDraft(draft),draft);
});

test('matching distinguishes near misses, negation, whole phrases, tool identifiers and independent evidence',async()=>{
 const {matchExperience}=await import('../dist/experience-matching.js');
 const matches=(keywords,request,matching)=>!!matchExperience({...draft,keywords,...(matching?{matching}:{})},request);
 const rules={schemaVersion:1,minimumMatches:2,requiredKeywords:['棋盘'],excludedKeywords:['海报']};
 for(const request of ['创建水平棋盘','旋转棋盘到水平面'])assert.equal(matches(['棋盘','水平'],request,rules),true,request);
 for(const request of ['修改棋盘配色','创建水平按钮','创建水平棋盘海报','不要创建水平棋盘','棋盘不需要创建'])assert.equal(matches(['棋盘','水平'],request,rules),false,request);
 for(const request of ['create a canvas texture','ＣＡＮＶＡＳ texture','不要忘记 canvas','not only canvas','do not forget canvas','no audio, create canvas','no audio\ncreate canvas','不要 canvas，但是创建 canvas'])assert.equal(matches(['canvas'],request),true,request);
 for(const request of ['canvaslike','no canvas','without using canvas','do not create canvas','不要使用 canvas','不需要创建 canvas'])assert.equal(matches(['canvas'],request),false,request);
 assert.equal(matches(['canvas texture'],'recanvas texture'),false);
 assert.equal(matches(['canvas texture'],'CANVAS   texture'),true);
 assert.equal(matches(['scene.create'],'scene.createMany'),false);
 assert.equal(matches(['scene.create'],'scene.create.batch'),false);
 assert.equal(matches(['scene.create'],'other.scene.create'),false);
 assert.equal(matches(['scene.create'],'call scene.create now'),true);
 assert.equal(matches(['棋盘','水平棋盘'],'水平棋盘',{...rules,requiredKeywords:[],excludedKeywords:[]}),false,'overlapping words are one vote');
 assert.equal(matches(['棋盘','水平'],'创建水平棋盘，不需要海报',rules),true,'negated exclusion is not an affirmative exclusion');
 assert.equal(matches(['旋转'],'棋盘不能旋转'),true,'a defect is not a request to exclude its repair');
});

test('structured applicability survives save/restart and context stops reusing an unmatched experience',async t=>{
 const f=await fixture(t);const matching={schemaVersion:1,minimumMatches:2,requiredKeywords:['棋盘'],excludedKeywords:['海报']};
 const entry=await f.store.adopt({...adoption,draft:{...draft,keywords:['棋盘','水平'],matching}});
 await f.reopen();assert.deepEqual((await f.store.list()).entries[0].matching,matching);
 for(const request of ['棋盘配色','不要创建水平棋盘','水平棋盘海报'])assert.deepEqual((await f.store.select(request,'task:new')).entries,[]);
 const selected=await f.store.select('创建水平棋盘','task:new');assert.deepEqual(selected.entries[0].matchedKeywords,['棋盘','水平']);assert.deepEqual(parseExperienceSelection(selected),selected);
 const context=new PromptContextRuntime(f.log),input={conversationKey:'conversation:matching',backendId:'backend:a',taskId:'task:new',request:'创建水平棋盘',tools:[],project:{projectId:'project:a',documentId:'document:a',revision:1,manifest:{}}};
 await context.prepare({...input,experiences:selected});await context.commit({...input,sessionId:'session:matching',turnId:'turn:matching',projectId:'project:a'});
 const next=await context.prepare({...input,request:'棋盘配色',experiences:await f.store.select('棋盘配色','task:new')});assert.equal(next.reusedSessionId,null);assert.doesNotMatch(next.prompt,/棋盘朝向/);
 await f.store.update(entry.id,1,true,draft);assert.equal((await f.store.list()).entries[0].matching,undefined,'replacing a draft can remove its rules');
});

test('specific relevant phrases rank above a loose keyword collection regardless of edit recency',async t=>{
 const f=await fixture(t);const findings=[];
 for(const [i,keywords] of [['broad',['棋盘','水平','旋转','工具','游戏','修改']],['generic',['游戏']],['precise',['水平棋盘']]]){
  const next={...finding,title:i};findings.push(next);f.report={...report,findings:[...findings]};await f.store.adopt({...adoption,finding:next,draft:{...draft,title:i,keywords}});
 }
 const selected=await f.store.select('旋转水平棋盘游戏','task:new');assert.equal(selected.entries[0].experience.title,'precise');
});


test('long repetitive requests do not turn one repeated word into multiple matching signals',async()=>{
 const {matchExperience}=await import('../dist/experience-matching.js');
 const request='canvas '.repeat(4500);
 assert.deepEqual(matchExperience({...draft,keywords:['canvas']},request).matchedKeywords,['canvas']);
 assert.equal(matchExperience({...draft,keywords:['canvas','texture'],matching:{schemaVersion:1,minimumMatches:2,requiredKeywords:[],excludedKeywords:[]}},request),null);
 assert.equal(matchExperience({...draft,keywords:['canvas']},'no canvas '.repeat(3000)),null);
});
