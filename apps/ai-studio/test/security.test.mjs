import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('packaged desktop sources retain the Electron security and CSP invariants', async () => {
  const main = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../dist/preload.cjs', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../dist/renderer.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);
  assert.match(main, /persist:haiyue-ai-studio/);
  assert.match(preload, /studio:request/);
  assert.match(preload, /studio:cancel/);
  assert.doesNotMatch(preload, /child_process|node:fs|shell\.openExternal/);
  assert.doesNotMatch(renderer, /node:fs|child_process|ipcRenderer|require\(/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /https?:\/\//);
});
