import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ProjectBehaviorController } from '../dist/index.js';
import { ProjectBehaviorHistory } from '@haiyue/ai-studio-operation-log';
import { BehaviorReadService, createBehaviorSourceBinding, parseBehaviorContract, validateBehaviorArtifact, createBehaviorRuntimePlan, sealBehaviorRuntimeCapture, assertBehaviorCaptureProgress, associateBehaviorTrace, instrumentBehaviorScripts, BehaviorRuntimeRecorder } from '@haiyue/ai-studio-script-preview';
import { behaviorFixture, execute, timer } from '../../game-authoring-tools/test/behavior-fixture.mjs';

async function fixture(t) {
  const f = await behaviorFixture({ declarative: true, script: 'if (api.input.isDown("ArrowUp")) Math.sin(time);' });
  const reader = new BehaviorReadService(), history = new ProjectBehaviorHistory({ log: f.operationLog, validate: validateBehaviorArtifact });
  f.analyses = 0; f.read = () => f.input();
  const port = { analyze: async (...args) => { f.analyses++; return reader.analyze(...args); } };
  for (const key of ['query','locate','resolveLocation','explain','invalidate','dispose']) port[key] = reader[key].bind(reader);
  f.behavior = new ProjectBehaviorController({
    current: () => { const value = f.workspace.snapshot().document; return value ? { projectId: value.projectId, documentId: value.documentId, revision: value.revision } : null; },
    readSource: signal => f.read(signal), validateSource: value => parseBehaviorContract('behavior-analysis-input', value), bindSource: createBehaviorSourceBinding,
    validateLocation: value => parseBehaviorContract('editor-location', value), reader: port, history,
    runtime: { prepare: createBehaviorRuntimePlan, capture: sealBehaviorRuntimeCapture, assertProgress: assertBehaviorCaptureProgress, associate: associateBehaviorTrace },
  });
  t.after(async () => { await f.behavior.dispose(); await f.close(); });
  return f;
}

test('real project analysis, language changes, locations and artifacts keep one structure and unchanged Document/History', async t => {
  const f = await fixture(t), before = JSON.stringify(f.workspace.gameSnapshot()), undo = JSON.stringify(f.workspace.snapshot().history);
  assert.equal(f.behavior.snapshot().state, 'pending');
  const first = await f.behavior.refresh(); assert.equal(first.state, 'ready');
  const node = first.manifest.nodes.find(node => node.kind === 'trigger');
  const request = { manifestDigest: first.manifest.digest, nodeIds: [node.id], language: 'en' };
  const english = await f.behavior.explain(request), chinese = await f.behavior.explain({ ...request, language: 'zh-CN' });
  assert.notEqual(english.digest, chinese.digest); assert.equal(f.analyses, 1);
  f.behavior.syncProject(); assert.equal(f.behavior.snapshot().manifest.digest, first.manifest.digest);
  assert.deepEqual(await f.behavior.explain(request), english); assert.equal(f.analyses, 1);
  assert.equal((await f.behavior.history()).records.length, 3, 'cached explanations do not duplicate records');
  const location = await f.behavior.locateNode(first.manifest.digest, node.id);
  assert.equal(location.target.source.componentId, node.source.componentId);
  assert.deepEqual(await f.behavior.resolveLocation(location), location);
  assert.equal((await f.behavior.readArtifact('manifest', first.artifacts[0].artifactId)).status, 'current');
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(JSON.stringify(f.workspace.snapshot().history), undo);
});

test('actual Play captures persist independently, restart keeps prior evidence separate and Stop closes only its own overlay', async t => {
  const f = await fixture(t), before = JSON.stringify(f.workspace.gameSnapshot());
  const first = await f.behavior.refresh();
  const programs = instrumentBehaviorScripts(f.input(), first.manifest);
  const approved = id => ({ id, documentId: first.project.documentId, documentRevision: first.project.revision, scripts: programs.map(p => ({ scriptId: p.scriptId, emittedText: p.originalEmittedText })) });
  const correlation = { taskId: 'task:approved-play', turnId: 'turn:approved-play' };
  const plan = await f.behavior.preparePlay(approved('preview:first'), correlation);
  assert.deepEqual(await f.behavior.preparePlay(approved('preview:first'), correlation), plan);
  const recorder = new BehaviorRuntimeRecorder(plan), run = recorder.compiler(() => programs[0].scriptId)(programs[0].originalEmittedText, { component: {}, sourceUrl: 'fixture.js' });
  recorder.beginTick(1, 0); run(null,null,null,10,1,null,{ input: { isDown: () => false } });
  const captured = await f.behavior.capturePlay(recorder.snapshot()); assert.equal(captured.traceStatus, 'current');
  const reference = captured.artifacts.at(-1); assert.equal(reference.kind, 'trace');
  assert.equal((await f.behavior.readArtifact('trace', reference.artifactId)).status, 'current');
  const secondPlan = await f.behavior.preparePlay(approved('preview:second'), correlation);
  assert.notEqual(secondPlan.playId, plan.playId); assert.equal(secondPlan.manifestDigest, plan.manifestDigest);
  recorder.close(); await f.behavior.capturePlay(recorder.snapshot());
  assert.equal(f.behavior.snapshot().trace, null, 'old Stop result cannot replace new Play');
  assert.equal((await f.behavior.readArtifact('trace', reference.artifactId)).status, 'historical');
  const second = new BehaviorRuntimeRecorder(secondPlan), secondRun = second.compiler(() => programs[0].scriptId)(programs[0].originalEmittedText, { component: {}, sourceUrl: 'fixture.js' });
  second.beginTick(1, 0); secondRun(null,null,null,10,1,null,{ input: { isDown: () => true } });
  await f.behavior.capturePlay(second.snapshot());
  assert.notEqual(f.behavior.snapshot().trace.trace.digest, captured.trace.trace.digest);
  second.close(); await f.behavior.capturePlay(second.snapshot());
  assert.equal(f.behavior.snapshot().traceStatus, 'historical');
  await assert.rejects(f.behavior.capturePlay(second.snapshot()), /play-stale/);
  assert.equal(f.analyses, 1); assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before);
  assert.equal((await f.behavior.history({ kind: 'trace' })).records.length, 4);
});

test('saving nonstructural metadata preserves analysis while late captures and accessors cannot cross project lifetime', async t => {
  const f = await fixture(t); const first = await f.behavior.refresh();
  const input = structuredClone(f.input()); input.document.savedRevision = input.document.revision; f.read = () => input;
  await f.behavior.explain({ manifestDigest: first.manifest.digest, nodeIds: [first.manifest.nodes[0].id], language: 'en' });
  assert.equal(f.analyses, 1);
  let accessed = false;
  await assert.rejects(f.behavior.capturePlay({ get playId() { accessed = true; return 'play:unknown'; } }), /play-stale/); assert.equal(accessed, false);
  const programs = instrumentBehaviorScripts(input, first.manifest);
  const plan = await f.behavior.preparePlay({ id: 'preview:late', documentId: first.project.documentId, documentRevision: first.project.revision, scripts: programs.map(p => ({ scriptId: p.scriptId, emittedText: p.originalEmittedText })) }, { taskId: 'task:late', turnId: 'turn:late' });
  const recorder = new BehaviorRuntimeRecorder(plan);
  await f.workspace.closeProject(); f.behavior.syncProject();
  await assert.rejects(f.behavior.capturePlay(recorder.snapshot()), /play-stale|stale|project-unavailable/);
  const facts = await f.operationLog.query({ kinds: ['behavior/trace'], limit: 10, traverseCorrelation: false }); assert.equal(facts.events.length, 0);
});

test('revision, configuration, project switch and cancellation reject late results and old ranges', async t => {
  const f = await fixture(t); const first = await f.behavior.refresh();
  const scriptNode = first.manifest.nodes.find(node => node.source.kind === 'script');
  const location = await f.behavior.locateNode(first.manifest.digest, scriptNode.id);
  const changed = structuredClone(f.input()); changed.config.maxNodes = 1000; f.read = () => changed;
  await assert.rejects(f.behavior.explain({ manifestDigest: first.manifest.digest, nodeIds: [scriptNode.id], language: 'en' }), /behavior.stale/);
  await assert.rejects(f.behavior.resolveLocation(location), /behavior.location-historical/);
  assert.equal((await f.behavior.readArtifact('manifest', first.artifacts[0].artifactId)).status, 'historical');
  f.read = () => f.input();
  await execute(f, 'component.configure', { baseRevision: f.workspace.snapshot().document.revision, entityId: f.entityId, type: 'haiyue.gameplay.timers', action: 'upsert', patch: { timers: [{ ...timer, durationTicks: 20 }] } });
  f.behavior.syncProject(); assert.equal(f.behavior.snapshot().manifest, null);
  assert.equal((await f.behavior.readArtifact('manifest', first.artifacts[0].artifactId)).status, 'historical');
  await f.behavior.refresh(); await assert.rejects(f.behavior.resolveLocation(location), /historical/);
  let release, entered;
  const sourceEntered = new Promise(resolve => { entered = resolve; });
  const old = f.input(); f.read = () => { entered(); return new Promise(resolve => { release = () => resolve(old); }); };
  const pending = f.behavior.refresh(); const rejected = assert.rejects(pending, /cancelled|stale/); await sourceEntered;
  await f.workspace.closeProject();
  const nextRoot = path.join(f.directory, 'second-project'); await mkdir(nextRoot); await f.workspace.newProject(nextRoot, 'Second project');
  f.behavior.syncProject(); await rejected; release();
  f.read = () => f.input();
  const second = await f.behavior.refresh(); assert.notEqual(second.project.projectId, first.project.projectId);
  assert.equal((await f.behavior.history()).records.length, 1);
  await assert.rejects(f.behavior.readArtifact('manifest', first.artifacts[0].artifactId), /history-project/);
  f.behavior.cancel(); assert.equal(f.behavior.snapshot().state, 'pending'); assert.equal(f.behavior.snapshot().manifest, null);
  await f.behavior.refresh(); assert.equal(f.behavior.snapshot().state, 'ready');
});

test('source failures are redacted and closed owners do not publish a late structure', async t => {
  const f = await fixture(t), secret = 'sk-fake-behavior-source-test';
  f.read = () => { throw Error(secret); };
  await assert.rejects(f.behavior.refresh(), error => !error.message.includes(secret));
  assert.equal(f.behavior.snapshot().diagnostic, 'behavior.analysis-failed');
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  f.read = () => { entered(); return new Promise(resolve => { release = () => resolve(f.input()); }); };
  const pending = f.behavior.refresh(); const rejected = assert.rejects(pending); await ready;
  await f.behavior.dispose(); await rejected; release(); await f.behavior.dispose();
  assert.equal(f.behavior.snapshot().manifest, null);
  const events = await f.operationLog.query({ kinds: ['behavior/manifest'], limit: 20, traverseCorrelation: false }); assert.equal(events.events.length, 0);
});
