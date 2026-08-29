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
  studioScriptRuntimeDeclarations,
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
  const entityId = asStableId('entity:cube');
  await workspace.executeBatch({ id: asStableId('command:create-script-entity'), label: 'Create script entity', baseRevision: 1, operations: [
    { op: 'entity.add', entity: { id: entityId, sceneId: workspace.primarySceneId(), name: 'Cube', parentId: null, order: 0, componentIds: [] } },
    { op: 'component.add', entityId, component: workspace.componentRegistry.create({ id: asStableId('component:script-transform'), type: asStableId('haiyue.transform.3d'), version: '1.0.0' }) },
  ] });
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
    const forbidden = await worker.validate({
      scriptId, textRevision: 4, sourcePath: 'scripts/forbidden.ts',
      text: `navigator.sendBeacon('/collect');\ndocument.body.textContent = 'x';\nprocess.exit(1);\nsetTimeout(() => {}, 1);\nnew Worker('worker.js');\nlocalStorage.clear();\nshowOpenFilePicker();\nimport('./other.js');`,
    });
    for (const line of [1, 2, 3, 4, 5, 6, 7]) {
      assert.ok(forbidden.diagnostics.some((item) => item.code === 'script.capability.global-forbidden' && item.line === line), JSON.stringify(forbidden.diagnostics));
    }
    assert.ok(forbidden.diagnostics.some((item) => item.code === 'script.capability.module-forbidden' && item.line === 8), JSON.stringify(forbidden.diagnostics));
    const instanced = await worker.validate({
      scriptId, textRevision: 5, sourcePath: 'scripts/test.ts', capabilities: ['read', 'scene'],
      text: `const body = api.scene.instances('SnakeBody', 256);\nbody.setCount(3);\nbody.set(0, { position: { x: 0, y: 0, z: 0 } });`,
    });
    assert.deepEqual(instanced.diagnostics, []);
    const inferredScene = await worker.validate({
      scriptId, textRevision: 6, sourcePath: 'scripts/test.ts', capabilities: ['read', 'input', 'debug'],
      text: `const body = api.scene.instances('SnakeBody', 256);\nbody.setCount(3);\nbody.set(0, { position: { x: 0, y: 0, z: 0 } });`,
    });
    assert.deepEqual(inferredScene.capabilities, ['read', 'input', 'debug', 'scene']);
    assert.deepEqual(inferredScene.diagnostics, []);
    const inferredPhysics = await worker.validate({
      scriptId, textRevision: 7, sourcePath: 'scripts/physics.ts', capabilities: ['read', 'input', 'debug'],
      text: `const body = api.physics.body(entity);\napi.physics.applyImpulse(entity, { x: 0, y: 5, z: 0 });\napi.debug.console.log(body);`,
    });
    assert.deepEqual(inferredPhysics.capabilities, ['read', 'input', 'debug', 'physics']);
    assert.deepEqual(inferredPhysics.diagnostics, []);
    const physicsDeclarations = studioScriptRuntimeDeclarations(['read', 'physics']);
    assert.match(physicsDeclarations, /interface HaiyueScriptPhysicsApi/);
    assert.match(physicsDeclarations, /readonly physics: HaiyueScriptPhysicsApi/);
    assert.doesNotMatch(physicsDeclarations, /readonly input: HaiyueScriptInputApi/);
    const first = worker.validate({ scriptId, textRevision: 3, sourcePath: 'scripts/test.ts', text: movementScript });
    const second = worker.validate({ scriptId, textRevision: 4, sourcePath: 'scripts/test.ts', text: movementScript });
    assert.equal((await first).stale, true);
    assert.equal((await second).stale, false);
  } finally {
    await worker.dispose();
    await assert.rejects(worker.validate({ scriptId: asStableId('script:disposed'), textRevision: 1, sourcePath: 'scripts/disposed.ts', text: '' }), /disposed/);
  }
});

test('worker resolves injected Engine declarations independently of the launch directory', async () => {
  const launchDirectory = await mkdtemp(path.join(tmpdir(), 'haiyue-script-launch-'));
  const originalDirectory = process.cwd();
  let worker;
  process.chdir(launchDirectory);
  try {
    worker = new ScriptValidationWorker();
    const result = await worker.validate({
      scriptId: asStableId('script:cwd-independent'),
      textRevision: 1,
      sourcePath: 'scripts/cwd-independent.ts',
      text: movementScript,
    });
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await worker?.dispose();
    process.chdir(originalDirectory);
  }
});

test('script proposal commits through History and survives undo, redo, save and reopen', async () => {
  const value = await fixture();
  try {
  const entityId = asStableId('entity:cube');
  await assert.rejects(value.scripts.proposeEdit({ entityId: asStableId('entity:missing'), text: movementScript, baseRevision: 2 }), /does not exist/);
  const invalid = await value.scripts.proposeEdit({ entityId, text: `const value: number = 'invalid';`, baseRevision: 2 });
  assert.ok(invalid.diagnostics.some((item) => item.code === 'script.ts.2322'));
  await assert.rejects(value.scripts.commitProposal(invalid.id, asStableId('command:invalid-script')), /validation errors/);
  const proposal = await value.scripts.proposeEdit({ entityId, text: movementScript, baseRevision: 2, capabilities: ['read', 'debug'] });
  assert.equal(proposal.diagnostics.length, 0);
  assert.equal(proposal.addedLines > 0, true);
  const committed = await value.scripts.commitProposal(proposal.id, asStableId('command:script-edit'));
  assert.equal(committed.textRevision, 1);
  assert.equal(committed.capabilities.includes('debug'), true);
  assert.equal(value.workspace.snapshot().document.revision, 3);
  await value.workspace.undo(3);
  assert.equal(value.scripts.snapshot().resources.length, 0);
  await value.workspace.redo(4);
  assert.equal(value.scripts.snapshot().resources[0].text, movementScript);
  await value.workspace.save();
  await value.workspace.reopen();
  assert.equal(value.scripts.snapshot().resources[0].dirty, false);
  assert.deepEqual(value.scripts.snapshot().resources[0].capabilities, ['read', 'debug']);
  } finally { await dispose(value); }
});

test('authorization is explicit, one-shot and stale-safe; runtime is isolated and cleans hot-reload disposers', async () => {
  const value = await fixture();
  try {
  const entityId = asStableId('entity:cube');
  const proposal = await value.scripts.proposeEdit({ entityId, text: movementScript, baseRevision: 2 });
  const script = await value.scripts.commitProposal(proposal.id, asStableId('command:script-runtime'));
  const clock = { value: 1_000 };
  const authorization = new PreviewAuthorizationService(value.scripts, value.validator, value.operationLog, () => clock.value);
  const plan = await authorization.prepare({ scriptIds: [script.id] });
  assert.equal(plan.risk, 'trusted-project');
  assert.equal(plan.scripts.length, 1);
  const grant = await authorization.decide(plan.id, true);
  const consumed = authorization.consume(grant.id);
  assert.equal(consumed.scriptSetDigest, plan.scriptSetDigest);
  assert.throws(() => authorization.consume(grant.id), /already consumed/);

  const runtime = new IsolatedTrustedPreviewRuntime(value.operationLog);
  const scene = {
    schemaVersion: 1, revision: plan.documentRevision, documentId: value.scripts.snapshot().documentId,
    entities: [{ id: entityId, name: 'Cube', kind: 'cube', parentId: null, order: 0, transform: {
      position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    } }],
  };
  await runtime.start(scene, consumed);
  assert.equal(runtime.tick(500, 16).position.x, 0.5);
  runtime.hotReload(script.id, `if (!component.bound) { component.bound = true; api.debug.setInterval(() => {}, 1000); }`);
  assert.equal(runtime.tick(600, 16).disposableCount, 1);
  const [rapidRestartA, rapidRestartB] = await Promise.all([runtime.start(scene, consumed), runtime.start(scene, consumed)]);
  assert.equal(rapidRestartA.state, 'playing');
  assert.equal(rapidRestartB.state, 'playing');
  assert.equal(runtime.snapshot().disposableCount, 0);
  assert.ok(Math.abs(runtime.tick(650, 16).position.x - 0.65) < 0.000_001);
  runtime.hotReload(script.id, `if (!component.bound) { component.bound = true; api.debug.setInterval(() => {}, 1000); }`);
  assert.equal(runtime.tick(675, 16).disposableCount, 1);
  runtime.hotReload(script.id, `throw new Error('runtime boom');`);
  const faulted = runtime.tick(700, 16);
  assert.equal(faulted.state, 'faulted');
  assert.equal(faulted.errors[0].line, 1);
  const stopped = await runtime.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.disposableCount, 0);
  assert.deepEqual(value.scripts.snapshot().resources[0].text, movementScript);

  const invalidTtlPlan = await authorization.prepare({ scriptIds: [script.id] });
  await assert.rejects(authorization.decide(invalidTtlPlan.id, true, 0), /TTL/);
  const expiredPlan = await authorization.prepare({ scriptIds: [script.id] });
  const expiredGrant = await authorization.decide(expiredPlan.id, true, 10);
  clock.value = 1_011;
  assert.throws(() => authorization.consume(expiredGrant.id), /expired/);
  clock.value = 2_000;
  const stalePlan = await authorization.prepare({ scriptIds: [script.id] });
  const staleGrant = await authorization.decide(stalePlan.id, true, 10_000);
  await value.workspace.execute({ id: asStableId('command:stale-preview'), label: 'Advance document revision', baseRevision: 3, key: 'fixture.stale', value: true });
  assert.throws(() => authorization.consume(staleGrant.id), /stale|missing or already consumed/);

  const facts = await value.operationLog.query({ limit: 200, traverseCorrelation: false });
  const kinds = new Set(facts.events.map((event) => event.kind));
  for (const kind of ['script/proposal-ready', 'script/edit-committed', 'preview/approval-ready', 'preview/authorized', 'preview/started', 'preview/runtime-error', 'preview/stopped']) {
    assert.equal(kinds.has(kind), true, `missing operation log event ${kind}`);
  }
  assert.equal(JSON.stringify(facts.events).includes(movementScript), false, 'operation log must not retain script source');
  await value.workspace.closeProject();
  assert.equal(value.scripts.snapshot().resources.length, 0);
  const replacementRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-script-replacement-'));
  await value.workspace.newProject(replacementRoot, 'Replacement document');
  assert.equal(value.scripts.snapshot().resources.length, 0);
  authorization.dispose();
  } finally { await dispose(value); }
});

test('one Play owner runs the exact enabled script set in stable order and isolates per-script faults and scopes', async () => {
  const value = await fixture();
  const authorization = new PreviewAuthorizationService(value.scripts, value.validator, value.operationLog);
  try {
    const leaderId = asStableId('entity:cube');
    const leaderProposal = await value.scripts.proposeEdit({ entityId: leaderId, baseRevision: 2, text: `
const transform = entity.getComponent('CartesianTransform3D') as unknown as { position: readonly number[]; setPosition(x: number, y: number, z: number): unknown };
transform.setPosition(transform.position[0] + 1, 0, 0);
` });
    const leaderScript = await value.scripts.commitProposal(leaderProposal.id, asStableId('command:multi-leader'));
    const followerId = asStableId('entity:follower');
    await value.workspace.executeBatch({ id: asStableId('command:multi-follower-entity'), label: 'Create follower', baseRevision: 3, operations: [
      { op: 'entity.add', entity: { id: followerId, sceneId: value.workspace.primarySceneId(), name: 'Follower', parentId: null, order: 1, componentIds: [] } },
      { op: 'component.add', entityId: followerId, component: value.workspace.componentRegistry.create({ id: asStableId('component:multi-follower-transform'), type: asStableId('haiyue.transform.3d'), version: '1.0.0' }) },
    ] });
    const followerProposal = await value.scripts.proposeEdit({ entityId: followerId, baseRevision: 4, text: `
const leader = api.read.find('Cube');
const leaderTransform = leader?.getComponent('CartesianTransform3D') as unknown as { position: readonly number[] } | null;
const transform = entity.getComponent('CartesianTransform3D') as unknown as { position: readonly number[]; setPosition(x: number, y: number, z: number): unknown };
transform.setPosition((leaderTransform?.position[0] ?? -100) + 10, transform.position[1] + 1, 0);
` });
    const followerScript = await value.scripts.commitProposal(followerProposal.id, asStableId('command:multi-follower'));

    const plan = await authorization.prepare();
    assert.deepEqual(plan.scripts.map((script) => script.scriptId), [leaderScript.id, followerScript.id]);
    assert.equal(plan.scriptSetDigest.startsWith('sha256:'), true);
    assert.deepEqual(plan.runtimeConfig, { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'haiyue-play' });
    const grant = await authorization.decide(plan.id, true);
    const consumed = authorization.consume(grant.id);
    const scene = {
      schemaVersion: 1, revision: plan.documentRevision, documentId: plan.documentId,
      entities: [
        { id: leaderId, name: 'Cube', kind: 'cube', parentId: null, order: 0, transform: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
        { id: followerId, name: 'Follower', kind: 'cube', parentId: null, order: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
      ],
    };
    const runtime = new IsolatedTrustedPreviewRuntime(value.operationLog);
    const started = await runtime.start(scene, consumed);
    assert.equal(started.scriptCount, 2);
    const firstTick = runtime.tick(16, 16);
    assert.deepEqual(firstTick.scripts.map((script) => script.position), [{ x: 1, y: 0, z: 0 }, { x: 11, y: 1, z: 0 }]);
    runtime.hotReload(leaderScript.id, `throw new Error('leader failed');`);
    const degraded = runtime.tick(32, 16);
    assert.equal(degraded.state, 'faulted');
    assert.equal(degraded.scripts[0].state, 'faulted');
    assert.deepEqual(degraded.scripts[1].position, { x: 11, y: 2, z: 0 }, 'healthy follower keeps ticking after leader fault');
    runtime.hotReload(leaderScript.id, `if (!component.bound) { component.bound = true; api.debug.setInterval(() => {}, 1000); }`);
    runtime.hotReload(followerScript.id, `if (!component.bound) { component.bound = true; api.debug.setInterval(() => {}, 1000); }`);
    assert.equal(runtime.tick(48, 16).disposableCount, 2);
    assert.equal((await runtime.stop()).disposableCount, 0);
    assert.deepEqual(runtime.snapshot().scripts, []);

    const subset = await authorization.prepare({ scriptIds: [followerScript.id] });
    assert.deepEqual(subset.scripts.map((script) => script.scriptId), [followerScript.id]);
    const revoked = await authorization.decide(subset.id, true);
    authorization.dispose();
    assert.throws(() => authorization.consume(revoked.id), /disposed/);
  } finally { authorization.dispose(); await dispose(value); }
});

test('preview start fails closed and releases the isolated world when durable logging fails', async () => {
  const runtime = new IsolatedTrustedPreviewRuntime({ append: async () => { throw new Error('log unavailable'); } });
  const entityId = asStableId('entity:log-failure');
  const scene = {
    schemaVersion: 1, revision: 1, documentId: asStableId('document:log-failure'),
    entities: [{ id: entityId, name: 'Cube', kind: 'cube', parentId: null, order: 0, transform: {
      position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    } }],
  };
  const plan = {
    id: asStableId('preview-plan:log-failure'), documentId: asStableId('document:log-failure'), documentRevision: 1, selection: 'explicit',
    scriptSetDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    scripts: [{ scriptId: asStableId('script:log-failure'), entityId, order: 0, textRevision: 1, digest: 'digest', capabilities: ['read'], diagnostics: [], emittedText: '' }],
    capabilities: ['read'], runtimeConfig: { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'haiyue-play' }, risk: 'trusted-project', diagnostics: [],
  };
  await assert.rejects(runtime.start(scene, plan), /log unavailable/);
  assert.deepEqual(runtime.snapshot(), {
    instanceId: null, state: 'stopped', scriptSetDigest: null, scriptCount: 0, scripts: [], entityId: null, position: null, disposableCount: 0, errors: [],
  });
});

async function dispose(value) {
  value.scripts.dispose();
  await value.validator.dispose();
  await value.workspace.dispose();
  value.resources.tasks.dispose(); await value.resources.documents.dispose(); value.resources.history.dispose(); value.resources.projectSession.dispose();
  await value.operationLog.close();
}
