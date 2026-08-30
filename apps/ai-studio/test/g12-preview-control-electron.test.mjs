import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('G12 runner controls the real sandboxed iframe through the GamePreviewControl contract', { timeout: 100_000 }, async () => {
  const appRoot = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1'));
  const fixture = new URL('./fixtures/g12-preview-control-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1');
  const userData = await mkdtemp(path.join(tmpdir(), 'haiyue-g12-preview-control-'));
  const result = await run(electronPath, [fixture], { ...process.env, HAIYUE_G12_PREVIEW_ROOT: path.join(appRoot, 'dist'), HAIYUE_G12_USER_DATA: userData });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[g12-preview-control\].*"started":"playing".*"advanced":true.*"x":1.*"gameplay":1.*"semanticDrivers":\["scripted-aim-and-fire"\].*"replayPngBytes":[1-9][0-9]*.*"sameTick":true.*"cleanup":0.*"stopped":"stopped"/u);
});

function run(command, args, env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject); child.once('exit', code => resolve({ code, output })); }); }
