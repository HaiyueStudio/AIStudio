import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseBehaviorContract } from '@haiyue/ai-studio-script-preview';
import { GAME_AUTHORING_TOOL_DEFINITIONS } from '../dist/index.js';
import { behaviorFixture, call, execute } from './behavior-fixture.mjs';

test('resource kinds keep their legal creation/component/location paths without a catalog UI or behavior source', async t => {
  const f = await behaviorFixture({ noSource: true }); t.after(f.close);
  const revision = () => f.workspace.snapshot().document.revision;
  const cases = JSON.parse(await readFile(new URL('../../../config/contracts/fixtures/m14-resource-contract-cases.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(f.workspace.gameSnapshot()), history = JSON.stringify(f.workspace.snapshot().history);
  for (const fixture of cases.valid.filter(item => item.value.kind !== 'asset')) {
    const entry = parseBehaviorContract('resource-catalog-entry', fixture.value);
    const wrongId = entry.ref.templateId ?? entry.ref.presetId ?? entry.ref.entityId;
    await assert.rejects(f.runtime.prepare(call(`call:wrong-kind-${entry.kind}`, 'asset.assign', { baseRevision: revision(), entityId: f.entityId, assetId: wrongId, usage: 'texture.base-color' })), e => e.code === 'tool.arguments-invalid');
  }
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(JSON.stringify(f.workspace.snapshot().history), history);
  // Existing creation is the admitted path. This does not fabricate a persistent
  // catalog template/preset, whose UI and storage admission remain G06's concern.
  const created = await execute(f, 'entity.create', { baseRevision: revision(), kind: 'directional-light', name: 'Light instance' });
  const entityId = created.value.entity.id;
  const light = f.workspace.queryGameDocument({ entityId, limit: 256 }).components.find(item => item.type.startsWith('haiyue.light.'));
  assert.ok(light);
  const description = await execute(f, 'component.describe', { type: light.type, version: light.version });
  assert.equal(description.value.definition.type, light.type);
  const edited = await execute(f, 'component.configure', { baseRevision: revision(), entityId, action: 'upsert', type: light.type, version: light.version, patch: { intensity: 2 } });
  assert.equal(edited.status, 'completed');
  assert.equal((await execute(f, 'component.get', { entityId, type: light.type })).value.component.value.intensity, 2);
  const afterEdit = revision(); await f.workspace.undo(afterEdit);
  assert.equal((await execute(f, 'component.get', { entityId, type: light.type })).value.component.value.intensity, light.value.intensity);
  await f.workspace.redo(revision());
  assert.equal((await execute(f, 'component.get', { entityId, type: light.type })).value.component.value.intensity, 2);
  assert.equal((await execute(f, 'asset.search', { limit: 10 })).status, 'completed');
  assert.equal((await execute(f, 'entity.get', { entityId })).status, 'completed');
  assert.equal(f.sourceReads, 0);
  assert.equal(GAME_AUTHORING_TOOL_DEFINITIONS.some(tool => tool.id === 'scene.transaction'), false);
});
