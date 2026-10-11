import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableSessionRuntime, TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog, ProjectAgentHistory } from '@haiyue/ai-studio-operation-log';
import { ProjectConversationController } from '@haiyue/ai-studio-agent-orchestration';

const backendId = 'backend:project-history';
const longResult = 'full-result-'.repeat(700);
const longReply = '完整回复'.repeat(5000);

test('project attention follows real host transitions and project hydration does not replay alerts', async t => {
  const value = await fixture(t), changes = [];
  const subscription = value.controller.subscribeAttention(change => changes.push(change));
  await value.run('A notification regression');
  await until(() => changes.some(c => c.type === 'show'));
  assert.equal(changes.filter(c => c.type === 'show').length, 1);
  assert.equal(changes.find(c => c.type === 'show').notice.kind, 'turn-completed');
  assert.equal(value.controller.replay().busy, false);
  assert.equal(value.controller.replay().taskRuns[0].status, 'blocked', 'a turn reminder must not change task acceptance');
  const reviews = await value.controller.queryReviews('project:a');
  assert.equal(reviews.records.length,1,reviews.error);
  const review = await value.controller.readReview('project:a',reviews.records[0].taskId);
  const bound=(await value.source.query({kinds:['agent/task-turn-bound'],limit:10})).events;assert.equal(bound.length,1);assert.equal(bound[0].correlation.projectId,'project:a');
  const effects=await value.controller.queryExperienceEffects('project:a');assert.equal(effects.total,1);assert.equal(effects.excluded,1);
  await assert.rejects(()=>value.controller.queryExperienceEffects('project:b'),/项目已切换/);
  assert.equal(review.metrics.toolCalls,1); assert.equal(review.deep,null);
  await assert.rejects(()=>value.controller.readReview('project:b',review.taskId),/项目已切换/);
  await value.change('b'); await value.change('a');
  assert.equal(changes.filter(c => c.type === 'show').length, 1);
  assert.ok(changes.some(c => c.type === 'withdraw')); subscription.dispose();
});

async function fixture(t, slow = false, automatic = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-project-conversation-'));
  const source = await OperationLog.open({ rootDirectory: path.join(root, 'editor-cache'), appVersion: 'test' });
  let project = binding('a'); let counter = 0; let executing = false; let finished = false;
  const gates = new Map(); const traces = []; const experienceSelections = [];
  const sessions = new DurableSessionRuntime(source);
  const backend = {
    ...(automatic ? {async detach(id) { traces.push({detached:id}); }} : {}),
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: ['low'], defaultReasoningEffort: 'low', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async submitToolResult(id, result) { traces.push({ id, result }); gates.get(id)?.(); },
  };
  const profile = { id: 'prompt:history', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, modules: [] };
  const runtime = {
    sessions, registry: { descriptors: () => [backend.descriptor], get: () => backend },
    accounting: new TaskAccountingRegistry(new UsageLedgerStore()),
    context: { async prepareIsolated(prompt) { return {prompt,contextArtifactIds:[]}; }, prompts: { profile }, async prepare({ request, experiences }) { experienceSelections.push(experiences); return { prompt: request, promptProfile: profile, promptDigest: profile.digest, contextDigest: profile.digest, contextArtifactIds: [], cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; }, async commit() {} },
    turns: {
      async *start(_backendId, input, signal) {
        if (input.tools?.[0]?.id === 'studio.experience.suggest') {
          traces.push({analysis:input});
          yield {schemaVersion:1,backendId,sessionId:'session:automatic',turnId:'turn:automatic',kind:'tool-request',payload:{toolCallId:'call:automatic',toolId:'studio.experience.suggest',arguments:{schemaVersion:1,summary:'根据工具错误建议先核对参数。',proposals:[{findingIndex:0,draft:{title:'核对参数',condition:'编辑场景时',recommendation:'先检查参数约束。',keywords:['场景']},positiveRequest:'编辑场景',negativeRequest:'增加音效'}]}}};
          return;
        }
        const owner = project; const sequence = ++counter;
        const sessionId = `session:history:${sequence}`; const turnId = `turn:history:${sequence}`; const callId = `call:history:${sequence}`;
        const event = (kind, payload) => ({ schemaVersion: 1, backendId, sessionId, turnId, kind, payload });
        let release; const done = new Promise(resolve => { release = resolve; }); gates.set(callId, release);
        yield event('status', { status: 'running' });
        yield event('tool-request', { toolCallId: callId, toolId: 'scene.query', arguments: { baseRevision: 1, owner: owner.projectId, name: input.prompt, text: 'parameters-'.repeat(300) } });
        await done;
        yield event('conversation-node', { status: 'streaming', delta: `${owner.projectId}:${longReply}` });
        yield event('completed', { status: signal.aborted ? 'cancelled' : 'completed' });
      },
      async *resume() {}, async cancel() { for (const release of gates.values()) release(); }, async recordToolResult() {},
    },
  };
  const tools = {
    definitions: () => [{ id: 'scene.query', version: '1.0.0', description: 'Read current project', effect: 'observe', risk: 'low', concurrencySafe: true, inputSchema: {} }],
    async prepare(call) { return { id: `preparation:${call.id}`, callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: project.documentId, baseRevision: 1, status: 'ready', argumentsDigest: 'a'.repeat(64), previewDigest: 'b'.repeat(64), preview: { title: 'Read', target: 'Project', summary: 'Read', diff: '' } }; },
    async execute(preparation) { executing = true; const owner = project.projectId; await new Promise(resolve => setTimeout(resolve, slow ? 70 : 20)); finished = true; traces.push({ executedFor: owner, stillCurrent: project.projectId }); return { schemaVersion: 1, callId: preparation.replace('preparation:', ''), toolId: 'scene.query', documentId: project.documentId, status: automatic ? 'failed' : 'completed', value: automatic ? {code:'tool.arguments-invalid'} : { owner, text: longResult }, beforeRevision: 1, afterRevision: 1 }; },
  };
  const directories = new Map();
  const controller = new ProjectConversationController({
    resolveProject: () => project,
    async openHistory(owner) {
      const directory = owner.storageKey ?? path.join(root, owner.projectId.replaceAll(':', '-'), '.aistudio', 'agent'); directories.set(owner.projectId, directory);
      const history = await ProjectAgentHistory.open({ source, projectId: owner.projectId, directory, storage: owner.storageKey ? 'project' : 'unsaved' });
      return { log: history.log, query: query => history.query(query), detail: id => history.detail(id), flush: () => history.flush(), dispose: () => history.dispose(), relocate: next => history.relocate(next.storageKey) };
    },
    hostOptions: (owner, log) => ({ runtime, tools, operationLog: log, isProjectOpen: () => owner.projectId === project.projectId, projectContext: () => ({ projectId: owner.projectId, documentId: owner.documentId, revision: 1, manifest: { name: owner.projectId } }) }),
  });
  t.after(async () => { await controller.dispose(); await sessions.dispose(); await source.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  await controller.initialize();
  return { root, source, sessions, controller, directories, traces, experienceSelections, executing: () => executing, finished: () => finished,
    async change(name) { await controller.prepareProjectChange(); project = binding(name); await controller.syncProject(); },
    async run(prompt) { await controller.dispatch({ type: 'conversation/send', backendId, prompt }); await until(() => !controller.replay().busy); },
  };
}

test('project controller wires reviewed experience into later host turns and rejects cross-project updates',async t=>{
  const f=await fixture(t);await f.run('Read board');
  const list=await f.controller.queryReviews('project:a');const report=await f.controller.readReview('project:a',list.records[0].taskId);
  const evidence=report.evidence.find(e=>e.kind==='tool-result');assert.ok(evidence);
  const finding={code:'candidate-read',severity:'info',title:'Use current query results',detail:'A scoped scene query has retained evidence.',recommendation:'Check the document revision before reusing a read result.',recordIds:[evidence.recordId]};
  const artifact=await f.source.putArtifact({...report,findings:[finding]},{schemaVersion:'agent-task-review/1'});
  await f.source.append({kind:'agent/task-review',severity:'info',source:'test',correlation:{projectId:'project:a'},payload:{taskId:report.taskId,taskRevision:report.taskRevision,sourceDigest:report.sourceDigest},artifactRefs:[artifact.id]});
  await f.change('b');await f.change('a');
  const current=await f.controller.readReview('project:a',report.taskId);
  const draft={title:'Current board query',condition:'Inspecting an unchanged board',recommendation:'Check revision before reusing results.',keywords:['board']};
  const entry=await f.controller.adoptExperience('project:a',{schemaVersion:1,projectId:'project:a',taskId:report.taskId,reviewDigest:current.sourceDigest,findingSource:'rules',finding,draft},new AbortController().signal);
  await f.run('Check board');assert.equal(f.experienceSelections.at(-1).entries[0].experience.id,entry.id);
  await f.controller.updateExperience('project:a',entry.id,entry.revision,false,draft,new AbortController().signal);
  await f.run('Check board again');assert.equal(f.experienceSelections.at(-1).entries.length,0);
  const optimize=async action=>{const view=await f.controller.queryOptimizations('project:a');return f.controller.optimizeExperiences('project:a',{schemaVersion:1,projectId:'project:a',expectedRevision:view.state.revision,...action},new AbortController().signal);};
  await optimize({action:'create',title:'Reviewed applicability'});
  await optimize({action:'edit',experienceId:entry.id,enabled:true,draft});
  await optimize({action:'cases',cases:[{id:'case:board',request:'check board',expectedIds:[entry.id]},{id:'case:unrelated',request:'music volume',expectedIds:[]}]});
  assert.equal((await optimize({action:'validate'})).evaluation.status,'pass');const published=await optimize({action:'publish'});
  assert.equal((await f.controller.queryOptimizations('project:a',published.state.activeReleaseId)).releaseReport.evaluation.status,'pass');
  await f.run('Read board after publication');assert.equal(f.experienceSelections.at(-1).releaseId,published.state.activeReleaseId);assert.equal(f.experienceSelections.at(-1).entries[0].experience.id,entry.id);
  await f.controller.setExperienceReuse('project:a',{schemaVersion:1,projectId:'project:a',expectedRevision:0,paused:true},new AbortController().signal);
  await f.run('Read board paused');assert.deepEqual(f.experienceSelections.at(-1).entries,[]);
  await f.change('b');assert.equal((await f.controller.queryExperiences('project:b')).entries.length,0);
  assert.equal((await f.controller.queryOptimizations('project:b')).state.activeReleaseId,null);
  assert.equal((await f.controller.queryExperiences('project:b')).reuse.paused,false);
  await assert.rejects(f.controller.setExperienceReuse('project:a',{schemaVersion:1,projectId:'project:a',expectedRevision:1,paused:false},new AbortController().signal),/项目已切换/);
  await assert.rejects(f.controller.queryOptimizations('project:b',published.state.activeReleaseId),/版本不存在/);
  await assert.rejects(f.controller.queryOptimizations('project:a',published.state.activeReleaseId),/项目已切换/);
  await assert.rejects(f.controller.optimizeExperiences('project:a',{schemaVersion:1,projectId:'project:a',expectedRevision:published.state.revision,action:'rollback',releaseId:published.state.releases[0].id},new AbortController().signal),/项目已切换/);
  await assert.rejects(f.controller.updateExperience('project:a',entry.id,2,true,draft,new AbortController().signal),/项目已切换/);
  await f.run('Check board');assert.equal(f.experienceSelections.at(-1).projectId,'project:b');assert.equal(f.experienceSelections.at(-1).entries.length,0);
});

test('project switches replace replay, preserve full structured tool data and restore the matching project after restart', async t => {
  const value = await fixture(t); const { controller } = value;
  await value.run('A-only request');
  const a = await controller.queryHistory('project:a', { limit: 100 });
  const result = a.records.find(record => record.kind === 'tool-result'); assert.ok(result);
  const detail = await controller.readHistory('project:a', result.id);
  assert.equal(detail.data.parameters.owner, 'project:a'); assert.equal(detail.data.parameters.text, 'parameters-'.repeat(300)); assert.equal(detail.data.result.value.text, longResult);
  assert.ok(result.durationMs >= 5); assert.equal(Date.parse(result.finishedAt) - Date.parse(result.startedAt), result.durationMs);
  const reply = a.records.find(record => record.kind === 'text' && record.sessionId.startsWith('session:history'));
  assert.equal((await controller.readHistory('project:a', reply.id)).data.text, `project:a:${longReply}`);
  const revision = controller.replay().revision;
  await controller.dispatch({ type: 'agent/configure', backendId, model: 'fixture-model', reasoningEffort: 'low', outputTokenLimit: 6000, budget: controller.replay().taskAccounting.budget });
  await value.change('b');
  assert.equal(controller.replay().backends[0].outputTokenLimit, 6000);
  assert.equal((await controller.queryHistory('project:b', {})).total, 0); assert.equal(controller.replay().events.length, 0); assert.ok(controller.replay().revision > revision);
  await assert.rejects(controller.readHistory('project:a', result.id), /项目已切换/);
  await value.run('B-only request');
  assert.doesNotMatch(JSON.stringify(controller.replay()), /A-only request/);
  await value.change('a');
  assert.match(JSON.stringify(controller.replay()), /A-only request/); assert.doesNotMatch(JSON.stringify(controller.replay()), /B-only request/);
  assert.equal((await controller.readHistory('project:a', result.id)).data.result.value.text, longResult);
  await controller.dispose();
  const copied = path.join(value.root, 'portable'); await cp(value.directories.get('project:a'), copied, { recursive: true });
  const freshLog = await OperationLog.open({ rootDirectory: path.join(value.root, 'fresh'), appVersion: 'test' });
  const archive = await ProjectAgentHistory.open({ source: freshLog, projectId: 'project:a', directory: copied, storage: 'project' });
  const freshSessions = new DurableSessionRuntime(freshLog);
  try {
    const session = await freshSessions.open(result.sessionId, { repairOpenOperations: false });
    const snapshot = await session.snapshot(); assert.equal(snapshot.session.projectId, 'project:a'); assert.ok(snapshot.ops.some(op => op.kind === 'tool.completed'));
    assert.ok(snapshot.transcript.some(entry => entry.content.includes('A-only request'))); await session.dispose();
  } finally { await freshSessions.dispose(); await archive.dispose(); await freshLog.close(); }
});

test('switching projects drains a late tool result before replacing its project authority', async t => {
  const value = await fixture(t, true);
  await value.controller.dispatch({ type: 'conversation/send', backendId, prompt: 'A delayed read' });
  await until(value.executing);
  await value.change('b');
  assert.equal(value.finished(), true);
  assert.ok(value.traces.some(trace => trace.executedFor === 'project:a' && trace.stillCurrent === 'project:a'));
  assert.equal((await value.controller.queryHistory('project:b', {})).total, 0);
  assert.doesNotMatch(JSON.stringify(value.controller.replay()), /A delayed read|project:a/);
});

test('reopening an interrupted step preserves its original parameters when marking it cancelled', async t => {
  const value = await fixture(t);
  const id = 'node:interrupted';
  const parameters = { revision: 17, text: 'original parameter '.repeat(400) };
  const data = await value.source.putArtifact({ toolId: 'scene.query', parameters });
  const node = { schemaVersion: 1, id, kind: 'tool-call', knownKind: null, status: 'pending', createdAt: '2026-09-06T12:00:00.000Z', provenance: { backendId, sessionId: 'session:interrupted', turnId: 'turn:interrupted' }, content: { toolId: 'scene.query' }, payloadTruncated: false };
  const projection = await value.source.putArtifact(node);
  const record = { schemaVersion: 1, id, projectId: 'project:a', kind: node.kind, status: node.status, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId, toolId: 'scene.query', startedAt: node.createdAt, finishedAt: null, durationMs: null, dataArtifactId: data.id };
  await value.source.append({ kind: 'agent/execution-record', severity: 'info', source: 'studio.fixture', correlation: { projectId: 'project:a' }, payload: { record }, artifactRefs: [data.id] });
  await value.source.append({ kind: 'conversation/node-projected', severity: 'info', source: 'studio.fixture', correlation: { projectId: 'project:a' }, payload: { nodeId: id, executionDataArtifactId: data.id }, artifactRefs: [projection.id] });
  await value.change('b'); await value.change('a');
  const detail = await value.controller.readHistory('project:a', id);
  assert.equal(detail.record.status, 'cancelled'); assert.deepEqual(detail.data.parameters, parameters);
});

function binding(name) { return { projectId: `project:${name}`, documentId: `document:${name}`, storageKey: null }; }
async function until(predicate) { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for project conversation'); }

test('task termination flows through automatic rule review into a candidate using the selected model and project journal',async t=>{
 const f=await fixture(t,false,true);await f.run('编辑场景');let view;
 for(let i=0;i<200;i++){view=await f.controller.queryOptimizations('project:a');if(view.automatic.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(view.automatic.status,'completed',JSON.stringify(view.automatic));assert.ok(view.state.candidate);assert.equal(view.state.candidate.validation,null);assert.equal(view.candidateEntries.length,1);
 const analyses=f.traces.filter(r=>r.analysis);assert.equal(analyses.length,1);assert.equal(analyses[0].analysis.config.model,'fixture-model');assert.ok(f.traces.some(r=>r.detached==='session:automatic'));
 const state=view.state;await f.change('b');assert.equal((await f.controller.queryOptimizations('project:b')).state.candidate,null);await f.change('a');assert.deepEqual((await f.controller.queryOptimizations('project:a')).state,state);assert.equal(f.traces.filter(r=>r.analysis).length,1);
});
