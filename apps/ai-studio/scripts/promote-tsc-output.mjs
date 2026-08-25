import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const stagingDirectory = path.join(root, 'dist', '.tsc');
const outputDirectory = path.join(root, 'dist');

// These files execute in a browser. Publishing TypeScript's bare package
// imports here would break a running Studio before esbuild can replace them.
const browserEntries = new Set([
  'preview-runtime.js',
  'preview-runtime.js.map',
  'renderer.js',
  'renderer.js.map',
  'web-entry.js',
  'web-entry.js.map',
]);

if (process.argv.includes('--clean')) {
  await rm(stagingDirectory, { recursive: true, force: true });
} else {
  await promote(stagingDirectory);
  await rm(stagingDirectory, { recursive: true, force: true });
}

async function promote(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name);
    const relative = path.relative(stagingDirectory, source);
    if (entry.isDirectory()) {
      await promote(source);
      continue;
    }
    if (!entry.isFile() || browserEntries.has(relative.replaceAll('\\', '/'))) continue;
    const destination = path.join(outputDirectory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { force: true });
  }
}
