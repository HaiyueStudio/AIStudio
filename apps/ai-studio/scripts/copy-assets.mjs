import { copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
await Promise.all([
  copyFile(path.join(root, 'renderer', 'index.html'), path.join(root, 'dist', 'index.html')),
  copyFile(path.join(root, 'renderer', 'web.html'), path.join(root, 'dist', 'web.html')),
  copyFile(path.join(root, 'renderer', 'styles.css'), path.join(root, 'dist', 'styles.css')),
  copyFile(path.resolve(root, '..', '..', 'node_modules', '@haiyue', 'ui', 'themes', 'haiyue-light.css'), path.join(root, 'dist', 'haiyue-light.css')),
  copyFile(path.resolve(root, '..', '..', 'node_modules', '@haiyue', 'ui', 'themes', 'haiyue-dark.css'), path.join(root, 'dist', 'haiyue-dark.css')),
  copyFile(path.join(root, 'renderer', 'preview.html'), path.join(root, 'dist', 'preview.html')),
  copyFile(path.join(root, 'renderer', 'preview.css'), path.join(root, 'dist', 'preview.css')),
  copyFile(path.join(root, 'renderer', 'preload.cjs'), path.join(root, 'dist', 'preload.cjs')),
  copyFile(path.join(root, 'renderer', 'startup-guard.js'), path.join(root, 'dist', 'startup-guard.js')),
]);
