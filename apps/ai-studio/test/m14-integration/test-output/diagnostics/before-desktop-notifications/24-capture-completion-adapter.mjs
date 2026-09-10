// Evidence tooling only: output is deliberately excluded from the product input binding.
// Runs the existing real-device fixture; never contacts an Agent provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { collectPackages, inputBinding, localPath, reference, scopeFile, readJson } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/m14-integration/test-output';
const run = `${base}/completion-audit/${new Date().toISOString().replace(/[:.]/g, '-')}`;
const before = await inputBinding(await collectPackages());
const scope = await readJson(scopeFile);
assert.deepEqual(scope.g08.selected.map(s => [s.capabilityId, s.adapterId]), [['play.capture', 'adapter.ui.hud']], 'Review a changed G08 scope before recapturing.');
await mkdir(localPath(run), { recursive: true });
const temporary = localPath('tmp/g09-completion-audit');
await mkdir(temporary, { recursive: true });
const env = { ...process.env, TEMP: temporary, TMP: temporary, HAIYUE_M14_G09_OUTPUT: localPath(run) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY', 'HAIYUE_STUDIO_DEEPSEEK_SECRET', 'HAIYUE_M14_ALLOW_REAL']) delete env[key];
const args = ['--test', '--test-reporter=tap', 'apps/ai-studio/test/m14-g08-adapter-review/adapter-device.test.mjs'];
const startedAt = new Date().toISOString();
const started = performance.now();
const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: localPath('package.json').replace(/[\\/]package\.json$/, ''), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.once('error', reject);
  child.once('close', code => resolve({ exitCode: code, output }));
});
await writeFile(localPath(`${run}/adapter.tap`), result.output);
assert.equal(result.exitCode, 0, `Real-device check failed; retained ${run}/adapter.tap`);
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled'].map(key => [key, Number(result.output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1])]));
assert.deepEqual(counts, { tests: 2, pass: 2, fail: 0, skipped: 0, cancelled: 0 });
assert.equal((await inputBinding(await collectPackages())).digest, before.digest, 'Product inputs changed during capture.');
const artifacts = await readdir(localPath(`${run}/adapter-review`), { withFileTypes: true });
assert.ok(artifacts.every(file => file.isFile()), 'Unexpected device artifact directory.');
const evidence = await Promise.all(artifacts.map(file => reference(`${run}/adapter-review/${file.name}`, 'adapter-acceptance', 'play.capture / adapter.ui.hud')));
const check = { id: 'g09-current-g08-device', kind: 'adapter-acceptance', capabilityIds: ['play.capture'], adapterIds: ['adapter.ui.hud'], inputDigest: before.digest, startedAt, durationMs: Math.round(performance.now() - started), args, exitCode: 0, passed: 2, failed: 0, skipped: 0, cancelled: 0, log: await reference(`${run}/adapter.tap`, 'adapter-acceptance', 'two real Electron/WebGPU fixtures'), evidence };
await writeFile(localPath(`${run}/adapter-check.json`), JSON.stringify(check, null, 2) + '\n');
await writeFile(localPath(`${base}/completion-adapter-latest.json`), JSON.stringify({ inputBinding: before, check: await reference(`${run}/adapter-check.json`, 'adapter-acceptance', check.id), runner: await reference(`${base}/capture-completion-adapter.mjs`) }, null, 2) + '\n');
console.log(JSON.stringify({ run, passed: check.passed, evidenceFiles: evidence.length, inputDigest: before.digest }));
