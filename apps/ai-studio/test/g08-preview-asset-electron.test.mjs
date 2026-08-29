import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('sandboxed product preview resolves a controlled blob texture and releases every owner', { timeout: 100_000 }, async () => {
  const appRoot = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1'));
  const output = await mkdtemp(path.join(tmpdir(), 'haiyue-g08-preview-asset-'));
  const html = path.join(output, 'host.html');
  await writeFile(html, hostHtml('haiyue-preview://app/preview.html'));
  const fixture = new URL('./fixtures/g08-preview-asset-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
  const result = await run(electronPath, [fixture], { ...process.env, HAIYUE_G08_PREVIEW_ASSET_FILE: html, HAIYUE_G08_PREVIEW_ROOT: path.join(appRoot, 'dist'), HAIYUE_G08_USER_DATA: path.join(output, 'user-data') });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[g08-preview-asset-smoke\] blob-texture textures=1 materials=1 cleanup=0/);
});

function hostHtml(previewUrl) {
  const pbr = { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.7, emissiveFactor: [0, 0, 0], normalScale: 1, occlusionStrength: 1, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, baseColorAssetId: 'asset:0123456789abcdef01234567', normalAssetId: 'asset:unbound-normal' };
  const scene = { documentId: 'document:asset-preview', revision: 1, entities: [{ id: 'entity:asset-preview', name: 'Asset Preview', kind: 'cube', parentId: null, order: 0, transform: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, appearance: { material: 'basic', color: [1, 1, 1, 1] }, components: [{ id: 'component:asset-preview-pbr', type: 'haiyue.material.pbr', version: '1.0.0', enabled: true, value: pbr }] }] };
  const plan = { id: 'preview-plan:asset', documentId: scene.documentId, documentRevision: scene.revision, selection: 'all-enabled', scriptSetDigest: 'sha256:' + 'a'.repeat(64), scripts: [{ scriptId: 'script:asset-preview', entityId: 'entity:asset-preview', order: 0, textRevision: 1, digest: 'a'.repeat(64), capabilities: ['read'], diagnostics: [], emittedText: 'void time;' }], capabilities: ['read'], runtimeConfig: { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'haiyue-play' }, risk: 'trusted-project', diagnostics: [] };
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><script>
    const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.src = ${JSON.stringify(previewUrl)}; document.body.append(frame);
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl2cAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([png], { type: 'image/png' })); let manifest = null; let stopping = false;
    const fail = message => { URL.revokeObjectURL(url); document.body.dataset.previewAssetStatus = 'failed'; document.body.dataset.previewAssetError = message; };
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || !event.data || event.data.protocol !== 'haiyue-preview/1') return;
      if (event.data.type === 'ready') frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'start', scene: ${JSON.stringify(scene)}, plan: ${JSON.stringify(plan)}, assets: [{ id: 'asset:0123456789abcdef01234567', kind: 'texture', mimeType: 'image/png', byteLength: png.byteLength, url }] }, '*');
      else if (event.data.type === 'runtime-error') fail(event.data.code + ': ' + event.data.message);
      else if (event.data.type === 'started') { manifest = event.data.renderEffects; setTimeout(() => { stopping = true; frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'stop' }, '*'); }, 750); }
      else if (event.data.type === 'cleanup-complete' && stopping) { URL.revokeObjectURL(url); document.body.dataset.previewAssetResult = JSON.stringify({ textures: manifest.owners.textures, materials: manifest.owners.materials, cleanup: event.data.disposableCount }); document.body.dataset.previewAssetStatus = 'passed'; }
    });
    setTimeout(() => fail('host deadline exceeded'), 40000);
  </script></body></html>`;
}

function run(command, args, env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject); child.once('exit', code => resolve({ code, output })); }); }
