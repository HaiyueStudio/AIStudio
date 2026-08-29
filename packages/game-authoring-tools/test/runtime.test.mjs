import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { ProjectSceneAuthoringService, ProjectWorkspace, RecentProjectStore } from '@haiyue/ai-studio-editor-plugins';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { PreviewAuthorizationService, ProjectScriptService, ScriptValidationWorker } from '@haiyue/ai-studio-script-preview';
import { AgentGameAuthoringCoordinator, GAME_AUTHORING_TOOL_DEFINITIONS, GameAuthoringToolRuntime } from '../dist/index.js';

const movementScript = `
const transform = entity.getComponent('CartesianTransform3D') as unknown as { setPosition(x: number, y: number, z: number): unknown } | null;
transform?.setPosition(time / 1000, 0, 0);
`;

const runtimeFailureScript = `throw new Error('fixture runtime failure');`;
const repairedRuntimeScript = `
const transform = entity.getComponent('CartesianTransform3D') as unknown as { setPosition(x: number, y: number, z: number): unknown } | null;
transform?.setPosition(0, 1, 0);
`;

test('bounded tool catalog exposes registry-driven component authoring', () => {
  assert.deepEqual(GAME_AUTHORING_TOOL_DEFINITIONS.map((item) => item.id), [
    'project.snapshot', 'engine.capabilities.describe', 'component.describe', 'component.get',
    'camera.get', 'scene.list-entities', 'entity.get', 'script.get', 'diagnostics.query', 'asset.search',
    'camera.set', 'entity.create', 'entity.rename', 'transform.set', 'material.set',
    'component.add', 'component.set', 'component.remove', 'asset.import', 'asset.assign', 'script.propose', 'script.apply',
    'preview.validate', 'preview.start', 'preview.stop', 'play.start', 'play.stop', 'play.step', 'play.input', 'play.inspect', 'play.capture', 'task.evaluate',
  ]);
  assert.ok(GAME_AUTHORING_TOOL_DEFINITIONS.every((item) => item.version === '1.0.0' && item.timeoutMs <= 20_000 && item.maxResultBytes <= 65_536));
  assert.match(GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'script.propose').description, /time and delta are milliseconds/);
  assert.match(GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'script.propose').description, /viewport-normalized 0\.\.1/);
  assert.match(GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'script.propose').description, /hudText/);
  assert.deepEqual(
    GAME_AUTHORING_TOOL_DEFINITIONS.filter((item) => item.id === 'entity.create').map((item) => ({ risk: item.risk, requiresApproval: item.requiresApproval })),
    [{ risk: 'low', requiresApproval: false }],
  );
  assert.doesNotMatch(JSON.stringify(GAME_AUTHORING_TOOL_DEFINITIONS), /shell|network|filesystem|delete|package|git/i);
});

test('main project camera persists through History and supports a distortion-free top-down board view', async () => {
  const value = await fixture();
  const topDown = {
    projection: 'orthographic', target: { x: 0, y: 0, z: 0 }, distance: 25,
    azimuthDegrees: 0, elevationDegrees: 90, fovDegrees: 45, orthographicSize: 24, near: 0.1, far: 1_000,
  };
  try {
    const initial = await executeReady(value.runtime, call('call:camera-get-initial', 'camera.get', {}));
    assert.equal(initial.value.camera.projection, 'perspective');
    const prepared = await value.runtime.prepare(call('call:camera-top-down', 'camera.set', { baseRevision: 1, camera: topDown }));
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.approvalId, undefined);
    const changed = await value.runtime.execute(prepared.id);
    assert.equal(changed.afterRevision, 2);
    assert.equal(changed.historyLabel, 'Set Camera');
    assert.deepEqual(changed.value.camera, topDown);
    assert.deepEqual(value.workspace.snapshot().document.settings['studio.camera.main'], topDown);

    await value.workspace.undo(2);
    const undone = await executeReady(value.runtime, call('call:camera-get-undone', 'camera.get', {}));
    assert.equal(undone.value.camera.projection, 'perspective');
    await value.workspace.redo(3);
    const redone = await executeReady(value.runtime, call('call:camera-get-redone', 'camera.get', {}));
    assert.deepEqual(redone.value.camera, topDown);
  } finally { await dispose(value); }
});

test('planned entity creation is low risk while later scoped edits retain one-shot approval and History', async () => {
  const value = await fixture();
  try {
    const create = await value.runtime.prepare(call('call:create', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Player' }));
    assert.equal(create.status, 'ready');
    assert.equal(create.approvalId, undefined);
    const created = await value.runtime.execute(create.id);
    assert.equal(created.afterRevision, 2);
    assert.equal(created.historyLabel, 'Create Scene Entity');
    const entityId = created.value.entity.id;
    assert.equal(value.scene.snapshot().entities[0].name, 'Player');

    const rename = await value.runtime.prepare(call('call:rename', 'entity.rename', { baseRevision: 2, entityId, name: 'Hero' }));
    assert.equal(rename.status, 'approval-required');
    await assert.rejects(value.runtime.execute(rename.id), /requires approval/);
    await value.runtime.decide(rename.approvalId, 'allow-once');
    await assert.rejects(value.runtime.decide(rename.approvalId, 'allow-once'), /not pending/);
    const renamed = await value.runtime.execute(rename.id);
    assert.equal(renamed.afterRevision, 3);
    assert.equal(value.scene.snapshot().entities[0].name, 'Hero');
    await value.workspace.undo(3);
    assert.equal(value.scene.snapshot().entities[0].name, 'Player');
    await value.workspace.redo(4);
    assert.equal(value.scene.snapshot().entities[0].name, 'Hero');

    const facts = await value.operationLog.query({ toolCallId: asStableId('call:rename'), limit: 50, traverseCorrelation: false });
    assert.deepEqual(facts.events.filter((item) => item.kind.startsWith('tool/') || item.kind.startsWith('approval/')).map((item) => item.kind), [
      'tool/call-received', 'tool/pre-policy-passed', 'tool/preview-prepared', 'approval/requested', 'approval/allow-once', 'tool/execution-started', 'tool/execution-completed',
    ]);
    assert.doesNotMatch(JSON.stringify(facts.events), /"name":"Hero"/);
  } finally { await dispose(value); }
});

test('controlled project assets import, search, assign, undo and survive project reopen', async () => {
  const value = await fixture();
  try {
    await mkdir(path.join(value.projectRoot, 'assets', 'textures'), { recursive: true });
    await writeFile(path.join(value.projectRoot, 'assets', 'textures', 'player.png'), pngHeader(2, 2));
    const created = await executeReady(value.runtime, call('call:asset-entity', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Textured Player' }));
    const entityId = created.value.entity.id;

    await assert.rejects(
      value.runtime.prepare(call('call:asset-traversal', 'asset.import', { baseRevision: 2, projectPath: 'assets/../outside.png', kind: 'texture', mimeType: 'image/png', license: 'project-owned', provenance: 'test fixture', decodedBytes: 8 })),
      /project assets directory/,
    );

    const imported = await approveAndExecute(value.runtime, call('call:asset-import', 'asset.import', {
      baseRevision: 2, projectPath: 'assets/textures/player.png', kind: 'texture', mimeType: 'image/png',
      license: 'project-owned', provenance: 'runtime test fixture', decodedBytes: 64, width: 2, height: 2,
    }));
    assert.equal(imported.afterRevision, 3);
    assert.equal(imported.historyLabel, 'Import Asset');
    assert.match(imported.value.asset.id, /^asset:[a-f0-9]{24}$/);
    assert.equal(value.workspace.gameSnapshot().assets.length, 1);
    assert.equal(value.scene.snapshot().assets[0].id, imported.value.asset.id);

    const search = await executeReady(value.runtime, call('call:asset-search', 'asset.search', { text: 'player', kind: 'texture', limit: 10 }));
    assert.equal(search.value.count, 1);
    assert.equal(search.value.assets[0].projectPath, 'assets/textures/player.png');
    assert.equal(search.value.assets[0].license, 'project-owned');
    assert.equal('bytes' in search.value.assets[0], false);

    const assigned = await approveAndExecute(value.runtime, call('call:asset-assign', 'asset.assign', { baseRevision: 3, entityId, assetId: imported.value.asset.id, usage: 'texture.base-color' }));
    assert.equal(assigned.afterRevision, 4);
    assert.equal(assigned.historyLabel, 'Assign Asset');
    assert.equal(assigned.value.component.type, 'haiyue.material.pbr');
    assert.equal(assigned.value.component.value.baseColorAssetId, imported.value.asset.id);

    await value.workspace.undo(4);
    assert.equal(value.workspace.queryGameDocument({ entityId, limit: 256 }).components.some((item) => item.type === 'haiyue.material.pbr'), false);
    await value.workspace.redo(5);
    assert.equal(value.workspace.queryGameDocument({ entityId, limit: 256 }).components.find((item) => item.type === 'haiyue.material.pbr').value.baseColorAssetId, imported.value.asset.id);

    await value.workspace.save();
    await value.workspace.closeProject();
    await value.workspace.openProject(value.projectRoot);
    const reopened = await executeReady(value.runtime, call('call:asset-search-reopened', 'asset.search', { limit: 10 }));
    assert.equal(reopened.value.count, 1);
    assert.equal(reopened.value.assets[0].digest, imported.value.asset.digest);
    assert.equal(value.scene.snapshot().assets[0].digest, imported.value.asset.digest);
  } finally { await dispose(value); }
});

test('controlled asset import rejects decode-budget and kind/format violations without mutation', async () => {
  const value = await fixture();
  try {
    await mkdir(path.join(value.projectRoot, 'assets'), { recursive: true });
    await writeFile(path.join(value.projectRoot, 'assets', 'bad.png'), Buffer.from([1, 2, 3, 4]));
    const prepared = await value.runtime.prepare(call('call:asset-budget', 'asset.import', { baseRevision: 1, projectPath: 'assets/bad.png', kind: 'texture', mimeType: 'image/png', license: 'internal-test', provenance: 'failure fixture', decodedBytes: 2 }));
    await value.runtime.decide(prepared.approvalId, 'allow-once');
    await assert.rejects(value.runtime.execute(prepared.id), (error) => error.code === 'asset.decode-budget');
    assert.equal(value.workspace.gameSnapshot().revision, 1);
    assert.equal(value.workspace.gameSnapshot().assets.length, 0);

    const format = await value.runtime.prepare(call('call:asset-format', 'asset.import', { baseRevision: 1, projectPath: 'assets/bad.png', kind: 'model', mimeType: 'model/gltf-binary', license: 'internal-test', provenance: 'failure fixture', decodedBytes: 4 }));
    await value.runtime.decide(format.approvalId, 'allow-once');
    await assert.rejects(value.runtime.execute(format.id), (error) => error.code === 'asset.format-not-allowed');
    assert.equal(value.workspace.gameSnapshot().revision, 1);
  } finally { await dispose(value); }
});

test('diagnostics query returns redacted bounded pages with a query-bound cursor and no raw payload', async () => {
  const value = await fixture();
  try {
    await executeReady(value.runtime, call('call:diagnostic-source-1', 'project.snapshot', {}));
    await executeReady(value.runtime, call('call:diagnostic-source-2', 'scene.list-entities', {}));
    const first = await executeReady(value.runtime, call('call:diagnostics-page-1', 'diagnostics.query', { limit: 2, traverseCorrelation: false }));
    assert.equal(first.value.count, 2);
    assert.equal(typeof first.value.nextCursor, 'string');
    assert.doesNotMatch(JSON.stringify(first.value.events), /"payload"|projectRoot|authorization/i);
    assert.ok(first.value.events.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.payloadDigest)));
    const second = await executeReady(value.runtime, call('call:diagnostics-page-2', 'diagnostics.query', { limit: 2, traverseCorrelation: false, cursor: first.value.nextCursor }));
    assert.equal(second.value.count, 2);
    assert.notDeepEqual(second.value.events.map((item) => item.eventId), first.value.events.map((item) => item.eventId));
  } finally { await dispose(value); }
});

test('allow always auto-approves only the same tool, version, target and project session scope', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-always-target', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'First' }));
    const first = await value.runtime.prepare(call('call:always-first', 'entity.rename', { baseRevision: 2, entityId: created.value.entity.id, name: 'First Rename' }));
    assert.equal(first.status, 'approval-required');
    assert.equal((await value.runtime.decide(first.approvalId, 'allow-always')).decision, 'allow-always');
    await value.runtime.execute(first.id);
    assert.equal(value.runtime.snapshot().activeApprovalGrants, 1);

    const second = await value.runtime.prepare(call('call:always-second', 'entity.rename', { baseRevision: 3, entityId: created.value.entity.id, name: 'Second Rename' }));
    assert.equal(second.status, 'ready');
    assert.equal(second.approvalId, undefined);
    await value.runtime.execute(second.id);

    const differentTool = await value.runtime.prepare(call('call:always-material', 'material.set', { baseRevision: 4, entityId: created.value.entity.id, material: 'pbr' }));
    assert.equal(differentTool.status, 'approval-required');
    const differentSession = await value.runtime.prepare({ ...call('call:always-other-session', 'entity.rename', { baseRevision: 4, entityId: created.value.entity.id, name: 'Other Session' }), sessionId: 'session:other' });
    assert.equal(differentSession.status, 'approval-required');
    const facts = await value.operationLog.query({ toolCallId: asStableId('call:always-second'), limit: 20, traverseCorrelation: false });
    assert.deepEqual(facts.events.filter((item) => item.kind.startsWith('tool/') || item.kind.startsWith('approval/')).map((item) => item.kind), [
      'tool/call-received', 'tool/pre-policy-passed', 'tool/preview-prepared', 'approval/auto-allowed', 'tool/execution-started', 'tool/execution-completed',
    ]);
  } finally { await dispose(value); }
});

test('script proposal, trusted apply and runtime start preserve separate approvals', async () => {
  const value = await fixture();
  try {
    const create = await approveAndExecute(value.runtime, call('call:create-script-entity', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Runner' }));
    const entityId = create.value.entity.id;
    const proposed = await executeReady(value.runtime, call('call:propose', 'script.propose', { baseRevision: 2, entityId, text: movementScript, capabilities: ['read', 'debug'] }));
    assert.equal(proposed.value.diagnostics.length, 0);
    assert.equal(value.workspace.snapshot().document.revision, 2);

    const apply = await value.runtime.prepare(call('call:apply', 'script.apply', { baseRevision: 2, proposalId: proposed.value.proposalId }));
    assert.equal(apply.effect, 'trusted-code');
    await assert.rejects(value.runtime.decide(apply.approvalId, 'allow-always'), /one-shot approval/);
    await value.runtime.decide(apply.approvalId, 'allow-once');
    const applied = await value.runtime.execute(apply.id);
    assert.equal(applied.afterRevision, 3);

    const validated = await executeReady(value.runtime, call('call:validate', 'preview.validate', {}));
    const start = await value.runtime.prepare(call('call:start', 'play.start', { baseRevision: 3, planId: validated.value.planId }));
    assert.notEqual(start.approvalId, apply.approvalId);
    await assert.rejects(value.runtime.decide(start.approvalId, 'allow-always'), /one-shot approval/);
    await value.runtime.decide(start.approvalId, 'allow-once');
    const started = await value.runtime.execute(start.id);
    assert.equal(started.value.state, 'playing');
    assert.equal(value.preview.starts, 1);
    const stepped = await executeReady(value.runtime, call('call:play-step', 'play.step', { count: 3 }));
    assert.equal(stepped.value.projection.stepped, 3);
    const injected = await executeReady(value.runtime, call('call:play-input', 'play.input', { event: { tick: 13, kind: 'action', action: 'move-left', phase: 'down', source: 'synthetic' } }));
    assert.equal(injected.value.projection.input.action, 'move-left');
    const inspected = await executeReady(value.runtime, call('call:play-inspect', 'play.inspect', {}));
    assert.match(inspected.value.observation.id, /^artifact:sha256:/);
    const captured = await executeReady(value.runtime, call('call:play-capture', 'play.capture', {}));
    assert.equal(captured.value.projection.byteLength, 8);
    assert.equal('base64' in captured.value, false);
    const evaluated = await executeReady(value.runtime, call('call:task-evaluate', 'task.evaluate', {
      taskSpec: { schemaVersion: 2, id: 'task:session:fixture', request: 'Verify score', visibleConstraints: [], budgetId: 'budget:fixture', requiredCapabilities: ['play.inspect'], acceptance: [{ id: 'acceptance:score', required: true, visibility: 'agent', category: 'functional', assertion: 'evidence state signal score equals 4' }] },
      observationIds: [inspected.value.observation.id],
    }));
    assert.equal(evaluated.value.status, 'pass');
    assert.deepEqual(evaluated.value.acceptanceResults[0].evidenceIds, [inspected.value.observation.id]);
    const stopped = await executeReady(value.runtime, call('call:stop', 'play.stop', {}));
    assert.equal(stopped.value.state, 'stopped');
    assert.equal(stopped.value.projection.cleanupComplete, true);
    assert.equal(value.preview.stops, 1);
  } finally { await dispose(value); }
});

test('invalid AI-generated module scripts must be rewritten before apply can be prepared', async () => {
  const value = await fixture();
  try {
    const create = await approveAndExecute(value.runtime, call('call:create-invalid-script-entity', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Invalid Script' }));
    const proposed = await executeReady(value.runtime, call('call:propose-invalid-module', 'script.propose', {
      baseRevision: 2, entityId: create.value.entity.id, text: 'export function start(): void {}', capabilities: ['read', 'debug'],
    }));
    assert.equal(proposed.value.canApply, false);
    assert.match(proposed.value.requiredAction, /Rewrite the complete script/);
    assert.ok(proposed.value.diagnostics.some((item) => item.code === 'script.capability.module-forbidden' && item.severity === 'error'));
    await assert.rejects(
      value.runtime.prepare(call('call:apply-invalid-module', 'script.apply', { baseRevision: 2, proposalId: proposed.value.proposalId })),
      /script\.capability\.module-forbidden[\s\S]*Rewrite and propose again/,
    );
    assert.equal(value.workspace.snapshot().document.revision, 2);
  } finally { await dispose(value); }
});

test('scene capability is inferred from api.scene source and survives proposal and preview validation', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-instance-target', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'SnakeBody' }));
    const source = `const body = api.scene.instances('SnakeBody', 256);\nbody.setCount(1);\nbody.set(0, { position: { x: 0, y: 0, z: 0 } });`;
    const proposed = await executeReady(value.runtime, call('call:propose-inferred-scene', 'script.propose', {
      baseRevision: created.afterRevision, entityId: created.value.entity.id, text: source, capabilities: ['read', 'input', 'debug'],
    }));
    assert.equal(proposed.value.canApply, true);
    assert.deepEqual(proposed.value.capabilities, ['read', 'input', 'debug', 'scene']);
    assert.deepEqual(proposed.value.diagnostics, []);

    const applied = await approveAndExecute(value.runtime, call('call:apply-inferred-scene', 'script.apply', {
      baseRevision: created.afterRevision, proposalId: proposed.value.proposalId,
    }));
    const validated = await executeReady(value.runtime, call('call:validate-inferred-scene', 'preview.validate', {}));
    assert.deepEqual(new Set(validated.value.capabilities), new Set(['read', 'input', 'debug', 'scene']));
    assert.deepEqual(validated.value.diagnostics, []);
  } finally { await dispose(value); }
});

test('preview validation rejects scenes that contain only logic entities', async () => {
  const value = await fixture();
  try {
    const create = await approveAndExecute(value.runtime, call('call:create-empty-script-entity', 'entity.create', { baseRevision: 1, kind: 'empty', name: 'Logic Root' }));
    const proposed = await executeReady(value.runtime, call('call:propose-empty-scene', 'script.propose', { baseRevision: 2, entityId: create.value.entity.id, text: movementScript, capabilities: ['read', 'debug'] }));
    const applied = await approveAndExecute(value.runtime, call('call:apply-empty-scene', 'script.apply', { baseRevision: 2, proposalId: proposed.value.proposalId }));
    const prepared = await value.runtime.prepare(call('call:validate-empty-scene', 'preview.validate', {}));
    await assert.rejects(value.runtime.execute(prepared.id), /no renderable geometry/);
    assert.equal(value.preview.starts, 0);
  } finally { await dispose(value); }
});

test('Agent tools create Engine primitives and lights and can change built-in materials', async () => {
  const value = await fixture();
  try {
    const sphere = await approveAndExecute(value.runtime, call('call:create-sphere', 'entity.create', { baseRevision: 1, kind: 'sphere', name: 'Player Ball', material: 'pbr', color: [0.15, 0.8, 0.25, 1] }));
    assert.equal(sphere.value.entity.kind, 'sphere');
    assert.equal(sphere.value.entity.appearance.material, 'pbr');
    assert.deepEqual(sphere.value.entity.appearance.color, [0.15, 0.8, 0.25, 1]);
    const light = await approveAndExecute(value.runtime, call('call:create-light', 'entity.create', { baseRevision: 2, kind: 'directional-light', name: 'Sun' }));
    assert.equal(light.value.entity.kind, 'directional-light');
    assert.equal(light.value.entity.light.intensity, 1);
    const material = await approveAndExecute(value.runtime, call('call:set-material', 'material.set', { baseRevision: 3, entityId: sphere.value.entity.id, material: 'blinn-phong', color: [1, 0.2, 0.1, 1] }));
    assert.equal(material.value.entity.appearance.material, 'blinn-phong');
    assert.deepEqual(material.value.entity.appearance.color, [1, 0.2, 0.1, 1]);
    assert.equal(material.historyLabel, 'Set Material');
    await assert.rejects(value.runtime.prepare(call('call:light-material', 'material.set', { baseRevision: 4, entityId: light.value.entity.id, material: 'basic' })), /Only geometry entities/);
    await assert.rejects(value.runtime.prepare(call('call:empty-pbr', 'entity.create', { baseRevision: 4, kind: 'empty', material: 'pbr' })), /Only geometry entities/);
    await assert.rejects(value.runtime.prepare(call('call:bad-color', 'material.set', { baseRevision: 4, entityId: sphere.value.entity.id, material: 'pbr', color: [2, 0, 0, 1] })), /RGBA array/);
  } finally { await dispose(value); }
});

test('registry-driven component tools preserve schema, risk, Scene projection and History', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-camera-owner', 'entity.create', { kind: 'empty', name: 'Gameplay Camera' }));
    const entityId = created.value.entity.id;
    const capabilities = await executeReady(value.runtime, call('call:capabilities', 'engine.capabilities.describe', {}));
    assert.ok(capabilities.value.componentCount >= 13);
    assert.ok(capabilities.value.components.some((item) => item.type === 'haiyue.camera.3d' && item.runtimeAdapter === 'adapter.camera.3d'));
    const described = await executeReady(value.runtime, call('call:describe-camera', 'component.describe', { type: 'haiyue.camera.3d' }));
    assert.equal(described.value.definition.risk, 'medium');
    assert.equal(described.value.definition.capability, 'camera.3d');

    const add = await value.runtime.prepare(call('call:add-gameplay-camera', 'component.add', { baseRevision: 2, entityId, type: 'haiyue.camera.3d', value: {} }));
    assert.equal(add.risk, 'medium');
    assert.equal(add.status, 'approval-required');
    await value.runtime.decide(add.approvalId, 'allow-once');
    const added = await value.runtime.execute(add.id);
    assert.equal(added.historyLabel, 'Add Component');
    assert.equal(added.value.component.value.projection, 'perspective');
    const componentId = added.value.component.id;
    assert.ok(value.scene.snapshot().entities[0].components.some((item) => item.id === componentId));

    const byId = await executeReady(value.runtime, call('call:get-gameplay-camera', 'component.get', { componentId }));
    const byType = await executeReady(value.runtime, call('call:get-gameplay-camera-by-type', 'component.get', { entityId, type: 'haiyue.camera.3d' }));
    assert.equal(byId.value.component.id, byType.value.component.id);
    const orthographic = { ...byId.value.component.value, projection: 'orthographic', orthographicHeight: 24 };
    const set = await value.runtime.prepare(call('call:set-gameplay-camera', 'component.set', { baseRevision: 3, componentId, value: orthographic }));
    assert.equal(set.risk, 'medium');
    await value.runtime.decide(set.approvalId, 'allow-once');
    const changed = await value.runtime.execute(set.id);
    assert.equal(changed.value.component.value.projection, 'orthographic');
    assert.equal(changed.historyLabel, 'Set Component');
    await value.workspace.undo(4);
    assert.equal((await executeReady(value.runtime, call('call:get-camera-after-undo', 'component.get', { componentId }))).value.component.value.projection, 'perspective');
    await value.workspace.redo(5);

    const remove = await value.runtime.prepare(call('call:remove-gameplay-camera', 'component.remove', { baseRevision: 6, componentId }));
    assert.equal(remove.risk, 'medium');
    await value.runtime.decide(remove.approvalId, 'allow-once');
    const removed = await value.runtime.execute(remove.id);
    assert.equal(removed.historyLabel, 'Remove Component');
    assert.equal(value.scene.snapshot().entities[0].components.some((item) => item.id === componentId), false);
    await assert.rejects(executeReady(value.runtime, call('call:get-removed-camera', 'component.get', { componentId })), /does not exist/);
  } finally { await dispose(value); }
});

test('Agent can author distinct material colors for snake, food and board entities', async () => {
  const value = await fixture();
  try {
    const snake = await executeReady(value.runtime, call('call:create-snake-material', 'entity.create', { kind: 'cube', name: 'SnakeBody', material: 'pbr', color: [0.12, 0.82, 0.28, 1] }));
    const food = await executeReady(value.runtime, call('call:create-food-material', 'entity.create', { kind: 'sphere', name: 'Food', material: 'pbr', color: [1, 0.18, 0.12, 1] }));
    const board = await executeReady(value.runtime, call('call:create-board-material', 'entity.create', { kind: 'plane', name: 'Board', material: 'basic', color: [0.06, 0.09, 0.14, 1] }));
    assert.equal(new Set([snake.value.entity.appearance.color.join(','), food.value.entity.appearance.color.join(','), board.value.entity.appearance.color.join(',')]).size, 3);
  } finally { await dispose(value); }
});

test('model-facing mutations bind the current revision and create with an initial Transform', async () => {
  const value = await fixture();
  try {
    const initialTransform = (position) => ({ position, rotationDegrees: { x: 0, y: 45, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
    const definition = GAME_AUTHORING_TOOL_DEFINITIONS.find((item) => item.id === 'entity.create');
    assert.deepEqual(definition.inputSchema.required, ['kind']);
    assert.ok(definition.inputSchema.properties.transform);

    const create = await value.runtime.prepare(call('call:create-positioned', 'entity.create', {
      kind: 'sphere', name: 'Positioned Ball', material: 'pbr', transform: initialTransform({ x: 3, y: 2, z: 1 }),
    }));
    assert.equal(create.baseRevision, 1);
    assert.equal(create.status, 'ready');
    const created = await value.runtime.execute(create.id);
    assert.equal(created.afterRevision, 2);
    assert.deepEqual(created.value.entity.transform.position, { x: 3, y: 2, z: 1 });

    await assert.rejects(
      value.runtime.prepare(call('call:transform-without-target', 'transform.set', { transform: initialTransform({ x: 4, y: 0, z: 0 }) })),
      /transform\.set arguments invalid; missing required fields: entityId; unknown fields: none/,
    );
  } finally { await dispose(value); }
});

test('manual UI service and Agent tool serialize the same entity, revision and undoable History state', async () => {
  const agent = await fixture(); const manual = await fixture();
  const input = {
    baseRevision: 1, kind: 'sphere', name: 'Equivalent Ball', material: 'pbr', color: [0.2, 0.7, 1, 1],
    transform: { position: { x: 3, y: 2, z: 1 }, rotationDegrees: { x: 0, y: 45, z: 0 }, scale: { x: 1.5, y: 1.5, z: 1.5 } },
  };
  try {
    const agentResult = await executeReady(agent.runtime, call('call:equivalent-agent', 'entity.create', input));
    const manualScene = await manual.scene.createEntity({ commandId: asStableId('command:equivalent-manual'), ...input });
    const comparable = (entity) => ({ name: entity.name, kind: entity.kind, order: entity.order, transform: entity.transform, appearance: entity.appearance, light: entity.light });
    assert.deepEqual(comparable(agent.scene.snapshot().entities[0]), comparable(manualScene.entities[0]));
    assert.equal(agentResult.historyLabel, 'Create Scene Entity');
    assert.equal(agent.workspace.snapshot().document.revision, manual.workspace.snapshot().document.revision);
    assert.equal(agent.resources.history.canUndo, true);
    assert.equal(manual.resources.history.canUndo, true);
    await agent.workspace.undo(2); await manual.workspace.undo(2);
    assert.equal(agent.scene.snapshot().entities.length, 0);
    assert.equal(manual.scene.snapshot().entities.length, 0);
  } finally { await dispose(agent); await dispose(manual); }
});

test('schema spoof, rejection and revision drift fail closed without mutation', async () => {
  const value = await fixture();
  try {
    await assert.rejects(value.runtime.prepare(call('call:bad', 'entity.create', { baseRevision: 1, kind: 'cube', shell: 'whoami' })), /unknown fields: shell/);
    await assert.rejects(value.runtime.prepare({ ...call('call:version', 'entity.create', { baseRevision: 1, kind: 'cube' }), toolVersion: '2.0.0' }), /not registered/);
    const created = await executeReady(value.runtime, call('call:policy-target', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Policy Target' }));
    const entityId = created.value.entity.id;
    const rejected = await value.runtime.prepare(call('call:reject', 'entity.rename', { baseRevision: 2, entityId, name: 'Rejected' }));
    await value.runtime.decide(rejected.approvalId, 'reject');
    assert.equal((await value.runtime.execute(rejected.id)).status, 'rejected');
    assert.equal(value.workspace.snapshot().document.revision, 2);

    const stale = await value.runtime.prepare(call('call:stale', 'entity.rename', { baseRevision: 2, entityId, name: 'Stale' }));
    await value.runtime.decide(stale.approvalId, 'allow-once');
    await value.workspace.execute({ id: asStableId('command:drift'), label: 'Drift', baseRevision: 2, key: 'fixture.drift', value: true });
    await assert.rejects(value.runtime.execute(stale.id), /Document changed/);
    assert.equal(value.scene.snapshot().entities[0].name, 'Policy Target');

    const cancelled = await value.runtime.prepare(call('call:cancel-ready', 'project.snapshot', {}));
    await value.runtime.cancel(asStableId('call:cancel-ready'));
    assert.equal((await value.runtime.execute(cancelled.id)).status, 'cancelled');
  } finally { await dispose(value); }
});

test('schema fuzz rejects duplicate, nested unknown, non-finite and malformed structured fields before mutation', async () => {
  const value = await fixture();
  try {
    const transform = { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const cases = [
      call('call:fuzz-nested', 'entity.create', { kind: 'cube', transform: { ...transform, position: { ...transform.position, w: 1 } } }),
      call('call:fuzz-infinite', 'entity.create', { kind: 'cube', transform: { ...transform, position: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 } } }),
      call('call:fuzz-capability-duplicate', 'script.propose', { entityId: 'entity:fixture', text: 'return;', capabilities: ['read', 'read'] }),
      call('call:fuzz-kind-format', 'diagnostics.query', { limit: 10, traverseCorrelation: false, kinds: ['INVALID KIND'] }),
      { ...call('call:fuzz-envelope', 'project.snapshot', {}), effect: 'trusted-code' },
    ];
    for (const candidate of cases) await assert.rejects(value.runtime.prepare(candidate), /invalid|unknown fields|non-finite/i);
    assert.equal(value.workspace.snapshot().document.revision, 1);
    const facts = await value.operationLog.query({ toolCallId: asStableId('call:fuzz-kind-format'), limit: 20, traverseCorrelation: false });
    assert.deepEqual(facts.events.filter((item) => item.kind.startsWith('tool/')).map((item) => item.kind), ['tool/call-received', 'tool/preparation-failed']);
  } finally { await dispose(value); }
});

test('same-document mutations serialize and a queued stale preparation never enters the editor service', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-serialized', 'entity.create', { kind: 'cube', name: 'Before' }));
    const entityId = created.value.entity.id;
    const first = await value.runtime.prepare(call('call:serialize-first', 'entity.rename', { baseRevision: 2, entityId, name: 'First' }));
    const second = await value.runtime.prepare(call('call:serialize-second', 'entity.rename', { baseRevision: 2, entityId, name: 'Second' }));
    await value.runtime.decide(first.approvalId, 'allow-once');
    await value.runtime.decide(second.approvalId, 'allow-once');
    const originalRename = value.scene.renameEntity.bind(value.scene);
    const entered = deferred(); const release = deferred(); let active = 0; let maximum = 0; let calls = 0;
    value.scene.renameEntity = async (...args) => { calls += 1; active += 1; maximum = Math.max(maximum, active); entered.resolve(); await release.promise; try { return await originalRename(...args); } finally { active -= 1; } };
    const firstExecution = value.runtime.execute(first.id);
    await entered.promise;
    const secondExecution = value.runtime.execute(second.id);
    release.resolve();
    assert.equal((await firstExecution).status, 'completed');
    await assert.rejects(secondExecution, /Document changed/);
    assert.equal(maximum, 1);
    assert.equal(calls, 1);
    assert.equal(value.scene.snapshot().entities[0].name, 'First');
  } finally { await dispose(value); }
});

test('tool, approval, Document and History correlation remains traversable after the journal restarts', async () => {
  const value = await fixture(); let disposed = false; let reopened;
  try {
    const created = await executeReady(value.runtime, call('call:restart-create', 'entity.create', { kind: 'cube', name: 'Before Restart' }));
    const rename = await value.runtime.prepare(call('call:restart-rename', 'entity.rename', { baseRevision: 2, entityId: created.value.entity.id, name: 'After Restart' }));
    await value.runtime.decide(rename.approvalId, 'allow-once');
    await value.runtime.execute(rename.id);
    await dispose(value); disposed = true;

    reopened = await OperationLog.open({ rootDirectory: path.join(value.userDataRoot, 'log'), appVersion: 'test-reopen' });
    const page = await reopened.query({ toolCallId: asStableId('call:restart-rename'), limit: 200, traverseCorrelation: true });
    const kinds = page.events.map((item) => item.kind);
    assert.ok(kinds.includes('approval/allow-once'));
    assert.ok(kinds.includes('tool/execution-completed'));
    assert.ok(kinds.includes('document/command-requested'));
    assert.ok(kinds.includes('document/command-committed'));
    assert.ok(page.events.some((item) => item.kind === 'document/command-committed' && item.correlation.commandId));
  } finally {
    if (reopened) await reopened.close();
    if (!disposed) await dispose(value);
  }
});

test('cancelled calls reject a late result even when the injected runtime ignores AbortSignal', async () => {
  const value = await fixture();
  try {
    const entered = deferred(); const release = deferred();
    value.preview.stop = async () => { entered.resolve(); return await release.promise; };
    const prepared = await value.runtime.prepare(call('call:late-preview-stop', 'preview.stop', {}));
    const execution = value.runtime.execute(prepared.id);
    await entered.promise;
    await value.runtime.cancel(asStableId('call:late-preview-stop'));
    release.resolve({ instanceId: null, state: 'stopped', entityId: null, position: null, disposableCount: 0, errors: [] });
    await assert.rejects(execution, /cancelled/);
    const facts = await value.operationLog.query({ toolCallId: asStableId('call:late-preview-stop'), limit: 30, traverseCorrelation: false });
    assert.equal(facts.events.some((item) => item.kind === 'tool/execution-completed'), false);
    assert.ok(facts.events.some((item) => item.kind === 'tool/execution-failed'));
  } finally { await dispose(value); }
});

test('tool timeout aborts execution, emits a terminal failure and cannot produce a late completion', async () => {
  const value = await fixture({ timeoutCeilingMs: 25 });
  try {
    value.preview.stop = async (signal) => await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    const prepared = await value.runtime.prepare(call('call:timeout-preview-stop', 'preview.stop', {}));
    await assert.rejects(value.runtime.execute(prepared.id), (cause) => cause.code === 'tool.timeout');
    const facts = await value.operationLog.query({ toolCallId: asStableId('call:timeout-preview-stop'), limit: 30, traverseCorrelation: false });
    assert.equal(facts.events.some((item) => item.kind === 'tool/execution-completed'), false);
    assert.ok(facts.events.some((item) => item.kind === 'tool/execution-failed'));
  } finally { await dispose(value); }
});

test('observe tools degrade when journal append fails while every mutation remains fail closed', async () => {
  const value = await fixture();
  const append = value.operationLog.append.bind(value.operationLog);
  try {
    value.operationLog.append = async () => { throw new Error('fixture journal unavailable'); };
    const observed = await value.runtime.prepare(call('call:degraded-observe', 'project.snapshot', {}));
    const result = await value.runtime.execute(observed.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.afterRevision, 1);
    await assert.rejects(value.runtime.prepare(call('call:degraded-mutation', 'entity.create', { kind: 'cube' })), /Operation Log rejected/);
    assert.equal(value.workspace.snapshot().document.revision, 1);
  } finally { value.operationLog.append = append; await dispose(value); }
});

test('pending approvals have no wall-clock expiry while revision drift still invalidates them', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-expiry-target', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Before' }));
    const entityId = created.value.entity.id;
    const pending = await value.runtime.prepare(call('call:no-expiry', 'entity.rename', { baseRevision: 2, entityId, name: 'Still valid' }));
    assert.equal(pending.expiresAt, undefined);
    assert.equal(value.runtime.approval(pending.approvalId).expiresAt, undefined);
    value.time.value += 30 * 24 * 60 * 60_000;
    assert.equal((await value.runtime.decide(pending.approvalId, 'allow-once')).decision, 'allow-once');
    assert.equal((await value.runtime.execute(pending.id)).status, 'completed');
    assert.equal(value.scene.snapshot().entities[0].name, 'Still valid');

    const stale = await value.runtime.prepare(call('call:approval-stale', 'entity.rename', { baseRevision: 3, entityId, name: 'Must not apply' }));
    await value.workspace.execute({ id: asStableId('command:approval-drift'), label: 'Approval drift', baseRevision: 3, key: 'fixture.approval-drift', value: true });
    await assert.rejects(value.runtime.decide(stale.approvalId, 'allow-once'), /is stale/);
    assert.equal(value.runtime.approval(stale.approvalId).decision, 'stale');
    assert.equal((await value.runtime.execute(stale.id)).status, 'rejected');
    assert.equal(value.scene.snapshot().entities[0].name, 'Still valid');

    const facts = await value.operationLog.query({ toolCallId: asStableId('call:no-expiry'), limit: 30, traverseCorrelation: false });
    assert.equal(facts.events.some((item) => item.kind === 'approval/expired'), false);
  } finally { await dispose(value); }
});

test('fake backend deterministic E2E creates, transforms, scripts and starts preview through one tool seam', async () => {
  const value = await fixture();
  const approvals = [];
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request(preparation, approval) { approvals.push({ toolId: preparation.toolId, approvalId: approval.approvalId }); return 'allow-once'; } });
  const backend = scriptedBackend(movementScript);
  try {
    const summary = await coordinator.run(backend, { prompt: 'Create a moving cube and preview it.' });
    assert.equal(summary.terminal, 'completed');
    assert.deepEqual(summary.results.map((item) => item.toolId), ['entity.create', 'transform.set', 'script.propose', 'script.apply', 'preview.validate', 'preview.start', 'preview.stop']);
    assert.deepEqual(approvals.map((item) => item.toolId), ['transform.set', 'script.apply', 'preview.start']);
    assert.equal(value.scene.snapshot().entities[0].transform.position.x, 2);
    assert.equal(value.scripts.snapshot().resources.length, 1);
    assert.equal(value.preview.starts, 1);
    assert.equal(value.preview.stops, 1);
    assert.equal(value.workspace.snapshot().document.revision, 4);
  } finally { coordinator.dispose(); await dispose(value); }
});

test('agent queries a pre-restart runtime fault and applies one approved repair through the bounded tool seam', async () => {
  const beforeRestart = await fixture(); let beforeDisposed = false; let afterRestart; let coordinator;
  try {
    const created = await executeReady(beforeRestart.runtime, call('call:repair-seed-create', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Broken Runner' }));
    const entityId = created.value.entity.id;
    const proposed = await executeReady(beforeRestart.runtime, call('call:repair-seed-propose', 'script.propose', {
      baseRevision: created.afterRevision, entityId, text: runtimeFailureScript, capabilities: ['read', 'debug'],
    }));
    const applied = await approveAndExecute(beforeRestart.runtime, call('call:repair-seed-apply', 'script.apply', {
      baseRevision: proposed.afterRevision, proposalId: proposed.value.proposalId,
    }));
    await beforeRestart.workspace.save();
    await beforeRestart.operationLog.append({
      kind: 'preview/runtime-error', severity: 'error', source: asStableId('studio.preview'),
      correlation: { entityId, scriptId: applied.value.scriptId, previewId: asStableId('preview:repair-fixture') },
      payload: { code: 'fixture.runtime-error', message: 'fixture runtime failure', source: runtimeFailureScript, line: 1, column: 1 },
    });
    const restartState = { projectRoot: beforeRestart.projectRoot, userDataRoot: beforeRestart.userDataRoot, time: beforeRestart.time };
    await dispose(beforeRestart); beforeDisposed = true;

    afterRestart = await fixture({}, restartState);
    const approvals = [];
    coordinator = new AgentGameAuthoringCoordinator(afterRestart.runtime, {
      async request(preparation) { approvals.push(preparation.toolId); return 'allow-once'; },
    });
    const summary = await coordinator.run(repairBackend(entityId, repairedRuntimeScript), { prompt: 'Inspect the prior preview failure and repair the script.' });

    assert.equal(summary.terminal, 'completed');
    assert.deepEqual(summary.results.map((item) => item.toolId), ['diagnostics.query', 'script.propose', 'script.apply']);
    assert.deepEqual(approvals, ['script.apply']);
    assert.equal(summary.results[0].value.count, 1);
    assert.equal(summary.results[0].value.events[0].kind, 'preview/runtime-error');
    assert.equal(summary.results[0].value.events[0].correlation.entityId, entityId);
    assert.equal(afterRestart.scripts.snapshot().resources[0].text, repairedRuntimeScript);
    assert.equal(afterRestart.workspace.snapshot().document.revision, 4);

    const repairFacts = await afterRestart.operationLog.query({ toolCallId: asStableId('toolcall:repair-apply'), limit: 100, traverseCorrelation: true });
    assert.ok(repairFacts.events.some((item) => item.kind === 'approval/allow-once'));
    assert.ok(repairFacts.events.some((item) => item.kind === 'document/command-committed'));
  } finally {
    if (coordinator) coordinator.dispose();
    if (afterRestart) await dispose(afterRestart);
    if (!beforeDisposed) await dispose(beforeRestart);
  }
});

test('coordinator rejects malformed provider arguments instead of coercing them to an empty observe call', async () => {
  const value = await fixture(); let submitted;
  const backend = minimalBackend(async function* () {
    yield event('tool-request', { toolCallId: 'toolcall:malformed', toolId: 'project.snapshot', arguments: [] });
    yield event('completed', { status: 'completed' });
  }, async (_id, result) => { submitted = result; });
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } });
  try {
    const summary = await coordinator.run(backend, { prompt: 'Malformed fixture.' });
    assert.equal(summary.terminal, 'completed');
    assert.equal(summary.results.length, 0);
    assert.equal(summary.diagnostics[0].code, 'tool.arguments-invalid');
    assert.equal(submitted.status, 'failed');
  } finally { coordinator.dispose(); await dispose(value); }
});

test('disposing the coordinator aborts an active backend turn and is idempotent', async () => {
  const value = await fixture(); const entered = deferred();
  const backend = minimalBackend(async function* (_input, signal) {
    entered.resolve();
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    yield event('completed', { status: 'completed' });
  });
  const coordinator = new AgentGameAuthoringCoordinator(value.runtime, { async request() { return 'allow-once'; } });
  try {
    const running = coordinator.run(backend, { prompt: 'Wait for disposal.' });
    await entered.promise;
    coordinator.dispose(); coordinator.dispose();
    await assert.rejects(running, /disposed/);
  } finally { coordinator.dispose(); await dispose(value); }
});

async function fixture(runtimeOptions = {}, restartState = null) {
  const projectRoot = restartState?.projectRoot ?? await mkdtemp(path.join(tmpdir(), 'haiyue-tools-project-'));
  const userDataRoot = restartState?.userDataRoot ?? await mkdtemp(path.join(tmpdir(), 'haiyue-tools-userdata-'));
  const time = restartState?.time ?? { value: 1_000 };
  const operationLog = await OperationLog.open({ rootDirectory: path.join(userDataRoot, 'log'), appVersion: 'test', clock: () => new Date(time.value), eventId: (sequence) => asStableId(`event:tools:${sequence}`) });
  const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(userDataRoot) };
  const workspace = new ProjectWorkspace(resources);
  if (restartState) await workspace.openProject(projectRoot); else await workspace.newProject(projectRoot, 'Tool fixture');
  const scene = new ProjectSceneAuthoringService(workspace, operationLog);
  const validator = new ScriptValidationWorker();
  const projectScripts = new ProjectScriptService(workspace, validator, operationLog);
  const authorization = new PreviewAuthorizationService(projectScripts, validator, operationLog, () => time.value);
  const scripts = {
    snapshot: () => projectScripts.snapshot(), proposeEdit: (input) => projectScripts.proposeEdit(input),
    commitProposal: (proposalId, commandId, signal) => projectScripts.commitProposal(proposalId, commandId, signal),
    prepare: (input) => authorization.prepare(input),
    decide: (planId, approved, ttl) => authorization.decide(planId, approved, ttl), consume: (grantId) => authorization.consume(grantId),
  };
  const preview = {
    starts: 0, stops: 0, state: { instanceId: null, state: 'stopped', scriptSetDigest: null, scriptCount: 0, scripts: [], entityId: null, position: null, disposableCount: 0, errors: [] },
    async start(scene, plan) { assert.ok(scene.entities.some((entity) => entity.kind === 'cube')); this.starts += 1; this.state = { ...this.state, instanceId: 'preview:fixture', state: 'playing', scriptSetDigest: plan.scriptSetDigest, scriptCount: plan.scripts.length, scripts: plan.scripts.map((script) => ({ scriptId: script.scriptId, entityId: script.entityId, order: script.order, state: 'playing', position: null, disposableCount: 0, errorCount: 0 })), entityId: plan.scripts[0]?.entityId ?? null }; return this.state; },
    async stop() { this.stops += 1; this.state = { ...this.state, state: 'stopped', instanceId: null, entityId: null }; return this.state; },
    async step(count) { return this.observation({ stepped: count }); }, async input(event) { return this.observation({ input: event }); }, async inspect() { return this.observation({ score: 4 }); },
    async capture() { const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); return { ...this.observation({}), mediaType: 'image/png', byteLength: png.length, base64: png.toString('base64') }; },
    observation(value) { return { playId: 'preview:fixture', documentRevision: 3, scriptDigests: [`sha256:${'a'.repeat(64)}`], tick: 12, frame: 9, viewport: { width: 393, height: 852 }, device: 'fixture', capturedAt: '2026-08-29T00:00:00.000Z', value }; },
    snapshot() { return this.state; },
  };
  const runtime = new GameAuthoringToolRuntime({ workspace, scene, scripts, diagnostics: operationLog.diagnosticsService(), operationLog, preview, ...runtimeOptions });
  return { projectRoot, userDataRoot, time, operationLog, resources, workspace, scene, validator, projectScripts, scripts, preview, runtime };
}

function call(id, toolId, args) { return { schemaVersion: 1, id, sessionId: 'session:fixture', turnId: 'turn:fixture', toolId, toolVersion: '1.0.0', arguments: args }; }
async function approveAndExecute(runtime, value) { const prepared = await runtime.prepare(value); if (prepared.approvalId) await runtime.decide(prepared.approvalId, 'allow-once'); return runtime.execute(prepared.id); }
async function executeReady(runtime, value) { const prepared = await runtime.prepare(value); assert.equal(prepared.status, 'ready'); return runtime.execute(prepared.id); }
async function dispose(value) { value.runtime.dispose(); value.scene.dispose(); value.projectScripts.dispose(); await value.validator.dispose(); await value.workspace.dispose(); value.resources.tasks.dispose(); await value.resources.documents.dispose(); value.resources.history.dispose(); value.resources.projectSession.dispose(); await value.operationLog.close(); }

function scriptedBackend(script) {
  let pending;
  const backendId = 'backend:fake-tools'; const sessionId = 'session:fake-tools'; const turnId = 'turn:fake-tools';
  return {
    descriptor: { schemaVersion: 1, id: backendId, kind: 'harness-api-key', protocolVersion: 'fake', capabilities: { resume: false, questions: false, structuredTools: true, backendApprovals: false, usage: false, rateLimits: false } },
    async *startTurn(input) {
      assert.equal(input.tools.length, 32);
      yield event('status', { status: 'running' });
      let result = yield* request('toolcall:create', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Agent Cube' });
      const entityId = result.value.entity.id;
      result = yield* request('toolcall:transform', 'transform.set', { baseRevision: result.afterRevision, entityId, transform: { position: { x: 2, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 30, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
      result = yield* request('toolcall:propose', 'script.propose', { baseRevision: result.afterRevision, entityId, text: script, capabilities: ['read', 'debug'] });
      result = yield* request('toolcall:apply', 'script.apply', { baseRevision: result.afterRevision, proposalId: result.value.proposalId });
      result = yield* request('toolcall:validate', 'preview.validate', {});
      result = yield* request('toolcall:start', 'preview.start', { baseRevision: result.afterRevision, planId: result.value.planId });
      yield* request('toolcall:stop', 'preview.stop', {});
      yield event('completed', { status: 'completed' });
    },
    async submitToolResult(id, result) { assert.equal(pending?.id, id); pending.resolve(result); pending = undefined; },
    async authenticate() { return null; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async logout() {},
    resumeTurn() { throw new Error('unused'); }, async answerQuestion() {}, async resolveBackendApproval() {}, async cancelTurn() {}, async dispose() {},
  };
  function event(kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
  async function* request(id, toolId, args) { const result = deferred(); pending = { id, resolve: result.resolve }; yield event('tool-request', { toolCallId: id, toolId, arguments: args }); return await result.promise; }
}
function repairBackend(entityId, repairedScript) {
  let pending;
  const backendId = 'backend:fake-repair'; const sessionId = 'session:fake-repair'; const turnId = 'turn:fake-repair';
  return {
    descriptor: { schemaVersion: 1, id: backendId, kind: 'harness-api-key', protocolVersion: 'fake', capabilities: { resume: false, questions: false, structuredTools: true, backendApprovals: false, usage: false, rateLimits: false } },
    async *startTurn(input) {
      assert.equal(input.tools.length, 32);
      let result = yield* request('toolcall:repair-diagnostics', 'diagnostics.query', { kinds: ['preview/runtime-error'], limit: 10, traverseCorrelation: false });
      assert.equal(result.value.count, 1);
      assert.equal(result.value.events[0].kind, 'preview/runtime-error');
      assert.equal(result.value.events[0].correlation.entityId, entityId);
      result = yield* request('toolcall:repair-propose', 'script.propose', { baseRevision: result.afterRevision, entityId, text: repairedScript, capabilities: ['read', 'debug'] });
      yield* request('toolcall:repair-apply', 'script.apply', { baseRevision: result.afterRevision, proposalId: result.value.proposalId });
      yield backendEvent('completed', { status: 'completed' });
    },
    async submitToolResult(id, result) { assert.equal(pending?.id, id); pending.resolve(result); pending = undefined; },
    async authenticate() { return null; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async logout() {},
    resumeTurn() { throw new Error('unused'); }, async answerQuestion() {}, async resolveBackendApproval() {}, async cancelTurn() {}, async dispose() {},
  };
  function backendEvent(kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
  async function* request(id, toolId, args) { const result = deferred(); pending = { id, resolve: result.resolve }; yield backendEvent('tool-request', { toolCallId: id, toolId, arguments: args }); return await result.promise; }
}
function minimalBackend(startTurn, submitToolResult = async () => {}) {
  return {
    descriptor: { schemaVersion: 1, id: 'backend:minimal-tools', kind: 'harness-api-key', protocolVersion: 'fake', capabilities: { resume: false, questions: false, structuredTools: true, backendApprovals: false, usage: false, rateLimits: false } },
    startTurn, submitToolResult,
    async authenticate() { return null; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async logout() {},
    resumeTurn() { throw new Error('unused'); }, async answerQuestion() {}, async resolveBackendApproval() {}, async cancelTurn() {}, async dispose() {},
  };
}
function event(kind, payload) { return { schemaVersion: 1, backendId: 'backend:minimal-tools', sessionId: 'session:minimal-tools', turnId: 'turn:minimal-tools', kind, payload }; }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function pngHeader(width, height) { const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); const view = new DataView(bytes.buffer); view.setUint32(16, width, false); view.setUint32(20, height, false); return bytes; }
