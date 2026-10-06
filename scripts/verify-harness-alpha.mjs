// Isolated compatibility probe. Never installs into or modifies the production closure.
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('..', import.meta.url));
const candidate = process.argv[2] ?? '0.2.1-alpha.1';
if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(candidate)) throw new Error('Supply an exact alpha version.');
const directory = await mkdtemp(join(tmpdir(), 'aistudio-harness-alpha-'));
const before = await readFile(join(root, 'package-lock.json'));
const digest = data => createHash('sha256').update(data).digest('hex');
for (const name of ['studio-contracts', 'studio-kernel', 'harness-bridge']) {
  const source = join(root, 'packages', name), dest = join(directory, 'packages', name);
  await mkdir(dest, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  // Copy the already reviewed Editor packages below; never resolve new Editor versions.
  delete manifest.peerDependencies; delete manifest.devDependencies; delete manifest.scripts;
  for (const key of Object.keys(manifest.dependencies ?? {})) if (key.startsWith('@deepseek-ai/dsh-')) manifest.dependencies[key] = candidate;
  if (manifest.dependencies?.['@deepseek-ai/cordis']) manifest.dependencies['@deepseek-ai/cordis'] = '4.0.5-alpha.1';
  await writeFile(join(dest, 'package.json'), JSON.stringify(manifest, null, 2));
  await cp(join(source, 'dist'), join(dest, 'dist'), { recursive: true });
  if (name === 'harness-bridge' || name === 'studio-contracts') await cp(join(source, 'test'), join(dest, 'test'), { recursive: true });
}
await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', workspaces: ['packages/*'], overrides: { '@deepseek-ai/cordis': '4.0.5-alpha.1', '@deepseek-ai/cordis-plugin-loader': '1.0.6-alpha.1', '@deepseek-ai/cordis-plugin-include': '1.0.10-alpha.1' } }, null, 2));
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  child.on('error', reject); child.on('close', code => resolve({ code, output }));
});
console.log(`Isolated candidate ${candidate}: ${directory}`);
const install = await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
await writeFile(join(directory, 'install.log'), install.output);
if (install.code === 0) for (const name of ['editor-platform', 'editor-plugin-sdk']) await cp(join(root, 'node_modules/@haiyue', name), join(directory, 'node_modules/@haiyue', name), { recursive: true });
const files = ['bridge', 'harness-upgrade', 'session-v4', 'official-tools', 'request-context', 'read-concurrency', 'web-read-cache', 'extended-web'];
const tests = install.code === 0 ? await run(process.execPath, ['--test', ...files.map(name => `packages/harness-bridge/test/${name}.test.mjs`)]) : null;
if (tests) await writeFile(join(directory, 'tests.log'), tests.output);
const unchanged = digest(before) === digest(await readFile(join(root, 'package-lock.json')));
const report = { candidate, directory, installExitCode: install.code, testExitCode: tests?.code ?? null, productionLockUnchanged: unchanged, scope: 'isolated compiled bridge compatibility; no paid provider, GUI or production upgrade', passed: install.code === 0 && tests?.code === 0 && unchanged };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
