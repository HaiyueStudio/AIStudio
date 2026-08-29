import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('trusted preview registers dynamic instance rendering in the Scene render pipeline', async () => {
  const source = await readFile(new URL('../src/preview-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /ownedScene\.addSystem\(new InstancedMesh3DRenderSystem\(ownedEngine, ownedScene\.activeCameraEntity, \{ loadOp: 'load' \}\)\);/);
  assert.doesNotMatch(source, /InstancedMesh3DRenderSystem[\s\S]{0,160}\), false\)/);
});

test('writing an instance automatically grows the visible instance count', async () => {
  const source = await readFile(new URL('../src/preview-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /let activeCount = 0;[\s\S]*set\(index: number, transform: InstanceTransformInput\)[\s\S]*if \(index >= activeCount\) \{[\s\S]*activeCount = index \+ 1;[\s\S]*material\.setActiveInstanceCount\(activeCount\);/);
});

test('instances preserve an unlit template material and its authored color', async () => {
  const source = await readFile(new URL('../src/preview-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /appearance\?\.material === 'pbr'[\s\S]*new InstancedPbrMaterial[\s\S]*new InstancedMaterial/);
  assert.match(source, /const templateColor = appearance\?\.color \?\? \[1, 1, 1, 1\]/);
  assert.match(source, /const color = transform\.color \?\? templateColor;[\s\S]*material\.setColor\(index, color\[0\], color\[1\], color\[2\], color\[3\] \?\? 1\);/);
});
