import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('browser shell is a distinct secure entry with a bounded local host', async () => {
  const [html, host, entry, server, manifest, renderer] = await Promise.all([
    readFile(new URL('../renderer/web.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/web-host.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/web-entry.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/serve-web.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /data-shell="web"/);
  assert.match(html, /script type="module" src="\.\/web\.js"/);
  assert.match(html, /frame-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /unsafe-eval/);
  assert.match(entry, /installWebStudioHost\(\)/);
  assert.match(entry, /import\('\.\/renderer\.js'\)/);
  assert.match(host, /validateStudioIpcRequest/);
  assert.match(host, /localStorage/);
  assert.match(host, /web-agent-unavailable/);
  assert.match(host, /crypto\.subtle\.digest/);
  assert.doesNotMatch(host, /node:fs|child_process|ipcRenderer|process\.env/);
  assert.match(server, /listen\(requestedPort, '127\.0\.0\.1'/);
  assert.match(server, /candidate\.startsWith/);
  assert.match(JSON.parse(manifest).scripts['dev:web'], /serve-web\.mjs/);
  assert.match(renderer, /dataset\.shell === 'web' \? '\.\/preview\.html'/);
});
