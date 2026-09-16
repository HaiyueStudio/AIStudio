import test from 'node:test';
import assert from 'node:assert/strict';
import { isToolConcurrencyHintV1 } from '../dist/index.js';

test('concurrency hints are bounded, versioned host metadata without extra authority or secret fields', () => {
  const target = { toolId: 'scene.query', toolVersion: '1.0.0' };
  for (const hint of [{ schemaVersion: 1, mode: 'parallel-read' }, { schemaVersion: 1, mode: 'exclusive' }, { schemaVersion: 1, mode: 'invoke', targets: [target] }]) assert.equal(isToolConcurrencyHintV1(hint), true);
  for (const hint of [null, {}, { schemaVersion: 2, mode: 'parallel-read' }, { schemaVersion: 1, mode: 'parallel' },
    { schemaVersion: 1, mode: 'parallel-read', apiKey: 'secret-canary' },
    { schemaVersion: 1, mode: 'invoke', targets: [target, target] },
    { schemaVersion: 1, mode: 'invoke', targets: Array(129).fill(target) },
    ...[{ ...target, toolId: 'studio.tool.invoke' }, { ...target, toolVersion: 'Bearer secret-canary' }, { ...target, authorization: 'secret-canary' }].map(item => ({ schemaVersion: 1, mode: 'invoke', targets: [item] }))]) assert.equal(isToolConcurrencyHintV1(hint), false);
});
