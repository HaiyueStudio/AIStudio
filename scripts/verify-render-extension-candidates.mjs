import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'config', 'render-extension-candidates.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));

assert.equal(config.schemaVersion, 1);
assert.match(config.sourceRevision, /^[0-9a-f]{40}$/);
for (const candidate of config.candidates) {
  const packageParts = candidate.package.split('/');
  const installedRoot = path.join(root, 'node_modules', ...packageParts);
  const installed = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  const lockEntry = lock.packages[`node_modules/${candidate.package}`];
  const tarball = await readFile(path.join(root, candidate.tarball));
  assert.equal(manifest.dependencies[candidate.package], `file:${candidate.tarball.replaceAll('\\', '/')}`);
  assert.equal(lockEntry.version, candidate.version);
  assert.equal(lockEntry.integrity, candidate.integrity);
  assert.equal(installed.name, candidate.package);
  assert.equal(installed.version, candidate.version);
  assert.equal(createHash('sha256').update(tarball).digest('hex'), candidate.sha256);
  for (const exportName of candidate.requiredExports) assert.ok(installed.exports[exportName], `${candidate.package} is missing export ${exportName}.`);
  if (candidate.requiredDeclarationMarkers) {
    assert.ok(Array.isArray(candidate.requiredDeclarationFiles) && candidate.requiredDeclarationFiles.length > 0, `${candidate.package} must declare the files that own its required API markers.`);
    const declarations = (await Promise.all(candidate.requiredDeclarationFiles.map((relativePath) =>
      readFile(path.join(installedRoot, ...relativePath.split('/')), 'utf8')))).join('\n');
    for (const marker of candidate.requiredDeclarationMarkers) assert.ok(declarations.includes(marker), `${candidate.package} is missing declaration marker ${marker}.`);
  }
  console.log(`[render-candidate] ${candidate.package}@${candidate.version} sha256=${candidate.sha256.slice(0, 16)} source=${config.sourceRevision.slice(0, 12)}`);
}
