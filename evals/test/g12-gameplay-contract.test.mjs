import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectG12GameplayContract } from '../src/index.mjs';

test('gameplay contract requires state plus an authoritative event channel without genre knowledge', () => {
  const missing = inspectG12GameplayContract({ resources: [{ enabled: true, text: "api.scene.observe('gameplay', { score: 1 });" }] });
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.diagnostics, ['g12.gameplay-trigger-channel-missing', 'g12.gameplay-state-channel-missing']);
  const valid = inspectG12GameplayContract({ resources: [{ enabled: true, text: "api.scene.observe('gameplay', { status: 'playing', events });" }] });
  assert.equal(valid.valid, true);
  const misleading = inspectG12GameplayContract({ resources: [{ enabled: true, text: "const events = []; api.scene.observe('gameplay', { status: 'playing', recentEvents: events });" }] });
  assert.deepEqual(misleading.diagnostics, ['g12.gameplay-trigger-channel-missing']);
});

test('gameplay contract recognizes typed scene receivers and named payloads without weakening exact channel keys', () => {
  const asserted = inspectG12GameplayContract({ resources: [{ enabled: true, text: "const payload = Object.freeze({ state: 'playing', events }); (api.scene as any).observe('gameplay', payload);" }] });
  assert.equal(asserted.valid, true);
  const aliased = inspectG12GameplayContract({ resources: [{ enabled: true, text: "const scene: any = api.scene; const telemetry = { phase: 'running', triggers }; scene.observe('gameplay', telemetry);" }] });
  assert.equal(aliased.valid, true);
  const misleading = inspectG12GameplayContract({ resources: [{ enabled: true, text: "const scene: any = api.scene; scene.observe('gameplay', { state: 'playing', recentEvents: events });" }] });
  assert.deepEqual(misleading.diagnostics, ['g12.gameplay-trigger-channel-missing']);
});
