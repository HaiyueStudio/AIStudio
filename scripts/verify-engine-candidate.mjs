import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidate = JSON.parse(await readFile(path.join(root, 'config', 'engine-candidate.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const installedRoot = path.join(root, 'node_modules', '@haiyue', 'engine');
const installed = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
const tarball = await readFile(path.join(root, candidate.tarball));

assert.equal(candidate.schemaVersion, 1);
assert.match(candidate.sourceRevision, /^[0-9a-f]{40}$/);
assert.equal(manifest.dependencies[candidate.package], `file:${candidate.tarball.replaceAll('\\', '/')}`);
assert.equal(lock.packages['node_modules/@haiyue/engine'].version, candidate.version);
assert.equal(lock.packages['node_modules/@haiyue/engine'].integrity, candidate.integrity);
assert.equal(installed.name, candidate.package);
assert.equal(installed.version, candidate.version);
assert.equal(createHash('sha256').update(tarball).digest('hex'), candidate.sha256);
for (const exportName of candidate.requiredExports) assert.ok(installed.exports[exportName], `Engine candidate is missing export ${exportName}.`);
const declarations = [
  await readFile(path.join(installedRoot, 'dist', 'systems', 'InteractionSystem.d.ts'), 'utf8'),
  await readFile(path.join(installedRoot, 'dist', 'script', 'ScriptRuntimeContract.d.ts'), 'utf8'),
].join('\n');
for (const marker of candidate.requiredDeclarationMarkers) assert.ok(declarations.includes(marker), `Engine candidate is missing declaration marker ${marker}.`);
console.log(`[engine-candidate] ${candidate.package}@${candidate.version} sha256=${candidate.sha256.slice(0, 16)} source=${candidate.sourceRevision.slice(0, 12)}`);
