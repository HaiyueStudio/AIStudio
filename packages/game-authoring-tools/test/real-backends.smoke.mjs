import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { CodexAppServerBackend, HarnessApiKeyBackend } from '@haiyue/ai-studio-agent-backends';
import { ProjectSceneAuthoringService, ProjectWorkspace, RecentProjectStore } from '@haiyue/ai-studio-editor-plugins';
import { createPinnedHarnessAgentTransport } from '@haiyue/ai-studio-harness-bridge/agent';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { PreviewAuthorizationService, ProjectScriptService, ScriptValidationWorker } from '@haiyue/ai-studio-script-preview';
import { AgentGameAuthoringCoordinator, GameAuthoringToolRuntime } from '../dist/index.js';

if (process.env.HAIYUE_STUDIO_ALLOW_REAL_G09_SMOKE !== '1') throw new Error('Real G09 backend smoke requires explicit authorization.');
const deepSeekSecret = process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET;
delete process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET;
if (!deepSeekSecret) throw new Error('DeepSeek smoke credential is unavailable.');

const summaries = [];
const backends = [
  async () => new HarnessApiKeyBackend({ transport: await createPinnedHarnessAgentTransport({ resolveApiKey: async () => deepSeekSecret }), clearApiKey: async () => {} }),
  async () => new CodexAppServerBackend(),
];
try {
  for (const createBackend of backends) {
    const value = await fixture();
    const backend = await createBackend();
    const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } });
    try {
      const summary = await coordinator.run(backend, {
        prompt: 'Use Studio tools to create exactly one cube named Agent Smoke Cube at document baseRevision 1. Then use transform.set with the returned entity id and returned afterRevision to set position {x:1,y:2,z:3}, rotationDegrees {x:0,y:15,z:0}, scale {x:1,y:1,z:1}. Do not call script or preview tools. After both tools complete, reply exactly G09_AGENT_TOOLS_OK.',
      });
      const scene = value.scene.snapshot();
      if (summary.terminal !== 'completed') throw new Error(JSON.stringify({ backend: backend.descriptor.kind, terminal: summary.terminal, tools: summary.results.map((item) => item.toolId), diagnostics: summary.diagnostics.map((item) => ({ code: item.code, message: item.message.slice(0, 300) })) }));
      assert.deepEqual(summary.results.filter((item) => item.status === 'completed').map((item) => item.toolId), ['entity.create', 'transform.set']);
      assert.equal(scene.entities.length, 1);
      assert.deepEqual(scene.entities[0].transform.position, { x: 1, y: 2, z: 3 });
      summaries.push({ backend: backend.descriptor.kind, terminal: summary.terminal, tools: summary.results.map((item) => item.toolId), revision: value.workspace.snapshot().document.revision, credentialPersisted: false });
    } finally { coordinator.dispose(); await backend.dispose(); await dispose(value); }
  }
  console.log(JSON.stringify(summaries));
} finally {
  process.env.HAIYUE_STUDIO_ALLOW_REAL_G09_SMOKE = '';
}

async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-g09-real-project-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-g09-real-userdata-'));
  const operationLog = await OperationLog.open({ rootDirectory: path.join(userDataRoot, 'log'), appVersion: 'g09-real-smoke' });
  const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(userDataRoot) };
  const workspace = new ProjectWorkspace(resources); await workspace.newProject(projectRoot, 'G09 real backend smoke');
  const scene = new ProjectSceneAuthoringService(workspace, operationLog);
  const validator = new ScriptValidationWorker(); const projectScripts = new ProjectScriptService(workspace, validator, operationLog);
  const authorization = new PreviewAuthorizationService(projectScripts, validator, operationLog);
  const scripts = { snapshot: () => projectScripts.snapshot(), proposeEdit: (input) => projectScripts.proposeEdit(input), commitProposal: (proposalId, commandId, signal) => projectScripts.commitProposal(proposalId, commandId, signal), prepare: (scriptId, capabilities) => authorization.prepare(scriptId, capabilities), decide: (planId, approved, ttl) => authorization.decide(planId, approved, ttl), consume: (grantId) => authorization.consume(grantId) };
  const stopped = Object.freeze({ instanceId: null, state: 'stopped', entityId: null, position: null, disposableCount: 0, errors: Object.freeze([]) });
  const preview = { async start() { throw new Error('Preview is outside this real smoke.'); }, async stop() { return stopped; }, snapshot() { return stopped; } };
  const runtime = new GameAuthoringToolRuntime({ workspace, scene, scripts, diagnostics: operationLog.diagnosticsService(), operationLog, preview });
  return { operationLog, resources, workspace, scene, validator, projectScripts, runtime };
}
async function dispose(value) { value.runtime.dispose(); value.scene.dispose(); value.projectScripts.dispose(); await value.validator.dispose(); await value.workspace.dispose(); value.resources.tasks.dispose(); await value.resources.documents.dispose(); value.resources.history.dispose(); value.resources.projectSession.dispose(); await value.operationLog.close(); }
