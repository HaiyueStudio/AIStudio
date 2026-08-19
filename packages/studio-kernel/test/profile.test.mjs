import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StudioProfileResolutionError,
  createEditorFoundationProviderPlugin,
  resolveStudioProfile,
  satisfiesVersion,
} from '../dist/index.js';
import { createKernelConformanceFixture, runKernelResolutionConformance } from '../dist/conformance.js';
import { asStableId, defineStudioPlugin } from '@haiyue/ai-studio-contracts';

function plugin(id, { required = [], optional = [], provides = [] } = {}) {
  return defineStudioPlugin({
    manifest: {
      schemaVersion: 1, id: asStableId(id), version: '1.0.0', apiVersion: '1.0',
      required, optional, provides, contributions: [], activationPolicy: 'required',
    },
    validateConfig(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('config'); return value; },
    activate() {},
  });
}

function profile(ids) {
  return {
    schemaVersion: 1,
    id: asStableId('profile.test'),
    bundles: [{ id: asStableId('bundle.test'), rows: ids.map((id, index) => ({ id: asStableId(`row:${index}`), pluginId: asStableId(id), enabled: true, config: {} })) }],
    patches: [],
  };
}

test('profile composition is dependency ordered, patched and deterministic', () => {
  const fixture = createKernelConformanceFixture();
  const first = resolveStudioProfile(fixture.profile, fixture.catalog);
  const second = resolveStudioProfile(fixture.profile, fixture.catalog);
  assert.deepEqual(first.rows.map((row) => row.pluginId), ['fixture.provider', 'fixture.consumer']);
  assert.equal(first.configDump, second.configDump);
  assert.equal(first.configDump, runKernelResolutionConformance());
  assert.equal(JSON.parse(first.configDump).rows[1].config.patched, true);
});

test('missing, conflicting versions and cycles produce stable diagnostics', () => {
  const service = asStableId('fixture.service');
  const missing = plugin('fixture.missing', { required: [{ id: service, version: '1.0.0' }] });
  assert.throws(() => resolveStudioProfile(profile(['fixture.missing']), [missing]), (error) => {
    assert.ok(error instanceof StudioProfileResolutionError);
    assert.equal(error.diagnostics[0].code, 'STUDIO_CAPABILITY_REQUIRED_MISSING');
    return true;
  });
  const oldProvider = plugin('fixture.old-provider', { provides: [{ id: service, version: '1.0.0' }] });
  const newConsumer = plugin('fixture.new-consumer', { required: [{ id: service, version: '^2.0.0' }] });
  assert.throws(() => resolveStudioProfile(profile(['fixture.old-provider', 'fixture.new-consumer']), [oldProvider, newConsumer]), /VERSION_MISMATCH/);

  const aCap = asStableId('fixture.a-cap');
  const bCap = asStableId('fixture.b-cap');
  const a = plugin('fixture.a', { required: [{ id: bCap, version: '1.0.0' }], provides: [{ id: aCap, version: '1.0.0' }] });
  const b = plugin('fixture.b', { required: [{ id: aCap, version: '1.0.0' }], provides: [{ id: bCap, version: '1.0.0' }] });
  assert.throws(() => resolveStudioProfile(profile(['fixture.a', 'fixture.b']), [a, b]), /DEPENDENCY_CYCLE/);
});

test('version matcher is deliberately small and fail-closed', () => {
  assert.equal(satisfiesVersion('1.2.3', '^1.0.0'), true);
  assert.equal(satisfiesVersion('2.0.0', '^1.0.0'), false);
  assert.equal(satisfiesVersion('0.1.5', '>=0.1.0 <0.2.0'), true);
  assert.equal(satisfiesVersion('garbage', '*'), false);
  assert.equal(satisfiesVersion('1.0.0', 'latest'), false);
});

test('Editor foundations are one provider plugin, not a nested EditorPlatform host', () => {
  const definition = createEditorFoundationProviderPlugin();
  assert.equal(definition.manifest.id, 'studio.editor-foundations');
  assert.deepEqual(definition.manifest.provides.map((entry) => entry.id), [
    'editor.document', 'editor.history', 'editor.selection', 'editor.tasks', 'editor.project-session',
  ]);
});
