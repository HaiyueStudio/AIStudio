import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { ProjectSceneAuthoringService, ProjectWorkspace, RecentProjectStore } from '@haiyue/ai-studio-editor-plugins';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { DEFAULT_BEHAVIOR_CONFIG, PreviewAuthorizationService, ProjectScriptService, ScriptValidationWorker } from '@haiyue/ai-studio-script-preview';
import { GameAuthoringToolRuntime } from '../dist/index.js';

const corpus = JSON.parse(await readFile(new URL('../../../config/contracts/fixtures/m14-behavior-inputs.json', import.meta.url), 'utf8'));
export const timer = { id: 'clock', durationTicks: 10, startDelayTicks: 0, repeat: true, running: true, event: 'elapsed' };
export const call = (id, toolId, args, sessionId = 'session:behavior', turnId = 'turn:behavior') => ({ schemaVersion: 1, id, toolId, toolVersion: '1.0.0', arguments: args, sessionId, turnId });
export async function execute(fixture, id, args, approve = true) {
  const prepared = await fixture.runtime.prepare(call(`call:behavior-${++fixture.sequence}`, id, args));
  if (prepared.approvalId && approve) await fixture.runtime.decide(prepared.approvalId, 'allow-once');
  return fixture.runtime.execute(prepared.id);
}
export async function behaviorFixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-behavior-tools-'));
  const operationLog = await OperationLog.open({ rootDirectory: path.join(directory, 'log'), appVersion: 'm14-g04-test' });
  const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(directory) };
  const workspace = new ProjectWorkspace(resources); await mkdir(path.join(directory, 'project')); await workspace.newProject(path.join(directory, 'project'), 'Behavior tool fixture');
  const scene = new ProjectSceneAuthoringService(workspace, operationLog), validator = new ScriptValidationWorker();
  const projectScripts = new ProjectScriptService(workspace, validator, operationLog);
  const authorization = new PreviewAuthorizationService(projectScripts, validator, operationLog);
  const scripts = { snapshot: () => projectScripts.snapshot(), proposeEdit: input => projectScripts.proposeEdit(input), commitProposal: (id, command, signal) => projectScripts.commitProposal(id, command, signal), preparePreview: input => authorization.preparePreview(input), authorizePreview: (id, approved) => authorization.authorizePreview(id, approved), consumeGrant: id => authorization.consumeGrant(id) };
  const preview = { starts: 0, async start() { this.starts++; throw Error('No live Play in this headless fixture'); }, async stop() {}, snapshot: () => ({ state: 'stopped', instanceId: null }) };
  const f = { directory, workspace, scene, validator, projectScripts, operationLog, scripts, preview, sequence: 0, sourceReads: 0, sourceHook: null };
  f.input = () => ({ schemaVersion: 1, projectId: workspace.snapshot().document.projectId, document: workspace.gameSnapshot(), registry: { version: '1.0.0', definitions: workspace.componentRegistry.snapshot().definitions }, adapters: corpus.mixed.adapters, config: DEFAULT_BEHAVIOR_CONFIG });
  f.runtime = new GameAuthoringToolRuntime({ workspace, scene, scripts, operationLog, diagnostics: operationLog.diagnosticsService(), preview,
    ...(options.noSource ? {} : { behaviorSource: signal => { const input = JSON.parse(JSON.stringify(f.input())); f.sourceReads++; return f.sourceHook ? f.sourceHook(input, signal, f.sourceReads) : input; } }), ...options.runtimeOptions,
  });
  f.close = async () => {
    await f.runtime.dispose(); scene.dispose(); projectScripts.dispose(); await validator.dispose(); await workspace.dispose(); resources.tasks.dispose(); await resources.documents.dispose(); resources.history.dispose(); resources.projectSession.dispose(); await operationLog.close();
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir(), 'haiyue-behavior-tools-'))); await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
  const created = await execute(f, 'entity.create', { baseRevision: workspace.snapshot().document.revision, kind: 'empty', name: 'Controller' });
  f.entityId = created.value.entity.id;
  if (options.declarative) await execute(f, 'component.configure', { baseRevision: workspace.snapshot().document.revision, action: 'upsert', entityId: f.entityId, type: 'haiyue.gameplay.timers', patch: { timers: [timer] } });
  if (options.script) {
    const proposed = await execute(f, 'script.propose', { baseRevision: workspace.snapshot().document.revision, entityId: f.entityId, text: options.script, capabilities: ['read','input','debug'] });
    await execute(f, 'script.apply', { baseRevision: workspace.snapshot().document.revision, proposalId: proposed.value.proposalId });
  }
  return f;
  } catch (error) { await f.close(); throw error; }
}
