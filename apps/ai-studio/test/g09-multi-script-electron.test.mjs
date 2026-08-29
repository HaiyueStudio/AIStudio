import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('sandboxed product Play runs the authorized multi-script set in stable order and isolates one script fault', { timeout: 100_000 }, async () => {
  const appRoot = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1'));
  const output = await mkdtemp(path.join(tmpdir(), 'haiyue-g09-multi-script-'));
  const html = path.join(output, 'host.html');
  await writeFile(html, hostHtml('haiyue-preview://app/preview.html'));
  const fixture = new URL('./fixtures/g09-multi-script-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
  const result = await run(electronPath, [fixture], { ...process.env, HAIYUE_G09_HOST_FILE: html, HAIYUE_G09_PREVIEW_ROOT: path.join(appRoot, 'dist'), HAIYUE_G09_USER_DATA: path.join(output, 'user-data') });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[g09-multi-script-smoke\] scripts=2 stableOrder=true faultIsolated=true cleanup=0/);
});

function hostHtml(previewUrl) {
  const transform = (x) => ({ position: { x, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
  const scene = { documentId: 'document:g09', revision: 7, entities: [
    { id: 'entity:leader', name: 'Leader', kind: 'cube', parentId: null, order: 0, transform: transform(0), appearance: { material: 'basic', color: [1, 0, 0, 1] } },
    { id: 'entity:follower', name: 'Follower', kind: 'cube', parentId: null, order: 1, transform: transform(10), appearance: { material: 'basic', color: [0, 1, 0, 1] } },
  ] };
  const leaderText = `const transform = entity.getComponent('CartesianTransform3D');\ntransform?.setPosition(transform.position[0] + 1, transform.position[1], 0);`;
  const followerText = `const leader = api.read.find('Leader');\nconst leaderTransform = leader?.getComponent('CartesianTransform3D');\nconst transform = entity.getComponent('CartesianTransform3D');\ntransform?.setPosition((leaderTransform?.position[0] ?? 0) + 10, transform.position[1] + 1, 0);`;
  const plan = { id: 'preview-plan:g09', documentId: scene.documentId, documentRevision: scene.revision, selection: 'all-enabled', scriptSetDigest: 'sha256:' + 'b'.repeat(64), scripts: [
    { scriptId: 'script:leader', entityId: 'entity:leader', order: 0, textRevision: 1, digest: 'a'.repeat(64), capabilities: ['read', 'input', 'debug', 'scene'], diagnostics: [], emittedText: leaderText },
    { scriptId: 'script:follower', entityId: 'entity:follower', order: 1, textRevision: 1, digest: 'b'.repeat(64), capabilities: ['read'], diagnostics: [], emittedText: followerText },
  ], capabilities: ['read', 'scene', 'input', 'debug'], runtimeConfig: { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'haiyue-play' }, risk: 'trusted-project', diagnostics: [] };
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><script>
    const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.src = ${JSON.stringify(previewUrl)}; document.body.append(frame);
    let phase = 'starting', beforeY = 0, stableOrder = false, faultObserved = false;
    const fail = message => { document.body.dataset.g09Status = 'failed'; document.body.dataset.g09Error = message; };
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || !event.data || event.data.protocol !== 'haiyue-preview/1') return;
      if (event.data.type === 'ready') frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'start', scene: ${JSON.stringify(scene)}, plan: ${JSON.stringify(plan)}, assets: [] }, '*');
      else if (event.data.type === 'started') phase = 'running';
      else if (event.data.type === 'state' && phase === 'running') {
        const leader = event.data.scripts.find(script => script.scriptId === 'script:leader');
        const follower = event.data.scripts.find(script => script.scriptId === 'script:follower');
        stableOrder = Boolean(leader && follower && follower.position.x - leader.position.x === 10);
        if (!stableOrder) return fail('stable script order was not observed');
        beforeY = follower.position.y; phase = 'faulting';
        frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'hot-reload', scriptId: 'script:leader', emittedText: "throw new Error('leader-fault');" }, '*');
      } else if (event.data.type === 'runtime-error') {
        if (event.data.scriptId === 'script:leader' && event.data.message.includes('leader-fault')) { faultObserved = true; phase = 'faulted'; }
        else fail(event.data.code + ': ' + event.data.message);
      } else if (event.data.type === 'state' && phase === 'faulted') {
        const follower = event.data.scripts.find(script => script.scriptId === 'script:follower');
        if (follower?.position.y > beforeY) { phase = 'stopping'; frame.contentWindow.postMessage({ protocol: 'haiyue-preview/1', type: 'stop' }, '*'); }
      } else if (event.data.type === 'cleanup-complete' && phase === 'stopping') {
        document.body.dataset.g09Result = JSON.stringify({ scripts: 2, stableOrder, faultIsolated: faultObserved, cleanup: event.data.disposableCount });
        document.body.dataset.g09Status = 'passed';
      }
    });
    setTimeout(() => fail('host deadline exceeded'), 40000);
  </script></body></html>`;
}

function run(command, args, env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject); child.once('exit', code => resolve({ code, output })); }); }
