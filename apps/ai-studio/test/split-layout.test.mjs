import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('editor panels use the public HaiYue UI split component', async () => {
  const [html, renderer, styles, manifest] = await Promise.all([
    readFile(new URL('../renderer/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);

  assert.equal((html.match(/<ge-split\b/g) ?? []).length, 4);
  assert.match(html, /id="workspace-split"[^>]+direction="horizontal"/);
  assert.match(html, /id="authoring-split"[^>]+direction="vertical"/);
  assert.match(html, /id="sidebar-split"[^>]+direction="vertical"/);
  assert.match(html, /min-first="\d+"[^>]+min-second="\d+"/);
  assert.match(html, /style-src 'self' 'unsafe-inline'/);
  assert.match(renderer, /from '@haiyue\/ui'/);
  assert.match(renderer, /defineSplitComponents\(\)/);
  assert.match(renderer, /addEventListener\('ratio-change'/);
  assert.match(html, /id="viewport-empty-state"/);
  assert.match(renderer, /Preview scene has no renderable entities/);
  assert.match(renderer, /async function preparePreview[\s\S]*scene\?\.entities\.some/);
  assert.doesNotMatch(styles, /#workspace\s*\{[^}]*grid-template-columns/);
  assert.equal(manifest.dependencies['@haiyue/ui'], '0.1.0');
});
