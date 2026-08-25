import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('browser shell boots without preload, creates a WebGPU cube and exposes no Node globals', { timeout: 100_000 }, async () => {
  const port = await availablePort();
  const server = spawn(process.execPath, ['apps/ai-studio/scripts/serve-web.mjs', '--port', String(port)], { cwd: new URL('../../../', import.meta.url), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForOutput(server, '[ai-studio-web]');
    const userData = await mkdtemp(path.join(tmpdir(), 'haiyue-web-smoke-'));
    const pixel = path.join(userData, 'web-cube.png');
    const fixture = new URL('./fixtures/web-smoke-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
    const result = await run(electronPath, [fixture], { ...smokeEnvironment(process.env), HAIYUE_WEB_SMOKE_URL: `http://127.0.0.1:${port}/web.html`, HAIYUE_WEB_SMOKE_PIXEL: pixel, HAIYUE_WEB_SMOKE_USER_DATA: userData });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /\[ai-studio-web-smoke\] renderer-ready browser-host webgpu cube-created script-approved preview-stopped agent-desktop-only/);
    const png = await readFile(pixel);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(png.byteLength > 10_000, `web pixel candidate is unexpectedly small: ${png.byteLength}`);
  } finally {
    if (server.exitCode === null) server.kill();
  }
});

function smokeEnvironment(source) { const env = { ...source }; delete env.HAIYUE_STUDIO_DEEPSEEK_SECRET; delete env.DEEPSEEK_API_KEY; return env; }

function availablePort() { return new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; server.close((error) => error ? reject(error) : resolve(port)); }); }); }
function waitForOutput(child, marker) { return new Promise((resolve, reject) => { let output = ''; const receive = (chunk) => { output += chunk; if (output.includes(marker)) resolve(); }; child.stdout.on('data', receive); child.stderr.on('data', receive); child.once('error', reject); child.once('exit', (code) => reject(new Error(`web server exited ${code}: ${output}`))); }); }
function run(command, args, env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; }); child.once('error', reject); child.once('exit', (code) => resolve({ code, output })); }); }
