import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioIpcRouter, validateStudioIpcRequest } from '../dist/ipc.js';

function request(channel, payload = {}) {
  return { schemaVersion: 1, id: 'request:test', correlationId: 'correlation:test', channel, payload };
}

test('IPC validator is versioned, allowlisted and never accepts renderer paths', () => {
  assert.equal(validateStudioIpcRequest(request('app/status')).channel, 'app/status');
  assert.throws(() => validateStudioIpcRequest(request('shell:exec')), /not allowed/);
  assert.throws(() => validateStudioIpcRequest(request('project/open', { path: 'C:\\secret' })), /does not accept payload/);
  assert.throws(() => validateStudioIpcRequest(request('project/command', {
    commandId: 'command:test', label: 'Set', baseRevision: 1, key: 'fixture.value', value: undefined,
  })), /bounded JSON/);
  assert.throws(() => validateStudioIpcRequest({ ...request('app/status'), schemaVersion: 2 }), /envelope/);
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
  const router = new StudioIpcRouter({ workspace, operationLog, selectProjectRoot: async () => null });
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
