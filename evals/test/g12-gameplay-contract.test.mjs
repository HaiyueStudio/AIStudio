import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectG12GameplayContract } from '../src/index.mjs';

test('gameplay contract requires state plus an authoritative event channel without genre knowledge', () => {
  const missing = inspectG12GameplayContract({ resources: [{ enabled: true, text: "api.scene.observe('gameplay', { score: 1 });" }] });
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.diagnostics, [
    'g12.gameplay-trigger-channel-missing', 'g12.gameplay-state-channel-missing', 'g12.gameplay-schema-version-missing',
    'g12.gameplay-space-missing', 'g12.gameplay-metrics-missing', 'g12.gameplay-actors-missing', 'g12.gameplay-targets-missing',
  ]);
  const valid = inspectG12GameplayContract({ resources: [{ enabled: true, text: "api.scene.observe('gameplay', { schemaVersion: 1, status: 'playing', events, space, metrics, actors, targets });" }] });
  assert.equal(valid.valid, true);
  const misleading = inspectG12GameplayContract({ resources: [{ enabled: true, text: "const events = []; api.scene.observe('gameplay', { schemaVersion: 1, status: 'playing', recentEvents: events, space, metrics, actors, targets });" }] });
  assert.deepEqual(misleading.diagnostics, ['g12.gameplay-trigger-channel-missing']);
});

test('gameplay contract recognizes typed scene receivers and named payloads without weakening exact channel keys', () => {
  const asserted = inspectG12GameplayContract({ resources: [{ enabled: true, text: "const payload = Object.freeze({ schemaVersion: 1, state: 'playing', events, space, metrics, actors, targets }); (api.scene as any).observe('gameplay', payload);" }] });
  assert.equal(asserted.valid, true);
  const aliased = inspectG12GameplayContract({ resources: [{ enabled: true, text: "const scene: any = api.scene; const telemetry = { schemaVersion: 1, phase: 'running', triggers, space, metrics, actors, targets }; scene.observe('gameplay', telemetry);" }] });
  assert.equal(aliased.valid, true);
  const misleading = inspectG12GameplayContract({ resources: [{ enabled: true, text: "const scene: any = api.scene; scene.observe('gameplay', { schemaVersion: 1, state: 'playing', recentEvents: events, space, metrics, actors, targets });" }] });
  assert.deepEqual(misleading.diagnostics, ['g12.gameplay-trigger-channel-missing']);
});

test('gameplay contract rejects incomplete canonical state even when legacy lifecycle channels exist', () => {
  const incomplete = inspectG12GameplayContract({ resources: [{ enabled: true, text: "api.scene.observe('gameplay', { state: 'running', events, score: 1, interactionTargets });" }] });
  assert.deepEqual(incomplete.diagnostics, [
    'g12.gameplay-schema-version-missing', 'g12.gameplay-space-missing', 'g12.gameplay-metrics-missing',
    'g12.gameplay-actors-missing', 'g12.gameplay-targets-missing',
  ]);
});
