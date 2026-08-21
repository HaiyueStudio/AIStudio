import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await rm(path.join(root, 'dist', 'chunks'), { recursive: true, force: true });
await build({
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
  legalComments: 'none',
  logLevel: 'warning',
});
