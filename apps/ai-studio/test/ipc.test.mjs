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
    commandId: 'command:cube', baseRevision: 1, kind: 'cube', name: 'Player', parentId: null,
  })).channel, 'scene/create');
  assert.throws(() => validateStudioIpcRequest(request('scene/create', {
    commandId: 'command:cube', baseRevision: 1, kind: 'light',
  })), /scene\/create payload/);
  assert.throws(() => validateStudioIpcRequest(request('scene/select', {
    entityId: 'entity:test', source: 'remote-shell',
  })), /scene\/select payload/);
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
  };
  const selection = {
    async select(entityId, source, correlationId) { calls.push(['select', { entityId, source, correlationId }]); return { activeEntityId: entityId, entityIds: entityId ? [entityId] : [], revision: 1, source }; },
  };
  const operationLog = { async append(event) { events.push(event); return {}; } };
  const router = new StudioIpcRouter({ workspace, scene, selection, operationLog, ...agentOwners, selectProjectRoot: async () => null, smoke: true });

  assert.equal((await router.handle(request('app/status'))).payload.smoke, true);
  assert.equal((await router.handle(request('scene/snapshot'))).payload.revision, 2);
  assert.equal((await router.handle(request('scene/create', { commandId: 'command:cube', baseRevision: 4, kind: 'cube' }))).ok, true);
  assert.equal((await router.handle(request('scene/select', { entityId: 'entity:cube', source: 'hierarchy' }))).payload.activeEntityId, 'entity:cube');
  assert.equal((await router.handle(request('scene/transform', {
    commandId: 'command:move', baseRevision: 5, entityId: 'entity:cube',
    transform: { position: { x: 1, y: 2, z: 3 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  }))).ok, true);
  assert.equal((await router.handle(request('viewport/report', { event: 'ready', message: 'gpu', sceneRevision: 2 }))).ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['create', 'select', 'transform']);
  assert.ok(events.some((event) => event.kind === 'viewport/ready' && event.source === 'studio.viewport.renderer'));
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
