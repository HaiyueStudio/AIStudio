import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { ProjectWorkspace, RecentProjectStore } from '@haiyue/ai-studio-editor-plugins';
import {
  IsolatedTrustedPreviewRuntime,
  PreviewAuthorizationService,
  ProjectScriptService,
  ScriptValidationWorker,
} from '../dist/index.js';

const movementScript = `
const transform = entity.getComponent('CartesianTransform3D') as unknown as { setPosition(x: number, y: number, z: number): unknown } | null;
transform?.setPosition(time / 1000, 0, 0);
`;

async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-script-project-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-script-userdata-'));
  const operationLog = await OperationLog.open({ rootDirectory: path.join(userDataRoot, 'log'), appVersion: 'test' });
  const resources = {
    documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(),
    projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(userDataRoot),
  };
  const workspace = new ProjectWorkspace(resources);
  const validator = new ScriptValidationWorker();
  const scripts = new ProjectScriptService(workspace, validator, operationLog);
  await workspace.newProject(projectRoot, 'Script fixture');
  return { projectRoot, userDataRoot, operationLog, resources, workspace, validator, scripts };
}

test('worker returns stable syntax, type and forbidden-capability diagnostics and invalidates late revisions', async () => {
  const worker = new ScriptValidationWorker();
  try {
    const scriptId = asStableId('script:validation');
    const valid = await worker.validate({ scriptId, textRevision: 1, sourcePath: 'scripts/test.ts', text: movementScript });
    assert.deepEqual(valid.diagnostics, []);
    assert.match(valid.emittedText, /setPosition/);
    const invalid = await worker.validate({ scriptId, textRevision: 2, sourcePath: 'scripts/test.ts', text: `const value: number = 'bad';\nfetch('https://invalid');` });
    assert.ok(invalid.diagnostics.some((item) => item.code === 'script.ts.2322' && item.line === 1), JSON.stringify(invalid.diagnostics));
    assert.ok(invalid.diagnostics.some((item) => item.code === 'script.capability.global-forbidden' && item.line === 2), JSON.stringify(invalid.diagnostics));
    const exported = await worker.validate({ scriptId, textRevision: 3, sourcePath: 'scripts/test.ts', text: 'export function start(): void {}' });
    assert.ok(exported.diagnostics.some((item) => item.code === 'script.capability.module-forbidden' && item.line === 1), JSON.stringify(exported.diagnostics));
    assert.match(exported.emittedText, /exports/);
    const instanced = await worker.validate({
      scriptId, textRevision: 4, sourcePath: 'scripts/test.ts', capabilities: ['read', 'scene'],
      text: `const body = api.scene.instances('SnakeBody', 256);\nbody.setCount(3);\nbody.set(0, { position: { x: 0, y: 0, z: 0 } });`,
    });
    assert.deepEqual(instanced.diagnostics, []);
    const inferredScene = await worker.validate({
      scriptId, textRevision: 5, sourcePath: 'scripts/test.ts', capabilities: ['read', 'input', 'debug'],
      text: `const body = api.scene.instances('SnakeBody', 256);\nbody.setCount(3);\nbody.set(0, { position: { x: 0, y: 0, z: 0 } });`,
    });
    assert.deepEqual(inferredScene.capabilities, ['read', 'input', 'debug', 'scene']);
    assert.deepEqual(inferredScene.diagnostics, []);
    const first = worker.validate({ scriptId, textRevision: 3, sourcePath: 'scripts/test.ts', text: movementScript });
    const second = worker.validate({ scriptId, textRevision: 4, sourcePath: 'scripts/test.ts', text: movementScript });
    assert.equal((await first).stale, true);
    assert.equal((await second).stale, false);
  } finally { await worker.dispose(); }
});

test('script proposal commits through History and survives undo, redo, save and reopen', async () => {
  const value = await fixture();
  const entityId = asStableId('entity:cube');
  const proposal = await value.scripts.proposeEdit({ entityId, text: movementScript, baseRevision: 1 });
  assert.equal(proposal.diagnostics.length, 0);
  assert.equal(proposal.addedLines > 0, true);
  const committed = await value.scripts.commitProposal(proposal.id, asStableId('command:script-edit'));
  assert.equal(committed.textRevision, 1);
  assert.equal(value.workspace.snapshot().document.revision, 2);
  await value.workspace.undo(2);
  assert.equal(value.scripts.snapshot().resources.length, 0);
  await value.workspace.redo(3);
  assert.equal(value.scripts.snapshot().resources[0].text, movementScript);
  await value.workspace.save();
  await value.workspace.reopen();
  assert.equal(value.scripts.snapshot().resources[0].dirty, false);
  await dispose(value);
});

test('authorization is explicit, one-shot and stale-safe; runtime is isolated and cleans hot-reload disposers', async () => {
  const value = await fixture();
  try {
  const entityId = asStableId('entity:cube');
  const proposal = await value.scripts.proposeEdit({ entityId, text: movementScript, baseRevision: 1 });
  const script = await value.scripts.commitProposal(proposal.id, asStableId('command:script-runtime'));
  const authorization = new PreviewAuthorizationService(value.scripts, value.validator, value.operationLog, () => 1_000);
  const plan = await authorization.prepare(script.id);
  assert.equal(plan.risk, 'trusted-project');
  const grant = await authorization.decide(plan.id, true);
  const consumed = authorization.consume(grant.id);
  assert.equal(consumed.digest, plan.digest);
  assert.throws(() => authorization.consume(grant.id), /already consumed/);

  const runtime = new IsolatedTrustedPreviewRuntime(value.operationLog);
  const scene = {
    schemaVersion: 1, revision: 1, documentId: value.scripts.snapshot().documentId,
    entities: [{ id: entityId, name: 'Cube', kind: 'cube', parentId: null, order: 0, transform: {
      position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    } }],
  };
  await runtime.start(scene, consumed);
  assert.equal(runtime.tick(500, 16).position.x, 0.5);
  runtime.hotReload(`if (!component.bound) { component.bound = true; api.debug.setInterval(() => {}, 1000); }`);
  assert.equal(runtime.tick(600, 16).disposableCount, 1);
  const restarted = await runtime.start(scene, consumed);
  assert.equal(restarted.state, 'playing');
  assert.equal(restarted.disposableCount, 0);
  assert.ok(Math.abs(runtime.tick(650, 16).position.x - 0.65) < 0.000_001);
  runtime.hotReload(`if (!component.bound) { component.bound = true; api.debug.setInterval(() => {}, 1000); }`);
  assert.equal(runtime.tick(675, 16).disposableCount, 1);
  runtime.hotReload(`throw new Error('runtime boom');`);
  const faulted = runtime.tick(700, 16);
  assert.equal(faulted.state, 'faulted');
  assert.equal(faulted.errors[0].line, 1);
  const stopped = await runtime.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.disposableCount, 0);
  assert.deepEqual(value.scripts.snapshot().resources[0].text, movementScript);
  await value.workspace.closeProject();
  assert.equal(value.scripts.snapshot().resources.length, 0);
  const replacementRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-script-replacement-'));
  await value.workspace.newProject(replacementRoot, 'Replacement document');
  assert.equal(value.scripts.snapshot().resources.length, 0);
  } finally { await dispose(value); }
});

async function dispose(value) {
  value.scripts.dispose();
  await value.validator.dispose();
  await value.workspace.dispose();
  value.resources.tasks.dispose(); await value.resources.documents.dispose(); value.resources.history.dispose(); value.resources.projectSession.dispose();
  await value.operationLog.close();
}
