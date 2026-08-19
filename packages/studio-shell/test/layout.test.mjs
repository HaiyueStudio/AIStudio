import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STUDIO_PANELS, STUDIO_PANEL_IDS, createStudioWorkspaceLayoutPlugin } from '../dist/index.js';

test('workspace layout has six stable panel identities and no executable surface', () => {
  assert.deepEqual(DEFAULT_STUDIO_PANELS.map((item) => item.id), [
    STUDIO_PANEL_IDS.hierarchy, STUDIO_PANEL_IDS.viewport, STUDIO_PANEL_IDS.inspector,
    STUDIO_PANEL_IDS.script, STUDIO_PANEL_IDS.chat, STUDIO_PANEL_IDS.logs,
  ]);
  assert.ok(DEFAULT_STUDIO_PANELS.every((item) => item.editorKind === 'panel' && item.placeholder));
  const plugin = createStudioWorkspaceLayoutPlugin();
  assert.deepEqual(plugin.manifest.contributions, ['studio.contribution.panel']);
  assert.equal(plugin.manifest.required.length, 0);
});
