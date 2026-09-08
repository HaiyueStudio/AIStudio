import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectBehaviorController } from '@haiyue/ai-studio-agent-orchestration';
import { ProjectAgentHistory } from '@haiyue/ai-studio-operation-log';
import { BehaviorRuntimeRecorder, PreviewAuthorizationService, hasDeclarativeGameplay } from '@haiyue/ai-studio-script-preview';
import { ScriptComponent } from '@haiyue/engine/components';
import { IsolatedTrustedPreviewRuntime } from '@haiyue/ai-studio-script-preview';
import { createWorkspaceBehaviorPorts } from '../dist/behavior-adapters.js';
import { StudioIpcRouter, validateStudioIpcRequest } from '../dist/ipc.js';
import { DeclarativePlayRuntime } from '../dist/declarative-play-components.js';
import { behaviorFixture, execute } from '../../../packages/game-authoring-tools/test/behavior-fixture.mjs';

for (const scripted of [false, true]) test(`production source/IPC/approved Play/portable artifacts: ${scripted ? 'mixed' : 'zero-script'}`, async t => {
  let behavior, authorization, history, runtime, router;
  const f = await behaviorFixture({ declarative: true, script: scripted ? 'if (time > 10) Math.sin(time);' : '', runtimeOptions: { behaviorSource: signal => behavior.source(signal) } });
  t.after(async () => { router?.dispose(); authorization?.dispose(); await runtime?.stop(); await behavior?.dispose(); await history?.dispose(); await f.close(); });
  const revision = () => f.workspace.snapshot().document.revision;
  await execute(f, 'entity.create', { baseRevision: revision(), kind: 'cube', material: 'basic', name: 'Visible' });
  await execute(f, 'component.configure', { baseRevision: revision(), entityId: f.entityId, action: 'upsert', type: 'haiyue.gameplay.state', patch: { observationId: 'round', score: 0 } });
  await execute(f, 'component.configure', { baseRevision: revision(), entityId: f.entityId, action: 'upsert', type: 'haiyue.gameplay.rules', patch: { rules: [{ id: 'tick-score', once: false,
    when: { source: 'timer-event', value: 'elapsed', entityAId: '', entityBId: '', phase: 'enter' }, actions: [{ kind: 'add-score', targetObservationId: 'round', key: '', numberValue: 1, textValue: '', booleanValue: false }],
  }] } });
  const projectId = f.workspace.snapshot().document.projectId, directory = path.join(f.directory, 'project', '.aistudio', 'agent');
  history = await ProjectAgentHistory.open({ projectId, directory, source: f.operationLog, storage: 'project' });
  behavior = new ProjectBehaviorController(createWorkspaceBehaviorPorts(f.workspace, f.operationLog));
  authorization = new PreviewAuthorizationService(f.projectScripts, f.validator, f.operationLog, Date.now, undefined, () => hasDeclarativeGameplay(f.workspace.gameSnapshot().components));
  router = new StudioIpcRouter({ workspace: f.workspace, scene: f.scene, selection: {}, scripts: { snapshot: () => f.projectScripts.snapshot(), prepare: input => authorization.prepare(input), decide: (id, decision) => authorization.decide(id, decision), consume: id => authorization.consume(id) },
    operationLog: f.operationLog, behavior, conversation: { replay: () => ({}), cancelPending() {}, async dispatch() {}, async syncProject() {} },
    agentPreview: { command: () => ({ pending: false }), cancelPending() {} }, bugBundleRoot: path.join(f.directory, 'bundles'), versions: { app: '0.0.0', schema: 'test', upstream: {} }, selectProjectRoot: async () => null });
  let sequence = 0;
  const invoke = async (channel, payload = {}, success = true) => { const response = await router.handle({ schemaVersion: 1, id: `request:logic-${++sequence}`, correlationId: `correlation:logic-${sequence}`, channel, payload }); assert.equal(response.ok, success, JSON.stringify(response.payload)); return response.payload; };
  const before = JSON.stringify(f.workspace.gameSnapshot()), undo = JSON.stringify(f.workspace.snapshot().history);
  const analysis = await invoke('behavior/refresh'); assert.equal(analysis.state, 'ready');
  assert.equal(analysis.manifest.binding.registry.version, JSON.parse(await readFile(new URL('../../../packages/editor-plugins/package.json', import.meta.url), 'utf8')).version);
  const queried = await execute(f, 'behavior.query', { baseRevision: revision(), entityId: f.entityId, limit: 100 });
  assert.equal(queried.value.manifestDigest, analysis.manifest.digest, 'Agent and UI use the same production source binding');
  const trigger = analysis.manifest.nodes.find(n => n.kind === 'trigger');
  const location = await invoke('behavior/locate', { manifestDigest: analysis.manifest.digest, nodeId: trigger.id }); assert.equal(location.target.source.kind, 'declarative-component');
  const fact = await f.operationLog.append({ kind: 'document/transaction', severity: 'info', source: 'test:logic', correlation: { projectId, documentId: analysis.project.documentId, entityId: trigger.source.entityId, transactionId: 'transaction:actual-fixture' }, payload: { revision: revision(), result: 'committed' } });
  const related = await invoke('behavior/related', { manifestDigest: analysis.manifest.digest, nodeId: trigger.id });
  assert.ok(related.events.some(event => event.eventId === fact.eventId && event.correlation.transactionId === 'transaction:actual-fixture'));
  await invoke('behavior/explain', { manifestDigest: analysis.manifest.digest, nodeIds: [trigger.id], language: 'zh-CN' });
  const plan = await invoke('preview/prepare');
  await invoke('preview/consume', { grantId: 'grant:unapproved' }, false);
  const grant = await invoke('preview/authorize', { planId: plan.id, approved: true }), consumed = await invoke('preview/consume', { grantId: grant.id });
  assert.ok(consumed.behavior, JSON.stringify(consumed));
  await invoke('preview/consume', { grantId: grant.id }, false);
  const recorder = new BehaviorRuntimeRecorder(consumed.behavior), declarative = new DeclarativePlayRuntime(f.scene.snapshot().entities);
  recorder.captureDeclarative(declarative.snapshot(0), false);
  runtime = new IsolatedTrustedPreviewRuntime(f.operationLog); await runtime.start(f.scene.snapshot(), consumed);
  if (scripted) ScriptComponent.configureExecution({ compiler: recorder.compiler(() => consumed.scripts[0].scriptId) });
  for (let tick = 1; tick <= 10; tick++) { recorder.beginTick(tick, tick); runtime.tick(tick * 1000 / 60, 1000 / 60); recorder.captureDeclarative(declarative.advance(tick), true); }
  assert.equal(runtime.snapshot().state, 'playing');
  const captured = await invoke('behavior/capture', { capture: recorder.snapshot() });
  assert.equal(captured.traceStatus, 'current');
  assert.ok(captured.trace.trace.events.some(e => e.event === 'timer-fired'));
  assert.ok(captured.trace.trace.events.some(e => e.event === 'action-completed'));
  assert.ok(captured.trace.trace.events.some(e => e.kind === 'state-diff' && e.stateDiff.after === 1));
  assert.equal(captured.trace.trace.events.some(e => e.scriptId !== null), scripted, 'real public Engine compiler seam generates script events');
  recorder.close(); await invoke('behavior/capture', { capture: recorder.snapshot() });
  const records = await invoke('behavior/history', { kind: 'trace', limit: 100 }); assert.equal(records.records.length, 2);
  const read = await invoke('behavior/read', { kind: 'trace', artifactId: records.records[0].artifactId }); assert.equal(read.status, 'historical');
  await history.flush(); assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(JSON.stringify(f.workspace.snapshot().history), undo);
});

test('behavior IPC cannot select filesystem paths or inject additional authority', () => {
  const request = (channel, payload) => ({ schemaVersion: 1, id: 'request:logic', correlationId: 'correlation:logic', channel, payload });
  for (const [channel, payload] of [
    ['behavior/history', { projectId: 'project:other' }], ['behavior/read', { kind: 'trace', artifactId: '../../outside' }],
    ['behavior/refresh', { source: {} }], ['behavior/capture', { capture: {}, manifestDigest: 'injected' }],
    ['behavior/related', { projectId: 'project:foreign', manifestDigest: `sha256:${'a'.repeat(64)}`, nodeId: 'node:foreign' }],
    ['behavior/explain', { manifestDigest: `sha256:${'a'.repeat(64)}`, nodeIds: [], language: 'zh-CN' }],
  ]) assert.throws(() => validateStudioIpcRequest(request(channel, payload)));
});
