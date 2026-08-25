import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const entryPoints = ['renderer.js', 'web.js', 'preview-runtime.js']
  .map((entry) => path.join(root, 'dist', entry));

await build({
  entryPoints,
  outdir: path.join(root, 'dist', '.verify'),
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'reject-bare-browser-imports',
    setup(context) {
      context.onResolve({ filter: /^[^./]/ }, (args) => args.kind === 'entry-point' ? undefined : ({
        errors: [{ text: `${path.basename(args.importer)} contains an unbundled browser import: ${args.path}` }],
      }));
    },
  }],
});
