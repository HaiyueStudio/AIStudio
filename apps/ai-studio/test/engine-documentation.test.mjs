import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEngineDocumentation } from '../dist/engine-documentation.js';

test('desktop serves the same version-bound documentation as the tool release resource', async () => {
  const docs = await loadEngineDocumentation();
  const release = JSON.parse(await readFile(new URL(import.meta.resolve('@haiyue/ai-studio-game-authoring-tools/engine-docs/bundle.json')), 'utf8'));
  assert.equal(docs.bundle.digest, release.digest);
  assert.equal(await loadEngineDocumentation(), docs, 'one immutable index for both backend profiles and automatic guide retrieval');
  const result = docs.search({ query: 'api.scene.instances' });
  const page = docs.read({ id: result.matches[0].id, bundleDigest: result.bundleDigest });
  assert.equal(page.surface, 'studio-script');
  assert.match(page.blocks.join('\n'), /capacity|Capacity/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16384);
});
