import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('real Electron loads a sandboxed renderer through the typed preload and closes cleanly', { timeout: 45_000 }, async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'haiyue-electron-userdata-'));
  const entry = new URL('../dist/main.js', import.meta.url);
  const result = await run(electronPath, [entry.pathname.replace(/^\/(.:\/)/, '$1')], {
    ...process.env,
    HAIYUE_ELECTRON_SMOKE: '1',
    HAIYUE_ELECTRON_USER_DATA: userData,
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[ai-studio-smoke\] renderer-ready reload-safe secure-preload-only/);
});

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
