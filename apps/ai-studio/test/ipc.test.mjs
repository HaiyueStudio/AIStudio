import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioIpcRouter, validateStudioIpcRequest } from '../dist/ipc.js';

function request(channel, payload = {}) {
  return { schemaVersion: 1, id: 'request:test', correlationId: 'correlation:test', channel, payload };
}

const agentOwners = {
  conversation: { replay: () => ({ revision: 0, connection: 'connected', busy: false, backendId: null, backends: [], events: [] }), async dispatch() {}, cancelPending() {} },
  agentPreview: { command: () => ({ pending: false }), resolve() {}, reject() {}, cancelPending() {} },
  bugBundleRoot: 'D:\\fixture-bundles',
  versions: { app: 'test', schema: 'test', upstream: {} },
};

test('IPC validator is versioned, allowlisted and never accepts renderer paths', () => {
  assert.equal(validateStudioIpcRequest(request('app/status')).channel, 'app/status');
  assert.throws(() => validateStudioIpcRequest(request('shell:exec')), /not allowed/);
  assert.throws(() => validateStudioIpcRequest(request('project/open', { path: 'C:\\secret' })), /does not accept payload/);
  assert.throws(() => validateStudioIpcRequest(request('project/command', {
    commandId: 'command:test', label: 'Set', baseRevision: 1, key: 'fixture.value', value: undefined,
  })), /bounded JSON/);
  assert.throws(() => validateStudioIpcRequest({ ...request('app/status'), schemaVersion: 2 }), /envelope/);
  assert.equal(validateStudioIpcRequest(request('scene/create', {
    commandId: 'command:sphere', baseRevision: 1, kind: 'sphere', name: 'Player', parentId: null, material: 'pbr', color: [0.15, 0.8, 0.25, 1],
  })).channel, 'scene/create');
  assert.throws(() => validateStudioIpcRequest(request('scene/create', {
    commandId: 'command:cube', baseRevision: 1, kind: 'light',
  })), /scene\/create payload/);
  assert.throws(() => validateStudioIpcRequest(request('scene/create', {
    commandId: 'command:light-color', baseRevision: 1, kind: 'point-light', color: [1, 0, 0, 1],
  })), /scene\/create payload/);
  assert.throws(() => validateStudioIpcRequest(request('scene/select', {
    entityId: 'entity:test', source: 'remote-shell',
  })), /scene\/select payload/);
  assert.equal(validateStudioIpcRequest(request('scene/material', { commandId: 'command:material', baseRevision: 2, entityId: 'entity:test', material: 'blinn-phong', color: [1, 0.2, 0.1, 1] })).channel, 'scene/material');
  assert.throws(() => validateStudioIpcRequest(request('scene/material', { commandId: 'command:material', baseRevision: 2, entityId: 'entity:test', material: 'shader-code' })), /scene\/material payload/);
  assert.throws(() => validateStudioIpcRequest(request('scene/material', { commandId: 'command:material', baseRevision: 2, entityId: 'entity:test', material: 'pbr', color: [255, 0, 0, 1] })), /scene\/material payload/);
  assert.throws(() => validateStudioIpcRequest(request('viewport/report', {
    event: 'frame', message: 'spam', sceneRevision: 1,
  })), /viewport\/report event/);
  assert.throws(() => validateStudioIpcRequest(request('preview/prepare', {
    scriptId: 'script:test', capabilities: ['network'],
  })), /preview\/prepare payload/);
  assert.throws(() => validateStudioIpcRequest(request('preview/report', {
    event: 'state', message: 'frame spam', disposableCount: 0,
  })), /preview\/report payload/);
  assert.throws(() => validateStudioIpcRequest(request('preview/report', {
    event: 'started', message: 'invalid count', disposableCount: -1,
  })), /preview\/report payload/);
  assert.equal(validateStudioIpcRequest(request('preview/report', {
    event: 'paused', message: 'paused', disposableCount: 0,
  })).channel, 'preview/report');
  assert.equal(validateStudioIpcRequest(request('preview/report', {
    event: 'resumed', message: 'resumed', disposableCount: 0,
  })).channel, 'preview/report');
  assert.equal(validateStudioIpcRequest(request('conversation/intent', {
    intent: { type: 'conversation/send', backendId: 'backend:test', prompt: 'Create a cube' },
  })).channel, 'conversation/intent');
  assert.throws(() => validateStudioIpcRequest(request('conversation/intent', {
    intent: { type: 'conversation/send', backendId: 'backend:test', prompt: 'Create a cube', bypassApproval: true },
  })), /fields|intent/);
  assert.equal(validateStudioIpcRequest(request('logs/query', { query: { limit: 50, traverseCorrelation: false } })).channel, 'logs/query');
  assert.throws(() => validateStudioIpcRequest(request('logs/query', { query: { limit: 50_000, traverseCorrelation: false } })), /budget/);
  assert.throws(() => validateStudioIpcRequest(request('preview/agent-result', { commandId: 'preview-command:test', ok: true })), /invalid/);
});

test('scene IPC exposes immutable JSON projections and routes typed intents through shared services', async () => {
  const calls = [];
  const events = [];
  const workspace = {
    snapshot: () => ({ document: { revision: 4 }, history: { canUndo: true, canRedo: false } }),
    cancelAll() {},
  };
  const scene = {
    snapshot: () => ({ schemaVersion: 1, revision: 2, documentId: 'document:test', entities: [] }),
    async createEntity(intent) { calls.push(['create', intent]); return this.snapshot(); },
    async setTransform(intent) { calls.push(['transform', intent]); return this.snapshot(); },
    async setMaterial(intent) { calls.push(['material', intent]); return this.snapshot(); },
  };
  const selection = {
    async select(entityId, source, correlationId) { calls.push(['select', { entityId, source, correlationId }]); return { activeEntityId: entityId, entityIds: entityId ? [entityId] : [], revision: 1, source }; },
  };
  const operationLog = { async append(event) { events.push(event); return {}; } };
  const router = new StudioIpcRouter({ workspace, scene, selection, operationLog, ...agentOwners, selectProjectRoot: async () => null, smoke: true });

  assert.equal((await router.handle(request('app/status'))).payload.smoke, true);
  assert.equal((await router.handle(request('scene/snapshot'))).payload.revision, 2);
  assert.equal((await router.handle(request('scene/create', { commandId: 'command:cube', baseRevision: 4, kind: 'cube', material: 'pbr', color: [0.15, 0.8, 0.25, 1] }))).ok, true);
  assert.equal((await router.handle(request('scene/select', { entityId: 'entity:cube', source: 'hierarchy' }))).payload.activeEntityId, 'entity:cube');
  assert.equal((await router.handle(request('scene/transform', {
    commandId: 'command:move', baseRevision: 5, entityId: 'entity:cube',
    transform: { position: { x: 1, y: 2, z: 3 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  }))).ok, true);
  assert.equal((await router.handle(request('scene/material', { commandId: 'command:material', baseRevision: 6, entityId: 'entity:cube', material: 'pbr', color: [1, 0.2, 0.1, 1] }))).ok, true);
  assert.equal((await router.handle(request('viewport/report', { event: 'ready', message: 'gpu', sceneRevision: 2 }))).ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['create', 'select', 'transform', 'material']);
  assert.deepEqual(calls[0][1].color, [0.15, 0.8, 0.25, 1]);
  assert.deepEqual(calls[3][1].color, [1, 0.2, 0.1, 1]);
  assert.ok(events.some((event) => event.kind === 'viewport/ready' && event.source === 'studio.viewport.renderer'));
  router.dispose();
});

test('new-project IPC stays untitled until first save selects a directory', async () => {
  const calls = [];
  const workspace = {
    cancelAll() {},
    async newProject(root, name) { calls.push(['new', root, name]); return { projectRoot: null, document: { revision: 1, dirty: true } }; },
    async save() { calls.push(['save']); return { projectRoot: 'D:\\fixture-project', document: { revision: 1, savedRevision: 1, dirty: false } }; },
    async saveAs(root) { calls.push(['save-as', root]); return { projectRoot: root, document: { revision: 1, savedRevision: 1, dirty: false } }; },
    snapshot() { return { projectRoot: null, document: { revision: 1, dirty: true } }; },
  };
  const operationLog = { async append() { return {}; } };
  const router = new StudioIpcRouter({
    workspace, operationLog, ...agentOwners,
    selectProjectRoot: async (purpose) => purpose === 'save' ? 'D:\\fixture-project' : null,
  });
  const response = await router.handle(request('project/new', { name: 'Fixture' }));
  assert.equal(response.ok, true);
  assert.equal(response.payload.document.dirty, true);
  assert.deepEqual(calls, [['new', null, 'Fixture']]);
  const saved = await router.handle(request('project/save', {}));
  assert.equal(saved.ok, true);
  assert.deepEqual(calls, [['new', null, 'Fixture'], ['save-as', 'D:\\fixture-project']]);
  router.dispose();
});

test('script preview IPC discloses risk before one-shot code delivery and logs no source text', async () => {
  const events = [];
  const emittedText = 'compiled-secret-script();';
  const plan = {
    id: 'preview-plan:test', scriptId: 'script:test', entityId: 'entity:test', documentRevision: 4,
    textRevision: 2, digest: 'digest:test', capabilities: ['read'], risk: 'trusted-project', diagnostics: [], emittedText,
  };
  const scripts = {
    snapshot: () => ({ schemaVersion: 1, documentId: 'document:test', documentRevision: 4, resources: [] }),
    async prepare() { return plan; },
    async decide(planId, approved) { return approved ? { id: 'preview-grant:test', planId, expiresAt: 9_999 } : null; },
    consume() { return plan; },
  };
  const workspace = { snapshot: () => ({ document: { revision: 4 } }), cancelAll() {} };
  const operationLog = { async append(event) { events.push(event); return {}; } };
  const router = new StudioIpcRouter({ workspace, scripts, operationLog, ...agentOwners, selectProjectRoot: async () => null });

  const disclosure = await router.handle(request('preview/prepare', { scriptId: 'script:test', capabilities: ['read'] }));
  assert.equal(disclosure.ok, true);
  assert.equal(disclosure.payload.risk, 'trusted-project');
  assert.equal(Object.hasOwn(disclosure.payload, 'emittedText'), false);
  const authorized = await router.handle(request('preview/authorize', { planId: plan.id, approved: true }));
  assert.equal(authorized.payload.id, 'preview-grant:test');
  const consumed = await router.handle(request('preview/consume', { grantId: 'preview-grant:test' }));
  assert.equal(consumed.payload.emittedText, emittedText);
  assert.equal(JSON.stringify(events).includes(emittedText), false);
  router.dispose();
});

test('cancel and renderer disposal invalidate late IPC responses', async () => {
  let cancelAll = 0;
  const workspace = {
    snapshot: () => ({ state: 'ok' }),
    cancelAll: () => { cancelAll += 1; },
    async execute(_command, signal) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return { late: true };
    },
  };
  const operationLog = { append: async () => ({}) };
  const router = new StudioIpcRouter({ workspace, operationLog, ...agentOwners, selectProjectRoot: async () => null });
  const pending = router.handle(request('project/command', {
    commandId: 'command:test', label: 'Set', baseRevision: 1, key: 'fixture.value', value: 1,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  router.cancel('request:test');
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.payload.diagnostic.code, 'ipc-cancelled');
  router.dispose();
  router.dispose();
  assert.equal(router.activeCount, 0);
  assert.ok(cancelAll >= 1);
});
