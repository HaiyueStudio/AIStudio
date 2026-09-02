import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('G08 declarative gameplay closes input, state, HUD, listener and current-revision screenshot in the sandboxed Play iframe', { timeout: 100_000 }, async () => {
  const appRoot = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1'));
  const fixture = new URL('./g08-declarative-play-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1');
  const userData = await mkdtemp(path.join(tmpdir(), 'haiyue-g08-declarative-play-'));
  const result = await run(electronPath, [fixture], { ...process.env, HAIYUE_G08_PREVIEW_ROOT: path.join(appRoot, 'dist'), HAIYUE_G08_USER_DATA: userData });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[g08-declarative-play\].*"revision":17.*"baselineScore":2.*"baselineHud":"Score 2".*"score":12.*"firedRules":\["hard-drop"\].*"emitted":true.*"listenerGain":0\.75.*"hud":"Score 12".*"buttonKind":"button".*"pngBytes":[1-9][0-9]*.*"sameTick":true.*"cleanup":0.*"stopped":"stopped".*"invalidStartRejected":true.*"invalidStartLatencyMs":[0-9]+/u);
});

function run(command, args, env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject); child.once('exit', code => resolve({ code, output })); }); }
