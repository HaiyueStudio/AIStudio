import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import electron from 'electron';

test('real Electron notification settings, keyboard focus and exact card/task navigation', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-notification-ui-'));
  await build({ entryPoints: [fileURLToPath(new URL('./fixtures/notification-ui-browser.mjs', import.meta.url))], outfile: path.join(directory, 'app.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome132' });
  const css = await readFile(new URL('../renderer/styles.css', import.meta.url), 'utf8');
  await writeFile(path.join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}body{display:block;padding:20px}#settings{max-width:400px}#chat{height:600px}</style></head><body><main id="settings" class="settings-form"></main><section id="chat" class="chat-content"></section><script type="module" src="app.js"></script></body></html>`);
  const env = { ...process.env, HAIYUE_NOTIFICATION_TEST_ROOT: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fileURLToPath(new URL('./fixtures/notification-ui-main.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    const timer = setTimeout(() => child.kill(), 35_000);
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /notification-ui.*passed/);
  assert.ok((await readFile(path.join(directory, 'notification-settings.png'))).byteLength > 5000);
  console.log(`[notification-ui] evidence: ${directory}`);
});
