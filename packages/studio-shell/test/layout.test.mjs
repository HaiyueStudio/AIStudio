import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STUDIO_PANELS, STUDIO_PANEL_IDS, createStudioWorkspaceLayoutPlugin } from '../dist/index.js';

test('workspace layout exposes the asset-centric panel arrangement and hides script by default', () => {
  assert.deepEqual(DEFAULT_STUDIO_PANELS.map((item) => item.id), [
    STUDIO_PANEL_IDS.hierarchy, STUDIO_PANEL_IDS.inspector, STUDIO_PANEL_IDS.viewport, STUDIO_PANEL_IDS.assets,
    STUDIO_PANEL_IDS.script, STUDIO_PANEL_IDS.chat, STUDIO_PANEL_IDS.logs,
  ]);
  assert.deepEqual(DEFAULT_STUDIO_PANELS.filter((item) => item.region === 'left').map((item) => item.id), [STUDIO_PANEL_IDS.hierarchy, STUDIO_PANEL_IDS.inspector]);
  assert.deepEqual(DEFAULT_STUDIO_PANELS.filter((item) => item.region === 'right').map((item) => item.id), [STUDIO_PANEL_IDS.chat, STUDIO_PANEL_IDS.logs]);
  assert.ok(DEFAULT_STUDIO_PANELS.every((item) => item.editorKind === 'panel'));
  assert.deepEqual(DEFAULT_STUDIO_PANELS.filter((item) => !item.placeholder).map((item) => item.id), [STUDIO_PANEL_IDS.chat, STUDIO_PANEL_IDS.logs]);
  const plugin = createStudioWorkspaceLayoutPlugin();
  assert.deepEqual(plugin.manifest.contributions, ['studio.contribution.panel']);
  assert.equal(plugin.manifest.required.length, 0);
});
