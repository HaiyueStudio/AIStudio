import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('editor panels use public HaiYue UI layout, tabs, dialog, select, and theme seams', async () => {
  const [html, webHtml, renderer, styles, manifest] = await Promise.all([
    readFile(new URL('../renderer/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/web.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);

  assert.equal((html.match(/<hy-split\b/g) ?? []).length, 4);
  assert.match(html, /id="workspace-split"[^>]+direction="horizontal"/);
  assert.match(html, /id="authoring-split"[^>]+direction="vertical"/);
  assert.match(html, /id="left-sidebar-split"[^>]+direction="vertical"/);
  assert.match(html, /id="hierarchy-panel"[\s\S]*id="inspector-panel"/);
  assert.match(html, /id="assets-panel"[\s\S]*id="resource-tabs"/);
  assert.match(html, /slot="scripts"[\s\S]*id="script-resources"/);
  assert.match(html, /id="right-tabs"[\s\S]*slot="agent"[^>]+id="chat-panel"[\s\S]*slot="logs"[^>]+id="logs-panel"/);
  assert.match(html, /id="script-panel" hidden aria-hidden="true"/);
  assert.match(html, /id="settings-dialog"[\s\S]*id="language-select"[\s\S]*id="theme-select"/);
  assert.match(html, /id="run-project"[\s\S]*id="run-dialog"[\s\S]*id="run-approve"/);
  assert.match(html, /id="run-validation"[^>]+role="alert"[^>]+hidden[\s\S]*id="run-diagnostics"/);
  assert.match(html, /id="run-validation-heading"[\s\S]*id="run-validation-hint"/);
  assert.match(html, /id="run-fix-agent"[^>]+data-i18n="fixWithAgent"/);
  assert.match(webHtml, /id="run-project"[\s\S]*id="run-dialog"[\s\S]*id="run-approve"/);
  assert.match(renderer, /previewDisclosure\.diagnostics\.filter[\s\S]*diagnostic\.severity === 'error'/);
  assert.match(renderer, /run-approve'\)\.disabled = errors\.length > 0/);
  assert.match(renderer, /value: 'scripts'/);
  assert.match(renderer, /Fix the committed AIStudio project script[\s\S]*script\.get[\s\S]*never use import, export/);
  assert.match(renderer, /No script is committed[\s\S]*may not have been approved or committed[\s\S]*script\.propose[\s\S]*script\.apply/);
  assert.match(html, /data-theme="dark" data-language="zh-CN"/);
  assert.match(webHtml, /data-shell="web" data-theme="dark" data-language="zh-CN"/);
  assert.match(html, /min-first="\d+"[^>]+min-second="\d+"/);
  assert.match(html, /style-src 'self' 'unsafe-inline'/);
  assert.match(renderer, /from '@haiyue\/ui\/(dialog|select|split|tabs)'/);
  assert.match(renderer, /defineSplitComponents\(\)/);
  assert.match(renderer, /defineTabsComponents\(\)/);
  assert.match(renderer, /defineDialogComponents\(\)/);
  assert.match(renderer, /defineSelectComponents\(\)/);
  assert.match(renderer, /haiyue\.ai-studio\.language\.v1/);
  assert.match(renderer, /haiyue\.ai-studio\.theme\.v1/);
  assert.match(renderer, /addEventListener\('ratio-change'/);
  assert.match(html, /id="viewport-empty-state"/);
  assert.match(renderer, /Preview scene has no renderable geometry/);
  assert.match(html, /id="geometry-resources"[\s\S]*id="material-resources"/);
  assert.match(renderer, /sphere[\s\S]*cone[\s\S]*directional-light[\s\S]*point-light/);
  assert.match(renderer, /async function preparePreview[\s\S]*scene\?\.entities\.some/);
  assert.match(renderer, /const editorChanged = await refreshConversation\(false\);[\s\S]*if \(editorChanged\) await refresh\(\);/);
  assert.match(renderer, /if \(!command\.scene\) await refresh\(\);[\s\S]*startPreview\(command\.plan, command\.scene \?\? scene\)/);
  assert.doesNotMatch(styles, /#workspace\s*\{[^}]*grid-template-columns/);
  assert.match(styles, /--studio-accent:\s*var\(--hy-accent-color/);
  assert.match(renderer, /function renderSelection[\s\S]*viewport\.select\(selection\.activeEntityId\)/);
  assert.match(renderer, /await selectEntity\(entity\.id, 'hierarchy'\)/);
  assert.match(renderer, /new OrbitControl\(this\.canvas, cameraTransform/);
  assert.match(renderer, /updateTransform\(entityId[\s\S]*component\.setPosition/);
  assert.match(renderer, /async function applyTransform[\s\S]*viewport\?\.updateTransform[\s\S]*renderProjectChrome\(\)/);
  assert.match(styles, /hy-border-beam/);
  assert.equal(manifest.dependencies['@haiyue/ui'], '0.1.1');
});
