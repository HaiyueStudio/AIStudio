import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const chunkDirectory = path.join(root, 'dist', 'chunks');
const result = await build({
  entryPoints: {
    renderer: path.join(root, 'src', 'renderer.ts'),
    web: path.join(root, 'src', 'web-entry.ts'),
    'preview-runtime': path.join(root, 'src', 'preview-runtime.ts'),
  },
  outdir: path.join(root, 'dist'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: 'chrome142',
  minify: true,
  sourcemap: true,
  metafile: true,
  legalComments: 'none',
  logLevel: 'warning',
});

// Electron keeps loaded ESM chunks open on Windows. Removing the whole chunk
// directory before building can therefore fail with EPERM after tsc has already
// overwritten renderer.js with an unbundled intermediate file. Build first and
// only then prune stale, unlocked chunks so the runnable entry point is never
// left broken by best-effort cleanup.
const retainedOutputs = new Set(Object.keys(result.metafile.outputs).map((output) => path.resolve(output)));
for (const entry of await readdir(chunkDirectory, { withFileTypes: true }).catch(() => [])) {
  if (!entry.isFile()) continue;
  const candidate = path.join(chunkDirectory, entry.name);
  if (retainedOutputs.has(candidate)) continue;
  await rm(candidate, { force: true }).catch((cause) => {
    if (cause?.code !== 'EPERM' && cause?.code !== 'EBUSY') throw cause;
  });
}
