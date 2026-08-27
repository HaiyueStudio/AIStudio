import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Play uses an active gameplay camera component and keeps the authoring camera as fallback', async () => {
  const renderer = await readFile(new URL('../src/renderer.ts', import.meta.url), 'utf8');
  const preview = await readFile(new URL('../src/preview-runtime.ts', import.meta.url), 'utf8');
  assert.match(renderer, /projectCameraFromSettings\(project\.document\.settings\)/);
  assert.match(renderer, /applyProjectCamera\(engineScene, nextCamera/);
  assert.match(renderer, /camera: sourceScene\.camera \?\? currentProjectCamera\(\)/);
  assert.match(preview, /normalizeProjectCamera\(rawScene\.camera\)/);
  assert.match(preview, /applyProjectCamera\(ownedScene, activeCamera/);
  assert.match(preview, /applyProjectCameraProjection\(ownedScene, activeCamera/);
  assert.match(preview, /configureGameplayCamera\(snapshot\.entities, ownedScene, canvas\)/);
  assert.match(preview, /ownedScene\.setCamera\(entity\)/);
  assert.match(preview, /haiyue\.camera\.follow/);
  assert.match(preview, /resizeGameplayCamera\(gameplayCamera/);
});
