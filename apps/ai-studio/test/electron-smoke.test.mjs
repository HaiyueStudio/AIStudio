import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('real Electron loads a sandboxed renderer through the typed preload and closes cleanly', { timeout: 100_000 }, async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'haiyue-electron-userdata-'));
  const pixelCandidate = path.join(userData, 'pixel-candidates', 'g05-cube-selected.png');
  const entry = new URL('../dist/main.js', import.meta.url);
  const env = smokeEnvironment(process.env);
  const result = await run(electronPath, [entry.pathname.replace(/^\/(.:\/)/, '$1')], {
    ...env,
    HAIYUE_ELECTRON_SMOKE: '1',
    HAIYUE_ELECTRON_USER_DATA: userData,
    HAIYUE_ELECTRON_PIXEL_CANDIDATE: pixelCandidate,
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[ai-studio-smoke\] renderer-ready webgpu-script-agent-ui agent-sync-push-single-flight resizable-split-layout structured-logs pixel-candidate reload-safe secure-preload-only/);
  const png = await readFile(pixelCandidate);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.byteLength > 10_000, `pixel candidate is unexpectedly small: ${png.byteLength}`);
});

function smokeEnvironment(source) {
  const env = { ...source };
  delete env.HAIYUE_STUDIO_DEEPSEEK_SECRET;
  delete env.DEEPSEEK_API_KEY;
  return env;
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
