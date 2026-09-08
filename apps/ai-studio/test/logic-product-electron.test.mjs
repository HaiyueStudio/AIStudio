import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

test('real product selects structure, explains, locates the exact source, observes Play and rereads project history', { timeout: 310_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-m14-logic-product-'));
  const env = { ...process.env, HAIYUE_ELECTRON_SMOKE: '1', HAIYUE_ELECTRON_USER_DATA: directory, HAIYUE_ELECTRON_BEHAVIOR_EVIDENCE: directory };
  delete env.ELECTRON_RUN_AS_NODE; delete env.HAIYUE_STUDIO_DEEPSEEK_SECRET; delete env.DEEPSEEK_API_KEY;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fileURLToPath(new URL('../dist/main.js', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const deadline = setTimeout(() => { child.kill(); reject(Error('Product flow timed out: ' + output)); }, 300_000);
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(deadline); reject(error); }); child.once('exit', code => { clearTimeout(deadline); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output + '\nArtifacts: ' + directory);
  assert.match(result.output, /renderer-ready webgpu-script-agent-ui/);
  for (const stage of ['structure', 'source', 'component', 'adapter', 'trace']) {
    assert.equal(result.output.split(`[behavior-smoke-evidence] ${stage}`).length - 1, 2, 'flow repeated after real renderer reload');
    const png = await readFile(path.join(directory, `product-${stage}.png`));
    assert.ok(png.length > 10_000); assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  }
  console.log('M14 logic product evidence: ' + directory);
});
