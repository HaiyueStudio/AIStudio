import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('real WebGPU renders reconstructable G08 PBR, shadow, post-process and particle evidence', { timeout: 100_000 }, async () => {
  const root = path.resolve(new URL('../../../', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1'));
  const output = await mkdtemp(path.join(tmpdir(), 'haiyue-g08-render-'));
  const script = path.join(output, 'render.js'), html = path.join(output, 'index.html'), pixel = path.join(output, 'g08-effects.png'), receiptPath = path.join(output, 'result.json');
  await build({ entryPoints: [path.join(root, 'apps/ai-studio/test/fixtures/g08-render-browser.ts')], outfile: script, bundle: true, format: 'esm', platform: 'browser', target: 'chrome140', sourcemap: false, logLevel: 'silent' });
  await writeFile(html, '<!doctype html><html><head><meta charset="utf-8"><style>html,body,canvas{margin:0;width:100%;height:100%;display:block;background:#030509}</style></head><body><canvas id="canvas" width="800" height="600"></canvas><script type="module" src="./render.js"></script></body></html>');
  const fixture = new URL('./fixtures/g08-render-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
  const result = await run(electronPath, [fixture], { ...process.env, HAIYUE_G08_RENDER_FILE: html, HAIYUE_G08_RENDER_PIXEL: pixel, HAIYUE_G08_RENDER_RESULT: receiptPath, HAIYUE_G08_USER_DATA: path.join(output, 'user-data') });
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(result.code, 0, `${result.output}\n${receipt.message ?? ''}`);
  assert.equal(receipt.code, 0, receipt.message);
  assert.match(receipt.message, /^visual-oracle dark=\d+ bright=\d+ chromatic=\d+ range=[\d.]+\.\.[\d.]+ effects=2$/);
  const png = await readFile(pixel);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.byteLength > 5_000, `G08 visual evidence is unexpectedly small: ${png.byteLength}`);
});

function run(command, args, env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject); child.once('exit', code => resolve({ code, output })); }); }
