import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

test('combined authoring and isolated-preview bundles stay within the desktop descriptor budget', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const chunks = await readdir(new URL('chunks/', dist));
  const urls = [new URL('renderer.js', dist), new URL('preview-runtime.js', dist), ...chunks.filter((name) => name.endsWith('.js')).map((name) => new URL(`chunks/${name}`, dist))];
  const bundles = await Promise.all(urls.map((url) => readFile(url)));
  const rawBytes = bundles.reduce((total, bundle) => total + bundle.byteLength, 0);
  const gzipBytes = bundles.reduce((total, bundle) => total + gzipSync(bundle, { level: 9 }).byteLength, 0);
  assert.ok(rawBytes <= 2_000_000, `combined renderer raw bytes ${rawBytes} exceed 2000000`);
  assert.ok(gzipBytes <= 700_000, `combined renderer gzip bytes ${gzipBytes} exceed 700000`);
});
