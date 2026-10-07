// Isolated source/build/process qualification. Production manifests and lock are never edited.
import { mkdtemp, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
const root = fileURLToPath(new URL('..', import.meta.url));
const candidate = process.argv[2] ?? '0.2.1-alpha.1';
if (candidate !== '0.2.1-alpha.1') throw new Error('Candidate dependency closure must be reviewed before testing another alpha.');
const directory = await mkdtemp(join(tmpdir(), 'aistudio-harness-alpha-'));
const digest = data => createHash('sha256').update(data).digest('hex');
const tracked = ['package.json', 'package-lock.json', 'packages/harness-bridge/package.json'];
const before = await Promise.all(tracked.map(async name => [name, digest(await readFile(join(root, name)))]));
const excluded = new Set(['node_modules', 'dist', '.git', 'test-output']);
for (const name of ['packages', 'apps', 'scripts', 'config', 'evals', 'vendor']) {
  await cp(join(root, name), join(directory, name), { recursive: true, filter: source => !excluded.has(basename(source)) });
}
await cp(join(root, 'docs'), join(directory, 'docs'), { recursive: true, filter: source => basename(source) !== 'evidence' });
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) await cp(join(root, name), join(directory, name));
const manifests = ['package.json'];
const sourceHash = createHash('sha256');
async function hashSource(relative = '') {
  for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) await hashSource(name);
    else if (entry.isFile()) { sourceHash.update(name); sourceHash.update('\0'); sourceHash.update(await readFile(join(directory, name))); }
  }
}
await hashSource();
const sourceSha256 = sourceHash.digest('hex');
for (const group of ['packages', 'apps']) for (const entry of await readdir(join(directory, group), { withFileTypes: true })) if (entry.isDirectory()) manifests.push(`${group}/${entry.name}/package.json`);
for (const name of manifests) {
  const path = join(directory, name), manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const section of ['dependencies', 'devDependencies', 'overrides']) for (const key of Object.keys(manifest[section] ?? {})) {
    if (key.startsWith('@deepseek-ai/dsh-')) manifest[section][key] = candidate;
    if (key === '@deepseek-ai/cordis') manifest[section][key] = '4.0.5-alpha.1';
  }
  if (name === 'package.json') {
    // Alpha retired the invariant package; never force the RC companion into its closure.
    delete manifest.overrides['@deepseek-ai/dsh-invariants'];
    Object.assign(manifest.overrides, { '@deepseek-ai/cosmokit': '1.8.6-alpha.1', '@deepseek-ai/schemastery': '3.18.5-alpha.1', '@deepseek-ai/cordis-plugin-loader': '1.0.6-alpha.1', '@deepseek-ai/cordis-plugin-include': '1.0.10-alpha.1' });
  }
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}
const stages = [];
async function run(name, command, args, timeoutMs = 600_000) {
  console.log(`alpha: ${name}`);
  const result = await new Promise(resolve => {
    const sink = createWriteStream(join(directory, `${name}.log`));
    const child = spawn(command, args, { cwd: directory, env: { ...process.env, TMPDIR: '/private/tmp' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '', timedOut = false, settled = false;
    let logFailed = false;
    sink.on('error', () => { logFailed = true; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); sink.end(() => resolve({ name, code: logFailed ? -1 : code, timedOut, output })); };
    const collect = d => { output += d; sink.write(d); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => { collect(String(error)); finish(-1); }); child.on('close', code => finish(code ?? -1));
  });
  const count = key => Number(result.output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN);
  const tests = args.includes('--test') ? { passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') } : null;
  const passed = result.code === 0 && !result.timedOut && (!tests || tests.passed > 0 && tests.failed === 0 && tests.skipped === 0 && tests.cancelled === 0);
  stages.push({ name, exitCode: result.code, timedOut: result.timedOut, passed, tests, logSha256: digest(result.output) });
  console.log(`alpha: ${name} exit ${result.code}`);
  return passed;
}
console.log(`Isolated candidate ${candidate}: ${directory}`);
let failure = null;
try {
  const installed = await run('install', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=30000']);
  if (installed) {
    const candidateLock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    for (const [location, entry] of Object.entries(candidateLock.packages)) {
      const match = location.match(/(?:^|\/)node_modules\/(@deepseek-ai\/(?:dsh-[^/]+|cordis))$/);
      if (!match) continue;
      const name = match[1], expected = name === '@deepseek-ai/cordis' ? '4.0.5-alpha.1' : candidate;
      const manifest = JSON.parse(await readFile(join(directory, location, 'package.json'), 'utf8'));
      if (location !== `node_modules/${name}` || entry.version !== expected || manifest.version !== expected || manifest.license !== 'MIT' || !entry.integrity) throw new Error(`Candidate closure mismatch: ${name}`);
    }
    // Electron is unchanged. Reuse its reviewed local executable without running a download script.
    // macOS Framework/Helper resources rely on relative bundle symlinks.
    await cp(join(root, 'node_modules/electron/dist'), join(directory, 'node_modules/electron/dist'), { recursive: true, verbatimSymlinks: true });
    await cp(join(root, 'node_modules/electron/path.txt'), join(directory, 'node_modules/electron/path.txt'));
    if (await run('app-build', 'npm', ['run', 'build', '-w', '@haiyue/ai-studio'])) {
      await run('source-typecheck', 'npm', ['run', 'typecheck', '--workspaces', '--if-present', '--ignore-scripts']);
      const files = (await readdir(join(directory, 'packages/harness-bridge/test'))).filter(name => name.endsWith('.test.mjs')).map(name => `packages/harness-bridge/test/${name}`);
      await run('bridge', process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files]);
      await run('restore', process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', 'apps/ai-studio/test/backend-session-process-reload.test.mjs', 'apps/ai-studio/test/g03-context-compaction-reload.test.mjs', 'packages/agent-orchestration/test/continuation-record.test.mjs']);
      await run('process-matrix', process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', 'packages/harness-bridge/test/extended-browser.smoke.mjs', 'packages/harness-bridge/test/devtools-browser.smoke.mjs', 'packages/harness-bridge/test/extended-node.smoke.mjs', 'apps/ai-studio/test/p1-tool-settings-electron.test.mjs']);
    }
  }
} catch (error) { failure = String(error); }
const productionUnchanged = (await Promise.all(before.map(async ([name, hash]) => digest(await readFile(join(root, name))) === hash))).every(Boolean);
const lock = await readFile(join(directory, 'package-lock.json'));
const packages = Object.entries(JSON.parse(lock).packages).filter(([name]) => name.includes('node_modules/@deepseek-ai/')).map(([location, value]) => ({ location, version: value.version, integrity: value.integrity }));
const required = ['install', 'app-build', 'source-typecheck', 'bridge', 'restore', 'process-matrix'];
const report = { schemaVersion: 2, candidate, directory, sourceSha256, stages, failure, productionUnchanged, candidateLockSha256: digest(lock), packages,
  scope: 'isolated source, full app build, local bridge, durable restore and Electron/browser/Node process matrix; no paid provider or production upgrade',
  passed: !failure && productionUnchanged && required.every(name => stages.some(stage => stage.name === name && stage.passed)) };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ directory, stages, failure, productionUnchanged, passed: report.passed }, null, 2));
process.exitCode = report.passed ? 0 : 1;
