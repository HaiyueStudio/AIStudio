import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('authoring viewport and isolated preview consume the same persisted project camera', async () => {
  const renderer = await readFile(new URL('../src/renderer.ts', import.meta.url), 'utf8');
  const preview = await readFile(new URL('../src/preview-runtime.ts', import.meta.url), 'utf8');
  assert.match(renderer, /projectCameraFromSettings\(project\.document\.settings\)/);
  assert.match(renderer, /applyProjectCamera\(engineScene, nextCamera/);
  assert.match(renderer, /camera: sourceScene\.camera \?\? currentProjectCamera\(\)/);
  assert.match(preview, /normalizeProjectCamera\(rawScene\.camera\)/);
  assert.match(preview, /applyProjectCamera\(ownedScene, activeCamera/);
  assert.match(preview, /applyProjectCameraProjection\(ownedScene, activeCamera/);
});
