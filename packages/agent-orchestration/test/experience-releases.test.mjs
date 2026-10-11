import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { OperationLog, ProjectAgentHistory } from '@haiyue/ai-studio-operation-log';
import { PromptContextRuntime } from '@haiyue/ai-studio-agent-runtime';
import { parseExperienceOptimizationCommand, parseExperienceOptimizationState, parseExperienceSelection, parseExperienceValidation } from '@haiyue/ai-studio-contracts';
import { ProjectExperiences } from '../dist/project-experiences.js';

const at='2026-10-11T00:00:00.000Z';
const finding={code:'tool-failure',severity:'warning',title:'Read revision first',detail:'A stale revision was used.',recommendation:'Read the current revision before editing.',recordIds:['record:1']};
const report={schemaVersion:1,ruleVersion:'1.0.0',projectId:'project:a',taskId:'task:source',taskRevision:3,title:'Make board',outcome:'blocked',generatedAt:at,sourceDigest:'a'.repeat(64),coverage:{records:1,missing:0,partial:false,omittedEvidence:0},metrics:{toolCalls:1,failed:1,cancelled:0,suspended:0,repeatedFailures:0,userMessages:1,durationMs:100,repairs:0},findings:[finding],evidence:[{recordId:'record:1',kind:'tool-result',toolId:'scene.create',status:'failed',startedAt:at,durationMs:20}],deep:null};
const draft={title:'Revision advice',condition:'Editing a board',recommendation:'Read current revision before editing.',keywords:['board']};
const adoption={schemaVersion:1,projectId:'project:a',taskId:'task:source',reviewDigest:report.sourceDigest,findingSource:'rules',finding,draft};
const command={schemaVersion:1,projectId:'project:a',expectedRevision:0,action:'create',title:'Optimize board advice'};
const aiReport={...report,taskId:'task:new-source',sourceDigest:'c'.repeat(64)};
const aiSuggestion={schemaVersion:1,summary:'为新的任务证据整理精确的候选建议，效果待验证。',proposals:[{findingIndex:0,draft:{...draft,title:'Chess advice',keywords:['chess']},positiveRequest:'Make chess',negativeRequest:'Add music'}]};
async function analysisResult(f,value=aiSuggestion){const artifact=await f.history.log.putArtifact({fixture:'accounting'},{schemaVersion:'fixture/1'});return {value,metadata:{createdAt:at,backendId:'backend:fixture',model:'fixture-model',usageLabel:'输入 100 · 输出 50',accountingArtifactId:artifact.id}};}
async function appendReview(f,value=aiReport){f.report=value;const artifact=await f.history.log.putArtifact(value,{schemaVersion:'agent-task-review/1'});await f.history.log.append({kind:'agent/task-review',severity:'info',source:'test',correlation:{projectId:value.projectId},payload:{taskId:value.taskId,taskRevision:value.taskRevision,sourceDigest:value.sourceDigest},artifactRefs:[artifact.id]});await f.history.flush();f.store.observeSuggestions();}
async function autoUntil(f,predicate){const deadline=Date.now()+7000;for(;;){const view=await f.store.optimizations();if(predicate(view))return view;if(Date.now()>deadline)throw new Error('auto timeout: '+JSON.stringify(view.automatic));await new Promise(r=>setTimeout(r,10));}}
async function fixture(t,suggest,adopt=true){
  const root=await mkdtemp(path.join(tmpdir(),'haiyue-releases-'));
  const log=await OperationLog.open({rootDirectory:path.join(root,'global'),appVersion:'test'});
  const directory=path.join(root,'project','.aistudio','agent');
  let history=await ProjectAgentHistory.open({projectId:'project:a',directory,source:log,storage:'project'});
  let current=report,busy=false,gate=null,entered=false,failAppend=false;
  const artifactOverrides=new Map();
  const create=()=>new ProjectExperiences({projectId:'project:a',log:{...history.log,readArtifact:async id=>{const artifact=await history.log.readArtifact(id);return artifactOverrides.has(id)?{...artifact,value:artifactOverrides.get(id)}:artifact;},append:async(...args)=>{if(failAppend&&args[0].kind==='agent/experience-optimization-updated')throw new Error('injected append failure');return history.log.append(...args);}},busy:()=>busy,
    suggest,review:async taskId=>{entered=true;await gate;return suggest && taskId===report.taskId ? report : current;},flush:()=>history.flush(),changed:()=>{}});
  let store=create();await store.initialize();const entry=adopt?await store.adopt(adoption):null;
  t.after(async()=>{await store.dispose();await history.dispose();await log.close();await rm(root,{recursive:true,force:true});});
  return {root,log,directory,entry,artifactOverrides,get store(){return store;},get history(){return history;},set report(v){current=v;},set busy(v){busy=v;},set gate(v){gate=v;entered=false;},get entered(){return entered;},set failAppend(v){failAppend=v;},
    async run(action,signal){const state=(await store.optimizations()).state;return store.optimize({schemaVersion:1,projectId:'project:a',expectedRevision:state.revision,...action},signal);},
    async reopen(){await store.dispose();await history.dispose();history=await ProjectAgentHistory.open({projectId:'project:a',directory,source:log,storage:'project'});store=create();await store.initialize();}};
}
async function candidate(f){
  await f.run({action:'create',title:'More precise applicability'});
  await f.run({action:'edit',experienceId:f.entry.id,enabled:true,draft:{...draft,keywords:['chess'],recommendation:'Inspect the current revision and reuse only unchanged read results.'}});
  return f.run({action:'cases',cases:[{id:'case:positive',request:'Make a chess game',expectedIds:[f.entry.id]},{id:'case:negative',request:'Make a board poster',expectedIds:[]}]});
}

test('project pause overrides published advice while retaining candidates, regression validation and rollback',async t=>{
  const f=await fixture(t);await candidate(f);await f.run({action:'validate'});const published=await f.run({action:'publish'});
  f.busy=true;await f.store.setReuse({schemaVersion:1,projectId:'project:a',expectedRevision:0,paused:true});
  assert.deepEqual((await f.store.optimizations()).state,published.state);assert.deepEqual((await f.store.select('chess','task:new')).entries,[]);
  await f.reopen();f.busy=false;await f.run({action:'create',title:'Refine while paused'});
  await f.run({action:'edit',experienceId:f.entry.id,enabled:true,draft:{...draft,keywords:['chess'],recommendation:'Inspect revision and validate each changed object.'}});
  assert.equal((await f.run({action:'validate'})).evaluation.status,'pass');await f.run({action:'publish'});
  assert.deepEqual((await f.store.select('chess','task:new')).entries,[]);
  await f.run({action:'rollback',releaseId:published.state.activeReleaseId});assert.equal((await f.store.list()).reuse.paused,true);
  await f.store.setReuse({schemaVersion:1,projectId:'project:a',expectedRevision:1,paused:false});assert.equal((await f.store.select('chess','task:new')).entries.length,1);
});
test('optimization contracts validate exact actions, versions, source-independent drafts and secret-bearing payloads',()=>{
  assert.deepEqual(parseExperienceOptimizationCommand(command),command);
  for(const patch of [{schemaVersion:2},{expectedRevision:-1},{title:'api_key=CANARY'},{action:'execute'},{path:'C:/unsafe'},{projectId:'SECRET_CANARY'}])assert.throws(()=>parseExperienceOptimizationCommand({...command,...patch}));
  const cases={schemaVersion:1,projectId:'project:a',expectedRevision:1,action:'cases',cases:[{id:'case:a',request:'draw board',expectedIds:[]}]};
  assert.deepEqual(parseExperienceOptimizationCommand(cases),cases);
  assert.throws(()=>parseExperienceOptimizationCommand({...cases,cases:[...cases.cases,...cases.cases]}));
  assert.throws(()=>parseExperienceOptimizationCommand({...cases,cases:[{...cases.cases[0],request:'Bearer SECRET_CANARY'}]}));
  const state={schemaVersion:1,projectId:'project:a',revision:0,activeReleaseId:null,candidate:null,releases:[]};assert.deepEqual(parseExperienceOptimizationState(state),state);
  for(const patch of [{schemaVersion:2},{activeReleaseId:'release:missing'},{projectId:'SECRET_CANARY'},{revision:-1}])assert.throws(()=>parseExperienceOptimizationState({...state,...patch}));
  const extended={...state,regressionCases:cases.cases};assert.deepEqual(parseExperienceOptimizationState(extended),extended);
  for(const regressionCases of [null,[...cases.cases,...cases.cases],[{...cases.cases[0],request:'api_key=CANARY'}]])assert.throws(()=>parseExperienceOptimizationState({...state,regressionCases}));
});

test('project regression cases survive publish, discard, restart and rollback without inheriting validation or dropping failed expectations',async t=>{
  const f=await fixture(t);const original=(await candidate(f)).state.candidate.cases;
  await f.run({action:'validate'});const published=await f.run({action:'publish'});
  let view=await f.run({action:'create',title:'Next'});assert.deepEqual(view.state.candidate.cases,original);assert.equal(view.state.candidate.validation,null);
  const expanded=[...original,{id:'case:music',request:'Add music',expectedIds:[]}];
  await f.run({action:'cases',cases:expanded});await f.run({action:'discard'});await f.reopen();
  await f.run({action:'rollback',releaseId:published.state.releases[0].id});view=await f.run({action:'create',title:'After rollback'});
  assert.deepEqual(view.state.candidate.cases,expanded);assert.equal(view.state.candidate.validation,null);
  // Retained positive cases continue to fail when their expected advice is disabled.
  await f.run({action:'edit',experienceId:f.entry.id,enabled:false,draft});view=await f.run({action:'validate'});
  assert.equal(view.evaluation.status,'fail');assert.deepEqual(view.state.regressionCases,expanded);assert.equal(view.comparison.cases[0].afterPass,false);
  await assert.rejects(f.run({action:'publish'}),/验证/);
});

test('historical validation is immutable, read-only and available after restart and rollback without revalidating current sources',async t=>{
  const f=await fixture(t);await candidate(f);const checked=await f.run({action:'validate'}),published=await f.run({action:'publish'}),release=published.state.releases.at(-1);
  await f.run({action:'rollback',releaseId:published.state.releases[0].id});const restored=await f.run({action:'rollback',releaseId:release.id});await f.reopen();
  f.report={...report,sourceDigest:'b'.repeat(64)};
  const revision=(await f.store.optimizations()).state.revision,sequence=f.history.log.status().nextSequence;
  for(const id of [release.id,restored.state.activeReleaseId]){
    const saved=(await f.store.optimizations(id)).releaseReport;
    assert.equal(saved.error,null);assert.deepEqual(saved.evaluation,checked.evaluation);assert.deepEqual(saved.comparison,checked.comparison);
  }
  assert.equal((await f.store.optimizations()).state.revision,revision);assert.equal(f.history.log.status().nextSequence,sequence);
  assert.equal((await f.store.optimizations(published.state.releases[0].id)).releaseReport.evaluation,null);
  await assert.rejects(f.store.optimizations('release:foreign'),/版本不存在/);
});

test('legacy projects recover regression cases from saved reports even after rollback; legacy candidates keep saved cases when discarded',async t=>{
  const f=await fixture(t);const cases=(await candidate(f)).state.candidate.cases;
  await f.run({action:'validate'});const published=await f.run({action:'publish'});await f.run({action:'rollback',releaseId:published.state.releases[0].id});
  const legacy=async()=>{const {regressionCases,...old}=(await f.store.optimizations()).state;old.revision++;
    const artifact=await f.history.log.putArtifact(old,{schemaVersion:'agent-experience-optimization/1'});
    await f.history.log.append({kind:'agent/experience-optimization-updated',severity:'info',source:'test',correlation:{projectId:'project:a'},payload:{revision:old.revision},artifactRefs:[artifact.id]});await f.reopen();};
  await legacy();let view=await f.run({action:'create',title:'Legacy upgrade'});assert.deepEqual(view.state.candidate.cases,cases);
  await legacy();await f.run({action:'discard'});view=await f.run({action:'create',title:'After legacy discard'});assert.deepEqual(view.state.candidate.cases,cases);
});

test('historical report contracts reject unknown versions, secrets and mismatched artifacts without hiding release history',async t=>{
  const f=await fixture(t);await candidate(f);const checked=await f.run({action:'validate'}),published=await f.run({action:'publish'}),release=published.state.releases.at(-1);
  assert.deepEqual(parseExperienceValidation(checked.evaluation,checked.comparison),{evaluation:checked.evaluation,comparison:checked.comparison});
  for(const patch of [{schemaVersion:99},{evaluatorVersion:'99.0.0'},{completedAt:'invalid'},{taskId:'task:other'},{id:'SECRET_CANARY'},{path:'C:/unsafe'}])assert.throws(()=>parseExperienceValidation({...checked.evaluation,...patch},checked.comparison));
  const changed=structuredClone(checked.comparison);changed.cases[0].request='Bearer SECRET_CANARY';assert.throws(()=>parseExperienceValidation(checked.evaluation,changed));
  const inconsistent=structuredClone(checked.comparison);inconsistent.cases[0].afterIds=[];assert.throws(()=>parseExperienceValidation(checked.evaluation,inconsistent));
  const comparisonId=checked.state.candidate.validation.comparisonArtifactId;
  for(const bad of [null,{...checked.comparison,projectId:'project:foreign'},{...checked.comparison,candidateLibraryArtifactId:'artifact:foreign'},changed]){
    f.artifactOverrides.set(comparisonId,bad);const view=await f.store.optimizations(release.id);
    assert.equal(view.error,null);assert.match(view.releaseReport.error,/缺失、损坏/);assert.equal(view.releaseReport.evaluation,null);assert.equal(view.state.activeReleaseId,release.id);
  }
  f.artifactOverrides.clear();assert.equal((await f.store.optimizations(release.id)).releaseReport.evaluation.status,'pass');
});
test('candidate is isolated; M12 offline evidence gates publish; next context cites release and rollback creates a new version',async t=>{
  const f=await fixture(t);const context=new PromptContextRuntime(f.log);
  const input={conversationKey:'conversation:release',backendId:'backend:test',taskId:'task:next',request:'chess',tools:[],project:{projectId:'project:a',documentId:'document:a',revision:1,manifest:{name:'Test'}}};
  await candidate(f);
  assert.equal((await f.store.select('chess','task:next')).entries.length,0);assert.equal((await f.store.select('board','task:next')).entries.length,1);
  const before=await f.store.select('chess','task:next');await context.prepare({...input,experiences:before});await context.commit({...input,sessionId:'session:baseline',turnId:'turn:baseline',projectId:'project:a'});
  const validated=await f.run({action:'validate'});assert.equal(validated.evaluation.status,'pass');assert.equal(validated.comparison.cases[0].beforePass,false);assert.equal(validated.comparison.cases[0].afterPass,true);
  const ajv=new Ajv({strict:false});const schema=JSON.parse(await readFile(new URL('../../../config/contracts/schemas/m12-evaluation-result.schema.json',import.meta.url),'utf8'));assert.equal(ajv.validate(schema,validated.evaluation),true,JSON.stringify(ajv.errors));
  const task=(await f.history.log.readArtifact(validated.comparison.taskArtifactId)).value;assert.equal(task.schemaVersion,2);assert.equal(task.id,validated.evaluation.taskId);
  ajv.addSchema(JSON.parse(await readFile(new URL('../../../config/contracts/schemas/m12-capability-id.schema.json',import.meta.url),'utf8')));
  const taskSchema=JSON.parse(await readFile(new URL('../../../config/contracts/schemas/m12-task-spec.schema.json',import.meta.url),'utf8'));assert.equal(ajv.validate(taskSchema,task),true,JSON.stringify(ajv.errors));
  const published=await f.run({action:'publish'});assert.equal(published.state.candidate,null);assert.equal(published.state.releases.length,2);
  const selected=await f.store.select('chess','task:next');assert.equal(selected.releaseId,published.state.activeReleaseId);assert.deepEqual(parseExperienceSelection(selected),selected);assert.equal(selected.entries.length,1);
  const prepared=await context.prepare({...input,experiences:selected});assert.equal(prepared.reusedSessionId,null);assert.match(prepared.prompt,/Inspect the current revision/);
  const citations=(await f.log.query({kinds:['agent/experience-context-prepared'],limit:50})).events;assert.equal(citations.at(-1).payload.releaseId,selected.releaseId);
  await context.commit({...input,sessionId:'session:published',turnId:'turn:published',projectId:'project:a'});
  const bound=(await f.log.query({kinds:['agent/conversation-indexed'],limit:20})).events.at(-1);
  assert.equal(bound.payload.experienceAttribution.schemaVersion,1);assert.ok(bound.artifactRefs.includes(bound.payload.experienceAttribution.artifactId));
  assert.deepEqual((await f.log.readArtifact(bound.payload.experienceAttribution.artifactId)).value.selection,selected);
  assert.equal((await f.store.optimizations()).uses[0].releaseId,selected.releaseId);
  const baseline=published.state.releases[0];await f.run({action:'rollback',releaseId:baseline.id});assert.equal((await f.store.select('chess','task:next')).entries.length,0);assert.equal((await f.store.select('board','task:next')).entries.length,1);
  const rolled=(await f.store.optimizations()).state;assert.equal(rolled.releases.at(-1).kind,'rollback');assert.equal(rolled.releases.at(-1).number,3);assert.equal(rolled.releases.at(-1).restoredReleaseId,baseline.id);
  await f.reopen();assert.equal((await f.store.optimizations()).state.activeReleaseId,rolled.activeReleaseId);
});
test('missing changes, uncovered/negative cases and editing after validation cannot bypass publication gates',async t=>{
  const f=await fixture(t);await f.run({action:'create',title:'No changes'});await assert.rejects(f.run({action:'publish'}),/验证/);
  let view=await f.run({action:'validate'});assert.equal(view.evaluation.status,'fail');assert.ok(view.evaluation.acceptanceResults.some(r=>r.acceptanceId==='acceptance:changed'&&r.status==='fail'));
  await f.run({action:'discard'});await candidate(f);await f.run({action:'cases',cases:[{id:'case:only',request:'chess',expectedIds:[f.entry.id]}]});assert.equal((await f.run({action:'validate'})).evaluation.status,'fail');
  await f.run({action:'cases',cases:[{id:'case:a',request:'chess',expectedIds:[f.entry.id]},{id:'case:b',request:'unrelated request',expectedIds:[]}]});assert.equal((await f.run({action:'validate'})).evaluation.status,'pass');
  view=await f.run({action:'edit',experienceId:f.entry.id,enabled:true,draft});assert.equal(view.state.candidate.validation,null);await assert.rejects(f.run({action:'publish'}),/验证/);
});
test('source changes, working-library changes, busy owners and cross-project inputs fail closed',async t=>{
  const f=await fixture(t);await candidate(f);await f.run({action:'validate'});f.report={...report,taskRevision:4,sourceDigest:'b'.repeat(64)};
  await assert.rejects(f.run({action:'publish'}),/已变化/);assert.equal((await f.store.select('board','task:next')).entries.length,0);
  f.report=report;await f.store.update(f.entry.id,1,false,draft);await assert.rejects(f.run({action:'publish'}),/已变化/);assert.equal((await f.run({action:'validate'})).evaluation.status,'fail');
  f.busy=true;await assert.rejects(f.run({action:'discard'}),/等待/);f.busy=false;
  const state=(await f.store.optimizations()).state;await assert.rejects(f.store.optimize({schemaVersion:1,projectId:'project:b',expectedRevision:state.revision,action:'discard'}),/项目/);
  assert.equal((await f.store.optimizations()).state.revision,state.revision);
});
test('concurrent commands and failed durable commit preserve exactly one active version',async t=>{
  const f=await fixture(t);const results=await Promise.allSettled([f.store.optimize(command),f.store.optimize(command)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await f.run({action:'discard'});await candidate(f);await f.run({action:'validate'});const before=(await f.store.optimizations()).state;
  f.failAppend=true;await assert.rejects(f.run({action:'publish'}),/injected/);f.failAppend=false;
  assert.equal((await f.store.optimizations()).state.activeReleaseId,before.activeReleaseId);assert.equal((await f.store.select('chess','task:next')).entries.length,0);
  await f.run({action:'publish'});assert.equal((await f.store.select('chess','task:next')).entries.length,1);
});
test('cancelled validation and disposed ownership cannot append late results',async t=>{
  const f=await fixture(t);await candidate(f);const before=(await f.store.optimizations()).state.revision;
  let release;f.gate=new Promise(resolve=>release=resolve);const controller=new AbortController();const pending=f.run({action:'validate'},controller.signal);await until(()=>f.entered);controller.abort();release();await assert.rejects(pending);
  f.gate=null;assert.equal((await f.store.optimizations()).state.revision,before);
  let release2;f.gate=new Promise(resolve=>release2=resolve);const late=f.run({action:'validate'});await until(()=>f.entered);const disposed=f.store.dispose();release2();await assert.rejects(late);await disposed;
  f.gate=null;await f.reopen();assert.equal((await f.store.optimizations()).state.revision,before);
});
test('released refinements survive new candidates; working edits stay pending; stale rollback is refused',async t=>{
  const f=await fixture(t);await candidate(f);await f.run({action:'validate'});const published=await f.run({action:'publish'});
  let view=await f.run({action:'create',title:'Next revision'});assert.deepEqual(view.candidateEntries[0].keywords,['chess']);await f.run({action:'discard'});
  await f.store.update(f.entry.id,1,true,{...draft,keywords:['puzzle']});assert.equal((await f.store.select('puzzle','task:next')).entries.length,0);assert.equal((await f.store.select('chess','task:next')).entries.length,1);
  view=await f.run({action:'create',title:'Pending library changes'});assert.deepEqual(view.candidateEntries[0].keywords,['puzzle']);await assert.rejects(f.run({action:'rollback',releaseId:published.state.releases[0].id}),/放弃/);await f.run({action:'discard'});
  f.report={...report,sourceDigest:'b'.repeat(64)};await assert.rejects(f.run({action:'rollback',releaseId:published.state.releases[0].id}),/失效/);
});
test('portable project includes release snapshots, evaluation and source evidence; corrupt newest state never falls back to live advice',async t=>{
  const f=await fixture(t);await candidate(f);await f.run({action:'validate'});const published=await f.run({action:'publish'});await f.history.flush();
  const copy=path.join(f.root,'copy');await cp(f.directory,copy,{recursive:true});const log=await OperationLog.open({rootDirectory:path.join(f.root,'fresh'),appVersion:'test'});
  const history=await ProjectAgentHistory.open({projectId:'project:a',directory:copy,source:log,storage:'project'});
  const store=new ProjectExperiences({projectId:'project:a',log:history.log,busy:()=>false,review:async()=>report,flush:()=>history.flush(),changed:()=>{}});
  try{const view=await store.optimizations(published.state.activeReleaseId);assert.equal(view.state.activeReleaseId,published.state.activeReleaseId);assert.equal(view.releaseReport.evaluation.status,'pass');assert.deepEqual(view.state.regressionCases,published.state.regressionCases);assert.equal(view.releaseReport.comparison.cases.length,2);const selected=await store.select('chess','task:new');assert.equal(selected.entries.length,1);assert.equal((await history.log.readArtifact(view.state.releases.at(-1).evaluationArtifactId)).value.status,'pass');assert.equal((await history.log.readArtifact(selected.entries[0].experience.source.reviewArtifactId)).value.taskId,report.taskId);}finally{await store.dispose();await history.dispose();await log.close();}
  const bad=await f.history.log.putArtifact({schemaVersion:999});await f.history.log.append({kind:'agent/experience-optimization-updated',severity:'info',source:'test',correlation:{projectId:'project:a'},payload:{revision:99},artifactRefs:[bad.id]});
  await f.reopen();assert.match((await f.store.optimizations()).error,/损坏/);await assert.rejects(f.store.select('board','task:new'),/损坏/);await assert.rejects(f.run({action:'create',title:'Unsafe reset'}),/损坏/);
});
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Timed out waiting for validation');}

test('archiving overrides published advice and rollback without rewriting historical validations',async t=>{
 const f=await fixture(t);await candidate(f);await f.run({action:'validate'});const published=await f.run({action:'publish'});
 const historical=await f.store.optimizations(published.state.activeReleaseId),working=await f.store.list();
 await f.store.archive({schemaVersion:1,projectId:'project:a',id:f.entry.id,expectedRevision:f.entry.revision,libraryRevision:working.revision,action:'archive'});
 assert.deepEqual((await f.store.select('chess','task:new')).entries,[]);assert.deepEqual((await f.store.optimizations(published.state.activeReleaseId)).releaseReport,historical.releaseReport);
 await f.run({action:'rollback',releaseId:published.state.releases[0].id});assert.deepEqual((await f.store.select('board','task:new')).entries,[]);
 await f.run({action:'create',title:'Exclude archived advice'});await f.run({action:'cases',cases:[{id:'case:board',request:'board',expectedIds:[]},{id:'case:chess',request:'chess',expectedIds:[]}]});
 assert.equal((await f.run({action:'validate'})).evaluation.status,'pass');await f.run({action:'publish'});await f.reopen();assert.equal((await f.store.archivePage()).total,1);
 const page=await f.store.archivePage();await f.store.archive({schemaVersion:1,projectId:'project:a',id:f.entry.id,expectedRevision:page.records[0].archive.experience.revision,libraryRevision:page.revision,action:'restore'});
 assert.deepEqual((await f.store.select('board','task:new')).entries,[],'restoring a draft cannot change a release that removed it');
});

test('release history remains paged and readable after more than twenty releases and project restart',async t=>{
 const f=await fixture(t);await candidate(f);await f.run({action:'validate'});const published=await f.run({action:'publish'}),id=published.state.activeReleaseId,baseline=published.state.releases[0].id;
 const original=(await f.store.optimizations(id)).releaseReport;
 for(let i=0;i<21;i++)await f.run({action:'rollback',releaseId:i%2?id:baseline});
 await f.reopen();const first=await f.store.optimizations();assert.equal(first.state.releases.length,20);assert.equal(first.history.total,23);assert.equal(first.history.releases.length,20);
 assert.ok(!first.state.releases.some(r=>r.id===id));const page=await f.store.optimizations(undefined,first.history.nextCursor);assert.equal(page.history.releases.length,3);assert.equal(page.history.nextCursor,null);
 assert.deepEqual((await f.store.optimizations(id)).releaseReport,original);await f.run({action:'rollback',releaseId:id});assert.equal((await f.store.select('chess','task:new')).entries.length,1);
 await assert.rejects(f.store.optimizations(undefined,first.history.nextCursor),/已变化/);
});

async function effectTask(f,id,selections,{outcome='completed',partial=false,legacy=false,stale=false,tokens=null,model='model:a',changedModel=false}={}) {
 const log=f.history.log,taskId=`task:effect:${id}`,sessionId=`session:effect:${id}`;
 const append=async(kind,payload,value,correlation={})=>{const artifact=value?await log.putArtifact(value,{schemaVersion:'fixture/1'}):null;return log.append({kind,severity:'info',source:'test.effects',correlation:{projectId:'project:a',...correlation},payload,artifactRefs:artifact?[artifact.id]:[]});};
 const run={schemaVersion:1,revision:3,taskId,title:`Game task ${id}`,requestSummary:'Make game',status:outcome,phase:outcome==='completed'?'complete':'blocked',startedAt:at,updatedAt:at,backendId:'backend:a',sessionId,turnId:`turn:${id}:0`,model:{id:model,reasoningEffort:'medium',outputTokenLimit:1000},promptProfile:{id:'profile:a',version:'1.0.0',digest:`sha256:${'a'.repeat(64)}`},documentRevision:1,repairIteration:0,repairLimit:2,acceptance:[],evidence:[],timeline:[],terminalDiagnostic:null,resumable:false};
 for(let i=0;i<selections.length;i++){
  const turnId=`turn:${id}:${i}`;run.turnId=turnId;
  if(!legacy)await append('agent/task-turn-bound',{schemaVersion:1,taskId,backendId:'backend:a',config:{schemaVersion:2,backendId:'backend:a',model:changedModel?'model:changed':model,reasoningEffort:'medium',outputTokenLimit:1000,taskBudgetId:'budget:effects',promptProfile:run.promptProfile,requestedCapabilities:[]}},null,{sessionId,turnId});
  const artifact=await log.putArtifact({selection:selections[i]},{schemaVersion:'context-artifact/2'});
  await log.append({kind:'agent/conversation-indexed',severity:'info',source:'test.effects',correlation:{projectId:'project:a',sessionId,turnId},payload:{taskId,backendId:'backend:a',...(!legacy?{experienceAttribution:{schemaVersion:1,artifactId:artifact.id}}:{})},artifactRefs:[artifact.id]});
 }
 const r={...report,taskId,title:run.title,outcome,coverage:{...report.coverage,partial},metrics:{...report.metrics,toolCalls:10,failed:2,repeatedFailures:1,repairs:1,durationMs:1000}};
 await append('conversation/task-projected',{taskId,revision:stale?4:3,status:outcome},{...run,revision:stale?4:3},{sessionId,turnId:run.turnId});
 if(tokens){
  const existing={schemaVersion:2,id:'budget:effects',enforcement:'hard',limits:{inputTokens:100000,outputTokens:100000,estimatedCostMicros:null,wallTimeMs:100000,turns:100,toolCalls:100,repairIterations:10,observationBytes:100000}};
  await append('agent/task-accounting',{taskId},{taskId,budget:existing,budgetStatus:'within',usage:{inputTokens:tokens[0],cachedInputTokens:tokens[0],outputTokens:tokens[1],reasoningTokens:tokens[1],toolInputBytes:0,toolOutputBytes:0,wallTimeMs:1000},cost:{status:'unknown',amountMicros:null,currency:null,cacheSavingMicros:null,explanation:'Unknown',final:true}},{sessionId,turnId:run.turnId});
 }
 await append('agent/task-review',{taskId,taskRevision:3,sourceDigest:r.sourceDigest},r);
 return r;
}

test('real-task effects use actual turn attribution, exclude mixed and incomplete tasks, deduplicate reviews and survive restart',async t=>{
 const f=await fixture(t);await candidate(f);await f.run({action:'validate'});await f.run({action:'publish'});
 const selected=await f.store.select('chess','task:independent'),empty={schemaVersion:1,projectId:'project:a',libraryRevision:0,libraryArtifactId:null,entries:[]};
 await effectTask(f,'success',[selected],{tokens:[120,30]});await effectTask(f,'failure',[selected],{outcome:'failed'});
 await effectTask(f,'baseline',[empty]);await effectTask(f,'mixed',[selected,empty]);
 await effectTask(f,'changed-model',[selected],{changedModel:true});await effectTask(f,'partial',[selected],{partial:true});await effectTask(f,'old',[selected],{legacy:true});await effectTask(f,'resumed',[selected],{stale:true});
 await effectTask(f,'success',[selected],{tokens:[120,30]});
 let data=await f.store.effects();assert.equal(data.total,8);assert.equal(data.excluded,5,JSON.stringify(data.records.map(r=>[r.report.taskId,r.note])));assert.equal(data.groups.length,2);
 const group=data.groups.find(g=>g.label.startsWith('v2'));assert.equal(group.tasks,2);assert.equal(group.completed,1);assert.equal(group.failed,1);assert.equal(group.toolCalls,20);assert.equal(group.tokenSamples,1);assert.equal(group.inputTokens,120);assert.equal(group.outputTokens,30);assert.equal(group.durationMs,2000);
 assert.ok(data.records.find(r=>r.report.taskId.endsWith('mixed')).note.includes('跨版本'));
 await f.reopen();const reopened=await f.store.effects();assert.deepEqual(reopened.groups,data.groups);
 const latest=(await f.history.log.query({kinds:['agent/task-review'],limit:100})).events.at(-1);f.artifactOverrides.set(latest.artifactRefs[0],{...report,schemaVersion:9});
 const corrupt=await f.store.effects();assert.equal(corrupt.unreadable,1);assert.equal(corrupt.total,8);assert.equal(corrupt.groups.find(g=>g.label.startsWith('v2')).tasks,1);f.artifactOverrides.clear();
 const abort=new AbortController();abort.abort();await assert.rejects(f.store.effects(undefined,abort.signal));
});

test('effect history paginates, rejects stale cursors and validates contract versions and secret-bearing payloads',async t=>{
 const {parseExperienceEffects}=await import('@haiyue/ai-studio-contracts');const f=await fixture(t);
 const empty={schemaVersion:1,projectId:'project:a',libraryRevision:0,libraryArtifactId:null,entries:[]};
 for(let i=0;i<22;i++)await effectTask(f,String(i),[empty]);
 const first=await f.store.effects(),second=await f.store.effects(first.nextCursor);assert.equal(first.records.length,20);assert.equal(second.records.length,2);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.records,...second.records].map(r=>r.report.taskId)).size,22);
 assert.equal(parseExperienceEffects(first).total,22);
 for(const patch of [{schemaVersion:2},{excluded:99},{groups:[{...first.groups[0],model:'Bearer secret-value'}]},{records:[{...first.records[0],groupKey:'missing'}]}])assert.throws(()=>parseExperienceEffects({...first,...patch}));
 await effectTask(f,'late',[empty]);await assert.rejects(f.store.effects(first.nextCursor),/已变化/);
});

test('AI suggestions and status contracts reject unsupported versions, ambiguous sources and secrets',async()=>{
 const {parseExperienceSuggestion,parseExperienceAutoStatus}=await import('@haiyue/ai-studio-contracts');
 assert.deepEqual(parseExperienceSuggestion(aiSuggestion),aiSuggestion);
 for(const value of [{...aiSuggestion,schemaVersion:2},{...aiSuggestion,summary:'SECRET_CANARY'},{...aiSuggestion,proposals:[{...aiSuggestion.proposals[0],findingIndex:12}]},{...aiSuggestion,proposals:[...aiSuggestion.proposals,...aiSuggestion.proposals]},{...aiSuggestion,proposals:[{...aiSuggestion.proposals[0],negativeRequest:'Make chess'}]},{...aiSuggestion,execute:'scene.create'}])assert.throws(()=>parseExperienceSuggestion(value));
 const status={schemaVersion:1,projectId:'project:a',taskId:aiReport.taskId,taskRevision:3,sourceDigest:aiReport.sourceDigest,status:'running',summary:'正在整理',usageLabel:null};assert.deepEqual(parseExperienceAutoStatus(status),status);
 for(const patch of [{schemaVersion:2},{status:'publish'},{summary:'api_key=CANARY'},{sourceDigest:'bad'},{taskId:null},{extra:true}])assert.throws(()=>parseExperienceAutoStatus({...status,...patch}));
});

test('new evidence automatically creates an isolated candidate with sources and cases, survives restart and requires validation to publish',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return analysisResult(f);});
 await appendReview(f);let view=await autoUntil(f,v=>v.automatic.status==='completed');assert.equal(calls,1);assert.ok(view.state.candidate);assert.equal(view.candidateEntries.length,2);assert.equal(view.state.candidate.cases.length,2);assert.equal(view.state.candidate.validation,null);
 assert.equal((await f.store.select('Make chess','task:later')).entries.length,0);assert.equal((await f.store.list()).entries.length,1,'AI must not adopt into the live working library');
 await assert.rejects(f.run({action:'publish'}),/验证/);await f.reopen();f.store.observeSuggestions();view=await autoUntil(f,v=>v.automatic.status==='completed');assert.equal(calls,1);assert.ok(view.state.candidate);
 const result=await f.run({action:'validate'});assert.equal(result.evaluation.status,'pass',JSON.stringify(result.evaluation));await f.run({action:'publish'});assert.equal((await f.store.select('Make chess','task:later')).entries.length,1);
 await f.run({action:'create',title:'Next draft'});assert.equal((await f.store.optimizations()).candidateEntries.length,2,'published AI-only advice must survive subsequent candidates');
 await f.run({action:'discard'});await appendReview(f);await new Promise(r=>setTimeout(r,40));assert.equal(calls,1);assert.equal((await f.store.optimizations()).state.candidate,null,'discard is not permission to regenerate identical evidence');
});

test('existing candidates defer new evidence across restart without overriding user edits',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return analysisResult(f);});await candidate(f);const old=(await f.store.optimizations()).state.candidate;
 await appendReview(f);await autoUntil(f,v=>v.automatic.status==='waiting');assert.equal(calls,0);assert.deepEqual((await f.store.optimizations()).state.candidate,old);
 await f.reopen();f.store.observeSuggestions();await autoUntil(f,v=>v.automatic.status==='waiting');assert.equal(calls,0);
 // Existing case conflicts must fail, never silently replace saved regression expectations.
 await f.run({action:'discard'});await autoUntil(f,v=>['completed','failed'].includes(v.automatic.status));assert.equal(calls,1);
});

for(const mode of ['cancel','stale','manual','malformed','failure','empty'])test('automatic candidate handles '+mode+' without retrying or activating late advice',async t=>{
 let deliver,entered=false,calls=0;const f=await fixture(t,async()=>{calls++;entered=true;return new Promise((resolve,reject)=>{deliver=async()=>mode==='failure'?reject(new Error('SECRET_CANARY')):resolve(await analysisResult(f,mode==='malformed'?{...aiSuggestion,proposals:[{...aiSuggestion.proposals[0],findingIndex:10}]}:mode==='empty'?{...aiSuggestion,proposals:[]}:aiSuggestion));});});
 await appendReview(f);while(!entered)await new Promise(r=>setTimeout(r,5));
 if(mode==='cancel')f.store.cancelSuggestions();
 if(mode==='stale')f.report={...aiReport,sourceDigest:'d'.repeat(64)};
 if(mode==='manual')await f.run({action:'create',title:'Human candidate'});
 await deliver();const view=await autoUntil(f,v=>['failed','cancelled','none'].includes(v.automatic.status));assert.equal(view.state.candidate?.title??null,mode==='manual'?'Human candidate':null);
 assert.equal((await f.store.select('Make chess','task:later')).entries.length,0);assert.ok(!view.automatic.summary.includes('SECRET_CANARY'));
 f.store.observeSuggestions();await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);await f.reopen();f.store.observeSuggestions();await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);
});

test('partial evidence never invokes the model; disposed analysis cannot write a candidate into a different owner',async t=>{
 let deliver,entered=false,calls=0;const f=await fixture(t,async()=>{calls++;entered=true;return new Promise(resolve=>{deliver=async()=>resolve(await analysisResult(f));});});
 await appendReview(f,{...aiReport,coverage:{...aiReport.coverage,partial:true}});await new Promise(r=>setTimeout(r,40));assert.equal(calls,0);
 await appendReview(f);while(!entered)await new Promise(r=>setTimeout(r,5));const closing=f.store.dispose();await deliver();await closing;await f.reopen();assert.equal((await f.store.optimizations()).state.candidate,null);f.store.observeSuggestions();await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);
});

test('automatic candidates work without any adopted experience and keep published advice in later drafts',async t=>{
 const f=await fixture(t,()=>analysisResult(f),false);await appendReview(f);await autoUntil(f,v=>v.automatic.status==='completed');assert.equal((await f.store.list()).entries.length,0);assert.equal((await f.store.select('Make chess','task:later')).entries.length,0);
 assert.equal((await f.run({action:'validate'})).evaluation.status,'pass');await f.run({action:'publish'});assert.equal((await f.store.select('Make chess','task:later')).entries.length,1);
 const view=await f.run({action:'create',title:'Next'});assert.equal(view.error,null);assert.equal(view.candidateEntries.length,1);assert.equal(view.state.candidate.validation,null);
});
test('failed atomic candidate commit cannot freeze a baseline or partially activate generated advice',async t=>{
 let calls=0;const f=await fixture(t,()=>{calls++;return analysisResult(f);});f.failAppend=true;await appendReview(f);const view=await autoUntil(f,v=>v.automatic.status==='failed');assert.equal(view.state.candidate,null);assert.equal(view.state.activeReleaseId,null);assert.equal((await f.store.select('board','task:later')).entries.length,1);f.failAppend=false;f.store.observeSuggestions();await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);
});

test('published AI-only advice can be edited, disabled and archived through the existing experience lifecycle',async t=>{
 const f=await fixture(t,()=>analysisResult(f),false);await appendReview(f);await autoUntil(f,v=>v.automatic.status==='completed');await f.run({action:'validate'});await f.run({action:'publish'});
 let list=await f.store.list();assert.equal(list.entries.length,0);assert.equal(list.publishedEntries.length,1);const entry=list.publishedEntries[0];
 await f.store.archive({schemaVersion:1,projectId:'project:a',id:entry.id,expectedRevision:entry.revision,libraryRevision:list.revision,action:'archive'});assert.equal((await f.store.select('chess','task:later')).entries.length,0);assert.equal((await f.store.list()).publishedEntries.length,0);
 const archived=(await f.store.archivePage()).records[0].archive.experience;await f.store.archive({schemaVersion:1,projectId:'project:a',id:entry.id,expectedRevision:archived.revision,libraryRevision:(await f.store.list()).revision,action:'restore'});assert.equal((await f.store.select('chess','task:later')).entries.length,1);
 list=await f.store.list();assert.equal(list.publishedEntries.length,0);assert.equal(list.entries.length,1);
 await f.store.update(entry.id,list.entries[0].revision,false,{title:entry.title,condition:entry.condition,recommendation:entry.recommendation,keywords:entry.keywords});assert.equal((await f.store.select('chess','task:later')).entries.length,1,'working edits still need publication');
 await f.run({action:'create',title:'Disable advice'});assert.equal((await f.store.optimizations()).candidateEntries[0].enabled,false);
});

test('automatic backlog retains references and lazily reads only an unattempted report',async()=>{
 const {AutoExperienceCandidates}=await import('../dist/experience-auto.js');const events=[];let reads=0,changed=0;
 events.push({sequence:0,kind:'agent/experience-ai-enabled',correlation:{projectId:'project:a'},payload:{schemaVersion:1},artifactRefs:[]});
 for(let i=0;i<300;i++){
  const taskId='task:retained:'+i;
  events.push({sequence:events.length,kind:'agent/task-review',correlation:{projectId:'project:a'},payload:{taskId,taskRevision:3,sourceDigest:aiReport.sourceDigest},artifactRefs:['artifact:'+i]});
  if(i<200)events.push({sequence:events.length,kind:'agent/experience-ai-status',correlation:{projectId:'project:a'},payload:{schemaVersion:1,projectId:'project:a',taskId,taskRevision:3,sourceDigest:aiReport.sourceDigest,status:'none',summary:'没有新增建议',usageLabel:null},artifactRefs:[]});
 }
 const log={status:()=>({retainedFromSequence:0,nextSequence:events.length}),query:async q=>({events:events.filter(e=>q.kinds.includes(e.kind)&&(q.afterSequence===undefined||e.sequence>q.afterSequence)&&e.sequence<q.beforeSequence),nextCursor:null}),readArtifact:async()=>{reads++;throw new Error('Waiting backlog must stay lazy');}};
 const service=new AutoExperienceCandidates({projectId:'project:a',log,busy:()=>false,snapshot:async()=>({revision:1,libraryRevision:1,candidate:true,entries:[]}),read:async()=>{throw new Error('Not expected');},analyze:async()=>{throw new Error('Not expected');},apply:async()=>false,flush:async()=>{},changed:()=>changed++});
 await service.initialize();service.observe();for(let i=0;i<100&&!changed;i++)await new Promise(r=>setTimeout(r,2));assert.equal(service.view().status,'waiting');assert.equal(reads,0);await service.dispose();
});


test('matching-only changes are validated, published, retained and rolled back with hard negative cases',async t=>{
 const f=await fixture(t);await f.run({action:'create',title:'Specific trigger'});
 const broad={...draft,keywords:['board','rotate']};await f.run({action:'edit',experienceId:f.entry.id,enabled:true,draft:broad});
 const cases=[{id:'case:yes',request:'rotate board',expectedIds:[f.entry.id]},{id:'case:near',request:'change board color',expectedIds:[]},{id:'case:negated',request:'do not rotate board',expectedIds:[]},{id:'case:excluded',request:'rotate board poster',expectedIds:[]}];
 await f.run({action:'cases',cases});assert.equal((await f.run({action:'validate'})).evaluation.status,'fail');await assert.rejects(f.run({action:'publish'}),/验证/);
 const matching={schemaVersion:1,minimumMatches:2,requiredKeywords:['board'],excludedKeywords:['poster']};
 let view=await f.run({action:'edit',experienceId:f.entry.id,enabled:true,draft:{...broad,matching}});assert.equal(view.state.candidate.validation,null);
 view=await f.run({action:'validate'});assert.equal(view.evaluation.status,'pass');assert.equal(view.evaluation.evaluatorVersion,'1.1.0');
 const saved=structuredClone(view.comparison);const published=await f.run({action:'publish'});await f.reopen();
 assert.deepEqual((await f.store.select('rotate board','task:new')).entries[0].experience.matching,matching);
 assert.deepEqual((await f.store.select('change board color','task:new')).entries,[]);
 assert.deepEqual((await f.store.optimizations(published.state.activeReleaseId)).releaseReport.comparison,saved);
 view=await f.run({action:'create',title:'Rules only'});await f.run({action:'edit',experienceId:f.entry.id,enabled:true,draft:{...broad,matching:{...matching,minimumMatches:1}}});
 await f.run({action:'cases',cases:[{id:'case:yes',request:'board',expectedIds:[f.entry.id]},{id:'case:no',request:'board poster',expectedIds:[]}]});
 assert.equal((await f.run({action:'validate'})).evaluation.status,'pass','rule-only edits count as changes');await f.run({action:'discard'});
 await f.run({action:'rollback',releaseId:published.state.releases[0].id});assert.equal((await f.store.select('board','task:new')).entries.length,1);
});

test('old matching reports remain readable but cannot approve publishing after matcher upgrade',async t=>{
 const f=await fixture(t);await candidate(f);const checked=await f.run({action:'validate'});
 const old={...checked.evaluation,evaluatorVersion:'1.0.0'};assert.deepEqual(parseExperienceValidation(old,checked.comparison).evaluation,old);
 f.artifactOverrides.set(checked.state.candidate.validation.evaluationArtifactId,old);
 await assert.rejects(f.run({action:'publish'}),/升级|重新验证/);
 f.artifactOverrides.clear();await f.run({action:'validate'});await f.run({action:'publish'});
});
