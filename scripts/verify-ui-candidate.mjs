import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const candidate = await json('config/upstream/ui-candidate.json');
const manifest = await json('package.json');
const lock = await json('package-lock.json');
const installed = await json(`node_modules/${candidate.package}/package.json`);
assert.equal(manifest.dependencies[candidate.package], `file:${candidate.tarball}`);
const bytes = await readFile(path.join(root, candidate.tarball));
assert.equal(createHash('sha256').update(bytes).digest('hex'), candidate.sha256);
assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, candidate.integrity);
assert.equal(installed.version, candidate.version);
assert.equal(installed.name, candidate.package);
assert.equal(installed.license, 'MIT');
assert.equal(lock.packages[`node_modules/${candidate.package}`].version, candidate.version);
assert.equal(lock.packages[`node_modules/${candidate.package}`].integrity, candidate.integrity);
assert.equal(Object.keys(lock.packages).filter(key => key.endsWith(`node_modules/${candidate.package}`)).length, 1,
  'UI must have one runtime instance');
for (const entry of candidate.requiredExports) {
  assert.ok(installed.exports[entry], `missing public UI export ${entry}`);
  const resolved = import.meta.resolve(`${candidate.package}/${entry.slice(2)}`);
  assert.ok((await readFile(fileURLToPath(resolved))).length > 0);
}
console.log(`[ui-candidate] ${candidate.package}@${candidate.version}; integrity, singleton and ${candidate.requiredExports.length} consumer exports passed`);
