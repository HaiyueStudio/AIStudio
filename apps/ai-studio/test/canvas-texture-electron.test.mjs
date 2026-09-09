import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

test('real isolated Canvas renders and exports PNG without leaking windows', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-canvas-'));
  const output = fileURLToPath(new URL('./m14-integration/test-output/canvas-texture/', import.meta.url)); await mkdir(output, { recursive: true });
  const png = path.join(output, 'canvas-texture.png');
  const env = { ...process.env, HAIYUE_CANVAS_USER_DATA: directory, HAIYUE_CANVAS_PNG: png }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fileURLToPath(new URL('./fixtures/canvas-texture-main.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const deadline = setTimeout(() => child.kill(), 40000);
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => { clearTimeout(deadline); reject(error); }); child.on('exit', code => { clearTimeout(deadline); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /Canvas PNG pixels/);
  assert.ok((await readFile(png)).byteLength > 1000);
});
