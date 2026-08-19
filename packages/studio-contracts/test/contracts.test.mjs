import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STUDIO_PLUGIN_API_VERSION,
  asStableId,
  createStudioServiceToken,
  defineStudioPlugin,
} from '../dist/index.js';

test('stable ids, tokens and plugin definitions are immutable and versioned', () => {
  assert.throws(() => asStableId('bad id'), /Invalid/);
  const left = createStudioServiceToken('studio.history');
  const right = createStudioServiceToken('studio.history');
  assert.equal(left.key, right.key);
  const plugin = defineStudioPlugin({
    manifest: {
      schemaVersion: 1, id: asStableId('fixture.plugin'), version: '1.0.0', apiVersion: STUDIO_PLUGIN_API_VERSION,
      required: [], optional: [], provides: [], contributions: [], activationPolicy: 'required',
    },
    validateConfig(value) { return value; },
    activate() {},
  });
  assert.ok(Object.isFrozen(plugin));
  assert.ok(Object.isFrozen(plugin.manifest));
  assert.throws(() => defineStudioPlugin({ ...plugin, manifest: { ...plugin.manifest, apiVersion: '2.0' } }), /Unsupported/);
});
