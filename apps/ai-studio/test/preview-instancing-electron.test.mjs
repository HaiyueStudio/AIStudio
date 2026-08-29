import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('sandboxed Play renders authored basic-color instances without scene lights', { timeout: 100_000 }, async () => {
  const appRoot = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1'));
  const output = await mkdtemp(path.join(tmpdir(), 'haiyue-preview-instancing-'));
  const html = path.join(output, 'host.html');
  await writeFile(html, hostHtml('haiyue-preview://app/preview.html'));
  const fixture = new URL('./fixtures/preview-instancing-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
  const result = await run(electronPath, [fixture], {
    ...process.env,
    HAIYUE_INSTANCE_HOST_FILE: html,
    HAIYUE_INSTANCE_PREVIEW_ROOT: path.join(appRoot, 'dist'),
    HAIYUE_INSTANCE_USER_DATA: path.join(output, 'user-data'),
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[preview-instancing-smoke\] cyan=\d+ chromatic=\d+/);
});

function hostHtml(previewUrl) {
  const scene = { documentId: 'document:instance-visual', revision: 1, entities: [{
    id: 'entity:block', name: 'BlockTemplate', kind: 'cube', parentId: null, order: 0,
    transform: { position: { x: 30, y: -5, z: 30 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    appearance: { material: 'basic', color: [0.05, 0.85, 0.9, 1] },
  }] };
  const emittedText = `const blocks = api.scene.instances('entity:block', 8); blocks.set(0, { position: { x: 0, y: 0, z: 0 }, scale: { x: 4, y: 4, z: 4 } });`;
  const plan = { id: 'preview-plan:instance-visual', documentId: scene.documentId, documentRevision: scene.revision, selection: 'all-enabled', scriptSetDigest: 'sha256:' + 'c'.repeat(64), scripts: [{ scriptId: 'script:block', entityId: 'entity:block', order: 0, textRevision: 1, digest: 'd'.repeat(64), capabilities: ['scene'], diagnostics: [], emittedText }], capabilities: ['scene'], runtimeConfig: { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'haiyue-play' }, risk: 'trusted-project', diagnostics: [] };
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#000}</style></head><body><script>
    const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.src = ${JSON.stringify(previewUrl)}; document.body.append(frame);
    const fail = message => { document.body.dataset.status = 'failed'; document.body.dataset.error = message; };
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || !event.data || event.data.protocol !== 'haiyue-preview/1') return;
      if (event.data.type === 'ready') frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'start', scene: ${JSON.stringify(scene)}, plan: ${JSON.stringify(plan)}, assets: [] }, '*');
      else if (event.data.type === 'state' && event.data.tick >= 10) document.body.dataset.status = 'passed';
      else if (event.data.type === 'runtime-error') fail(event.data.code + ': ' + event.data.message);
    });
    setTimeout(() => fail('instance preview deadline exceeded'), 40000);
  </script></body></html>`;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}
