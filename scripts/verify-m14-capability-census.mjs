import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { root, localPath, readJson, digest, canonical, collectPackages, inputBinding, generateCensus, censusFile, reportFile, sourcesFile } from './m14-capability-census.mjs';

const mode = process.argv[2];
assert.ok(['--capture', '--check'].includes(mode) && process.argv.length === 3, 'Use npm run m14:capability:capture or npm run m14:capability:check');
function run(command, args, stream = false) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (stream) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; if (stream) process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('exit', exitCode => resolve({ exitCode, output, durationMs: Math.round(performance.now() - start) }));
  });
}

if (mode === '--capture') {
  assert.ok(process.env.npm_execpath, 'Capture must run via npm so the exact installed build command is used.');
  console.log('[m14-capability] Building current public workspace exports before collecting evidence.');
  const build = await run(process.execPath, [process.env.npm_execpath, 'run', 'build', '-w', '@haiyue/ai-studio'], true);
  assert.equal(build.exitCode, 0, 'Current workspace build failed; no evidence written.');
  const binding = await inputBinding(await collectPackages());
  const { checks } = await readJson(sourcesFile);
  const results = [];
  for (const check of checks) {
    // These integration fixtures launch compiler workers and use bounded
    // deadlines. Run files serially so unrelated suites cannot consume them.
    const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', ...check.files];
    const startedAt = new Date().toISOString();
    const result = await run(process.execPath, args);
    const count = key => Number(result.output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN);
    if (result.exitCode !== 0) process.stderr.write(result.output);
    assert.equal(result.exitCode, 0, `${check.id} failed; previous evidence preserved.`);
    for (const key of ['fail', 'skipped', 'cancelled']) assert.equal(count(key), 0, `${check.id} ${key}; no acceptance written.`);
    assert.ok(count('pass') > 0, `${check.id} did not execute tests.`);
    results.push({ id: check.id, kind: 'local-check', args, startedAt, durationMs: result.durationMs, exitCode: result.exitCode, passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled'), outputDigest: digest(result.output) });
    console.log(`[m14-capability] ${check.id}: ${count('pass')} passed, ${result.durationMs} ms`);
  }
  assert.equal((await inputBinding(await collectPackages())).digest, binding.digest, 'Inputs changed during capture; evidence not written.');
  const report = { schemaVersion: 1, inputDigest: binding.digest, environment: { node: process.version, platform: process.platform, arch: process.arch }, build: { command: 'npm run build -w @haiyue/ai-studio', exitCode: build.exitCode, durationMs: build.durationMs, outputDigest: digest(build.output) }, checks: results };
  await writeFile(localPath(reportFile), JSON.stringify(report, null, 2) + '\n');
  const census = await generateCensus(report);
  await writeFile(localPath(censusFile), JSON.stringify(census, null, 2) + '\n');
} else {
  const report = await readJson(reportFile);
  const actual = await readJson(censusFile);
  const expected = await generateCensus(report);
  assert.equal(canonical(actual), canonical(expected), 'Census differs from current package/registry/source/evidence. Recapture; never edit generated records.');
}
const census = await readJson(censusFile);
console.log(`[m14-capability] verified: packages=${census.packages.length}, capabilities=${census.records.length}, components=${census.registry.components.length}, tools=${census.registry.tools.length}, product-integrated=${census.records.filter(r => r.stage === 'product-integrated').length}`);
