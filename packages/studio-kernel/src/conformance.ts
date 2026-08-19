import { asStableId, defineStudioPlugin, type JsonObject, type StudioPluginDefinition, type StudioProfileDefinition } from '@haiyue/ai-studio-contracts';
import { resolveStudioProfile } from './index.js';

export function createKernelConformanceFixture(): Readonly<{
  profile: StudioProfileDefinition;
  catalog: readonly StudioPluginDefinition[];
}> {
  const provider = defineStudioPlugin<JsonObject>({
    manifest: {
      schemaVersion: 1, id: asStableId('fixture.provider'), version: '1.0.0', apiVersion: '1.0',
      required: [], optional: [], provides: [{ id: asStableId('fixture.service'), version: '1.0.0' }],
      contributions: [], activationPolicy: 'required',
    },
    validateConfig(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('config'); return value as JsonObject; },
    activate() {},
  });
  const consumer = defineStudioPlugin<JsonObject>({
    manifest: {
      schemaVersion: 1, id: asStableId('fixture.consumer'), version: '1.0.0', apiVersion: '1.0',
      required: [{ id: asStableId('fixture.service'), version: '^1.0.0' }], optional: [], provides: [],
      contributions: [], activationPolicy: 'required',
    },
    validateConfig(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('config'); return value as JsonObject; },
    activate() {},
  });
  const profile: StudioProfileDefinition = {
    schemaVersion: 1,
    id: asStableId('profile.conformance'),
    bundles: [{
      id: asStableId('bundle.base'),
      rows: [
        { id: asStableId('row.consumer'), pluginId: consumer.manifest.id, enabled: true, config: { order: 'second' } },
        { id: asStableId('row.provider'), pluginId: provider.manifest.id, enabled: true, config: { order: 'first' } },
      ],
    }],
    patches: [{ pluginId: consumer.manifest.id, config: { patched: true } }],
  };
  return Object.freeze({ profile, catalog: Object.freeze([provider, consumer]) });
}

export function runKernelResolutionConformance(): string {
  const fixture = createKernelConformanceFixture();
  const resolved = resolveStudioProfile(fixture.profile, fixture.catalog);
  if (resolved.rows.map((row) => row.pluginId).join(',') !== 'fixture.provider,fixture.consumer') {
    throw new Error('Dependency order is not deterministic.');
  }
  return resolved.configDump;
}
