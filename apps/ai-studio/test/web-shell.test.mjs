import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WebStudioHost } from '../dist/web-host.js';

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

test('creating a new Web draft never overwrites the last explicitly saved project', async () => {
  const previousStorage = globalThis.localStorage;
  const records = new Map();
  globalThis.localStorage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => { records.set(key, String(value)); },
    removeItem: (key) => { records.delete(key); },
  };
  try {
    const host = new WebStudioHost();
    assert.equal((await host.handle(request('project/new', { name: 'Saved Game' }))).ok, true);
    assert.equal((await host.handle(request('scene/create', {
      commandId: 'command:web-create', baseRevision: 1, kind: 'cube', name: 'Saved Cube', parentId: null,
    }))).ok, true);
    assert.equal((await host.handle(request('project/save'))).ok, true);
    const savedBeforeNew = records.get('haiyue.ai-studio.web.project.saved.v1');
    assert.ok(savedBeforeNew);

    const created = await host.handle(request('project/new', { name: 'Unsaved Draft' }));
    assert.equal(created.ok, true);
    assert.equal(created.payload.document.dirty, true);
    assert.equal(records.get('haiyue.ai-studio.web.project.saved.v1'), savedBeforeNew);

    const reopened = await host.handle(request('project/open'));
    assert.equal(reopened.ok, true);
    assert.equal(reopened.payload.document.name, 'Saved Game');
    const scene = await host.handle(request('scene/snapshot'));
    assert.equal(scene.payload.entities.length, 1);
    assert.equal(scene.payload.entities[0].name, 'Saved Cube');
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

function request(channel, payload = {}) {
  return { schemaVersion: 1, id: `request:web-${channel.replace('/', '-')}`, correlationId: 'correlation:web-project', channel, payload };
}
