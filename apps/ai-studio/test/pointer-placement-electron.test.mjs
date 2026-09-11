import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

test('native Play clicks snap to rendered grid points across projection, camera movement and resize', { timeout: 150_000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'haiyue-pointer-placement-'));
  const env = { ...process.env, HAIYUE_POINTER_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [fileURLToPath(new URL('./fixtures/pointer-placement-main.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const deadline = setTimeout(() => child.kill('SIGKILL'), 140_000);
    child.stdout.on('data', chunk => { text += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { text += chunk; process.stderr.write(chunk); });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', code => { clearTimeout(deadline); resolve({ code, text }); });
  });
  assert.equal(result.code, 0, `${result.text}\nArtifacts: ${output}`);
  assert.match(result.text, /pointer-placement.*"clicks":40/);
});
