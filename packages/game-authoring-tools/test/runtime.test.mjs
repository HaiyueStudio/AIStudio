import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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

test('fixed tool catalog exposes only the 14 bounded POC capabilities', () => {
  assert.deepEqual(GAME_AUTHORING_TOOL_DEFINITIONS.map((item) => item.id), [
    'project.snapshot', 'scene.list-entities', 'entity.get', 'script.get', 'diagnostics.query',
    'entity.create', 'entity.rename', 'transform.set', 'material.set', 'script.propose', 'script.apply',
    'preview.validate', 'preview.start', 'preview.stop',
  ]);
  assert.ok(GAME_AUTHORING_TOOL_DEFINITIONS.every((item) => item.version === '1.0.0' && item.timeoutMs <= 20_000 && item.maxResultBytes <= 65_536));
  assert.deepEqual(
    GAME_AUTHORING_TOOL_DEFINITIONS.filter((item) => item.id === 'entity.create').map((item) => ({ risk: item.risk, requiresApproval: item.requiresApproval })),
    [{ risk: 'low', requiresApproval: false }],
  );
  assert.doesNotMatch(JSON.stringify(GAME_AUTHORING_TOOL_DEFINITIONS), /shell|network|filesystem|delete|package|git/i);
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

    const validated = await executeReady(value.runtime, call('call:validate', 'preview.validate', { scriptId: applied.value.scriptId, capabilities: ['read', 'debug'] }));
    const start = await value.runtime.prepare(call('call:start', 'preview.start', { baseRevision: 3, planId: validated.value.planId }));
    assert.notEqual(start.approvalId, apply.approvalId);
    await assert.rejects(value.runtime.decide(start.approvalId, 'allow-always'), /one-shot approval/);
    await value.runtime.decide(start.approvalId, 'allow-once');
    const started = await value.runtime.execute(start.id);
    assert.equal(started.value.state, 'playing');
    assert.equal(value.preview.starts, 1);
    const stopped = await executeReady(value.runtime, call('call:stop', 'preview.stop', {}));
    assert.equal(stopped.value.state, 'stopped');
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
    const validated = await executeReady(value.runtime, call('call:validate-inferred-scene', 'preview.validate', {
      scriptId: applied.value.scriptId, capabilities: ['read', 'input', 'debug'],
    }));
    assert.deepEqual(validated.value.capabilities, ['read', 'input', 'debug', 'scene']);
    assert.deepEqual(validated.value.diagnostics, []);
  } finally { await dispose(value); }
});

test('preview validation rejects scenes that contain only logic entities', async () => {
  const value = await fixture();
  try {
    const create = await approveAndExecute(value.runtime, call('call:create-empty-script-entity', 'entity.create', { baseRevision: 1, kind: 'empty', name: 'Logic Root' }));
    const proposed = await executeReady(value.runtime, call('call:propose-empty-scene', 'script.propose', { baseRevision: 2, entityId: create.value.entity.id, text: movementScript, capabilities: ['read', 'debug'] }));
    const applied = await approveAndExecute(value.runtime, call('call:apply-empty-scene', 'script.apply', { baseRevision: 2, proposalId: proposed.value.proposalId }));
    const prepared = await value.runtime.prepare(call('call:validate-empty-scene', 'preview.validate', { scriptId: applied.value.scriptId, capabilities: ['read', 'debug'] }));
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

test('pending approvals expire and revision drift invalidates them before a decision can be accepted', async () => {
  const value = await fixture();
  try {
    const created = await executeReady(value.runtime, call('call:create-expiry-target', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Before' }));
    const entityId = created.value.entity.id;
    const pending = await value.runtime.prepare(call('call:expires', 'entity.rename', { baseRevision: 2, entityId, name: 'Expired' }));
    assert.equal(pending.expiresAt, new Date(value.time.value + 5 * 60_000).toISOString());
    assert.equal(value.runtime.approval(pending.approvalId).expiresAt, pending.expiresAt);
    value.time.value += 5 * 60_000;
    await assert.rejects(value.runtime.decide(pending.approvalId, 'allow-once'), /is expired/);
    assert.equal(value.runtime.approval(pending.approvalId).decision, 'expired');
    assert.equal((await value.runtime.execute(pending.id)).status, 'rejected');
    assert.equal(value.scene.snapshot().entities[0].name, 'Before');

    const stale = await value.runtime.prepare(call('call:approval-stale', 'entity.rename', { baseRevision: 2, entityId, name: 'Must not apply' }));
    await value.workspace.execute({ id: asStableId('command:approval-drift'), label: 'Approval drift', baseRevision: 2, key: 'fixture.approval-drift', value: true });
    await assert.rejects(value.runtime.decide(stale.approvalId, 'allow-once'), /is stale/);
    assert.equal(value.runtime.approval(stale.approvalId).decision, 'stale');
    assert.equal((await value.runtime.execute(stale.id)).status, 'rejected');
    assert.equal(value.scene.snapshot().entities[0].name, 'Before');

    const facts = await value.operationLog.query({ toolCallId: asStableId('call:expires'), limit: 30, traverseCorrelation: false });
    assert.ok(facts.events.some((item) => item.kind === 'approval/expired'));
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

async function fixture(runtimeOptions = {}) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-tools-project-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-tools-userdata-'));
  const time = { value: 1_000 };
  const operationLog = await OperationLog.open({ rootDirectory: path.join(userDataRoot, 'log'), appVersion: 'test', clock: () => new Date(time.value), eventId: (sequence) => asStableId(`event:tools:${sequence}`) });
  const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(userDataRoot) };
  const workspace = new ProjectWorkspace(resources);
  await workspace.newProject(projectRoot, 'Tool fixture');
  const scene = new ProjectSceneAuthoringService(workspace, operationLog);
  const validator = new ScriptValidationWorker();
  const projectScripts = new ProjectScriptService(workspace, validator, operationLog);
  const authorization = new PreviewAuthorizationService(projectScripts, validator, operationLog, () => time.value);
  const scripts = {
    snapshot: () => projectScripts.snapshot(), proposeEdit: (input) => projectScripts.proposeEdit(input),
    commitProposal: (proposalId, commandId, signal) => projectScripts.commitProposal(proposalId, commandId, signal),
    prepare: (scriptId, capabilities) => authorization.prepare(scriptId, capabilities),
    decide: (planId, approved, ttl) => authorization.decide(planId, approved, ttl), consume: (grantId) => authorization.consume(grantId),
  };
  const preview = {
    starts: 0, stops: 0, state: { instanceId: null, state: 'stopped', entityId: null, position: null, disposableCount: 0, errors: [] },
    async start(scene, plan) { assert.ok(scene.entities.some((entity) => entity.kind === 'cube')); this.starts += 1; this.state = { ...this.state, instanceId: 'preview:fixture', state: 'playing', entityId: plan.entityId }; return this.state; },
    async stop() { this.stops += 1; this.state = { ...this.state, state: 'stopped', instanceId: null, entityId: null }; return this.state; }, snapshot() { return this.state; },
  };
  const runtime = new GameAuthoringToolRuntime({ workspace, scene, scripts, diagnostics: operationLog.diagnosticsService(), operationLog, preview, clock: () => new Date(time.value), ...runtimeOptions });
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
      assert.equal(input.tools.length, 14);
      yield event('status', { status: 'running' });
      let result = yield* request('toolcall:create', 'entity.create', { baseRevision: 1, kind: 'cube', name: 'Agent Cube' });
      const entityId = result.value.entity.id;
      result = yield* request('toolcall:transform', 'transform.set', { baseRevision: result.afterRevision, entityId, transform: { position: { x: 2, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 30, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
      result = yield* request('toolcall:propose', 'script.propose', { baseRevision: result.afterRevision, entityId, text: script, capabilities: ['read', 'debug'] });
      result = yield* request('toolcall:apply', 'script.apply', { baseRevision: result.afterRevision, proposalId: result.value.proposalId });
      result = yield* request('toolcall:validate', 'preview.validate', { scriptId: result.value.scriptId, capabilities: ['read', 'debug'] });
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
