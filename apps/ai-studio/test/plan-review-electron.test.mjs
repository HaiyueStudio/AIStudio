import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import electron from 'electron';

test('pending plan actions remain visible and clickable with graph, task and cost panels at narrow window sizes', { timeout: 55_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-plan-review-'));
  await build({ entryPoints: [fileURLToPath(new URL('./fixtures/plan-review-browser.mjs', import.meta.url))], outfile: path.join(directory, 'app.js'), bundle: true, platform: 'browser', format: 'esm', target: 'chrome132' });
  const css = await readFile(new URL('../renderer/styles.css', import.meta.url), 'utf8');
  await writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css}html,body{height:100%;display:block}#chat{height:100vh;width:100%;box-sizing:border-box}</style></head><body><main id="chat" class="chat-content"></main><script type="module" src="app.js"></script></body></html>`);
  const env = { ...process.env, HAIYUE_PLAN_REVIEW_ROOT: directory, HAIYUE_STUDIO_DISABLE_NOTIFICATIONS: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fileURLToPath(new URL('./fixtures/plan-review-main.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    const timer = setTimeout(() => child.kill(), 45_000);
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /plan-review.*passed/u);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).approveOnce, true);
  console.log(`[plan-review] evidence: ${directory}`);
});
