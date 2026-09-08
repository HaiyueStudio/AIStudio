import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';

test('G06 isolated resource module uses real service, tools and History in sandboxed Electron with bounded accessible UI', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-m14-resources-'));
  await build({ entryPoints: [fileURLToPath(new URL('./browser.mjs', import.meta.url))], outfile: path.join(directory, 'panel.js'), bundle: true, platform: 'browser', format: 'esm' });
  await copyFile(new URL('../../../../packages/studio-shell/src/panels/resources/resources.css', import.meta.url), path.join(directory, 'resources.css'));
  await writeFile(path.join(directory, 'host.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; object-src \'none\'"><link rel="stylesheet" href="resources.css"></head><body><main id="host"></main><script type="module" src="panel.js"></script></body></html>');
  const result = await new Promise((resolve, reject) => {
    const env = { ...process.env, HAIYUE_RESOURCE_TEST_ROOT: directory }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [fileURLToPath(new URL('./main.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const deadline = setTimeout(() => { child.kill(); reject(Error(`Resource test deadline. ${output}\n${directory}`)); }, 105000);
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    child.once('error', error => { clearTimeout(deadline); reject(error); }); child.once('exit', code => { clearTimeout(deadline); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output + '\nEvidence: ' + directory);
  const report = JSON.parse(await readFile(path.join(directory, 'verification.json'), 'utf8'));
  assert.equal(report.productIntegrated, false); assert.deepEqual(report.entityCounts, [0, 1, 100, 1000]); assert.equal(report.scripts, 200);
  console.log('G06 resource module evidence: ' + directory);
});
