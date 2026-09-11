import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const sourceExecutable = require('electron');
let executable = sourceExecutable;
if (process.argv.slice(2).some(arg => arg !== '--prepare')) throw new Error('Use start-desktop.mjs [--prepare].');

if (process.platform === 'darwin') {
  // UNUserNotificationCenter rejects an unsigned Electron development binary.
  // Keep node_modules untouched; use a stable, locally signed development identity.
  const cache = path.join(repository, '.cache', 'desktop');
  const bundle = path.join(cache, 'HaiYue AIStudio.app');
  const identity = 'studio.haiyue.ai.development';
  const version = require('electron/package.json').version;
  const marker = path.join(cache, 'runtime.json');
  const expected = JSON.stringify({ version, sourceExecutable, identity, format: 1 });
  let current = false;
  try {
    current = await readFile(marker, 'utf8') === expected;
    if (current) execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
  } catch { current = false; }
  if (!current) {
    await mkdir(cache, { recursive: true });
    await rm(bundle, { recursive: true, force: true });
    await cp(path.resolve(sourceExecutable, '../../..'), bundle, { recursive: true, force: true, verbatimSymlinks: true });
    const plist = path.join(bundle, 'Contents', 'Info.plist');
    for (const [key, value] of Object.entries({ CFBundleIdentifier: identity, CFBundleName: 'HaiYue AIStudio', CFBundleDisplayName: 'HaiYue AIStudio' })) {
      execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
    }
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', identity, bundle], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    await writeFile(marker, expected);
  }
  executable = path.join(bundle, 'Contents', 'MacOS', path.basename(sourceExecutable));
  console.log('[desktop] Using locally signed HaiYue AIStudio development app.');
}

if (!process.argv.includes('--prepare')) {
  const entry = path.join(appRoot, 'dist', 'main.js');
  if (!existsSync(entry)) throw new Error('Build the app first: npm run build -w @haiyue/ai-studio');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [entry], { cwd: appRoot, env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? 1;
  });
}
