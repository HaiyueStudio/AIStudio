import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const entryPoints = ['renderer.js', 'web.js', 'preview-runtime.js'];
const importPattern = /\b(?:from\s*|import\s*)["']([^"']+)["']/gu;

for (const entry of entryPoints) {
  const entryPath = path.join(root, 'dist', entry);
  const source = await readFile(entryPath, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) throw new Error(`${entry} contains an unbundled browser import: ${specifier}`);
    await access(path.resolve(path.dirname(entryPath), specifier));
  }
}
