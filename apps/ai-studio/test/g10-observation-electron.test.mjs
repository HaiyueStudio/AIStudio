import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('G10 real sandboxed Play steps, inspects and captures same-tick PNG evidence', { timeout: 100_000 }, async () => {
  const appRoot = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1'));
  const output = await mkdtemp(path.join(tmpdir(), 'haiyue-g10-observation-'));
  const html = path.join(output, 'host.html');
  await writeFile(html, hostHtml('haiyue-preview://app/preview.html'));
  const fixture = new URL('./fixtures/g10-observation-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
  const result = await run(electronPath, [fixture], { ...process.env, HAIYUE_G10_HOST_FILE: html, HAIYUE_G10_PREVIEW_ROOT: path.join(appRoot, 'dist'), HAIYUE_G10_USER_DATA: path.join(output, 'user-data') });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[g10-observation-smoke\] tick=1 frame=\d+ pngBytes=\d+ sameTick=true hud=true cleanup=0/);
});

function hostHtml(previewUrl) {
  const scene = { documentId: 'document:g10', revision: 11, entities: [{ id: 'entity:player', name: 'Player', kind: 'cube', parentId: null, order: 0, transform: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, appearance: { material: 'basic', color: [0.1, 0.8, 0.3, 1] } }] };
  const script = `const transform = entity.getComponent('CartesianTransform3D');\nif (api.input.isPressed('move-right')) transform?.setPosition(1, 0, 0);\napi.scene.hudText('score', 'Score: 1', { position: 'top-left' });`;
  const plan = { id: 'preview-plan:g10', documentId: scene.documentId, documentRevision: scene.revision, selection: 'all-enabled', scriptSetDigest: 'sha256:' + 'b'.repeat(64), scripts: [{ scriptId: 'script:player', entityId: 'entity:player', order: 0, textRevision: 1, digest: 'sha256:' + 'a'.repeat(64), capabilities: ['read', 'scene', 'input'], diagnostics: [], emittedText: script }], capabilities: ['read', 'scene', 'input'], runtimeConfig: { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'haiyue-play' }, risk: 'trusted-project', diagnostics: [] };
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{width:393px;height:852px;border:0}</style></head><body><script>
    const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.src = ${JSON.stringify(previewUrl)}; document.body.append(frame);
    let phase = 'starting', inspected = null;
    const fail = message => { document.body.dataset.g10Status = 'failed'; document.body.dataset.g10Error = message; };
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || !event.data || event.data.protocol !== 'haiyue-preview/1') return;
      const data = event.data;
      if (data.type === 'ready') frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'start', scene: ${JSON.stringify(scene)}, plan: ${JSON.stringify(plan)}, assets: [] }, '*');
      else if (data.type === 'started') frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'pause' }, '*');
      else if (data.type === 'paused' && phase === 'starting') { phase = 'stepping'; frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'input', event: { tick: 1, kind: 'action', action: 'move-right', phase: 'down', source: 'synthetic' } }, '*'); frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'step', requestId: 'step:1', count: 1 }, '*'); }
      else if (data.type === 'stepped' && data.requestId === 'step:1') { frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'inspect', requestId: 'inspect:1' }, '*'); }
      else if (data.type === 'inspection' && data.requestId === 'inspect:1') { inspected = data.value; frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'capture', requestId: 'capture:1' }, '*'); }
      else if (data.type === 'capture' && data.requestId === 'capture:1') {
        const bytes = Uint8Array.from(atob(data.base64), char => char.charCodeAt(0)); const png = [137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value);
        if (!png) return fail('capture was not PNG'); phase = 'stopping'; window.result = { tick: inspected.tick, frame: inspected.frame, pngBytes: data.byteLength, sameTick: data.tick === inspected.tick, hud: Object.keys(inspected.hud || {}).length > 0 }; frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'stop' }, '*');
      } else if (data.type === 'request-failed') fail(data.message); else if (data.type === 'runtime-error') fail(data.code + ': ' + data.message);
      else if (data.type === 'cleanup-complete' && phase === 'stopping') { document.body.dataset.g10Result = JSON.stringify({ ...window.result, cleanup: data.disposableCount }); document.body.dataset.g10Status = 'passed'; }
    });
    setTimeout(() => fail('host deadline exceeded'), 40000);
  </script></body></html>`;
}

function run(command, args, env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject); child.once('exit', code => resolve({ code, output })); }); }
