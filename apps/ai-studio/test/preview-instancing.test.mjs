import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('trusted preview registers dynamic instance rendering in the Scene render pipeline', async () => {
  const source = await readFile(new URL('../src/preview-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /ownedScene\.addSystem\(new InstancedMesh3DRenderSystem\(ownedEngine, ownedScene\.cameraEntity, \{ loadOp: 'load' \}\)\);/);
  assert.doesNotMatch(source, /InstancedMesh3DRenderSystem[\s\S]{0,160}\), false\)/);
});
