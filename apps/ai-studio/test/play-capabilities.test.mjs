import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('isolated Play owns fixed-step input, gameplay cameras, bounded picking and teardown', async () => {
  const source = await readFile(new URL('../src/preview-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /new PlaySimulation/);
  assert.match(source, /type === 'input'/);
  assert.match(source, /type === 'replay'/);
  assert.match(source, /type === 'step'/);
  assert.match(source, /type === 'inspect'/);
  assert.match(source, /new InteractionSystem\([^\n]+bindCanvas: false/);
  assert.match(source, /output\.length >= 256/);
  assert.match(source, /haiyue\.interaction\.pointer/);
  assert.match(source, /interactions: \(\) => interactionEvents/);
  assert.match(source, /cancelAnimationFrame\(animationFrame\)/);
  assert.match(source, /removeInputListeners\?\.\(\)/);
  assert.match(source, /simulation\?\.reset\(\)/);
});
