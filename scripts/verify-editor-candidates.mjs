import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requirements = JSON.parse(await readFile(path.join(root, 'config', 'upstream', 'editor-candidates.json'), 'utf8'));
const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const milestoneArgument = process.argv.indexOf('--milestone-file');
const milestonePath = milestoneArgument >= 0
  ? process.argv[milestoneArgument + 1]
  : process.argv.slice(2).find((argument) => path.isAbsolute(argument));
assert.ok(milestonePath && path.isAbsolute(milestonePath), 'pass an absolute path to M03 milestone.json');
const milestone = JSON.parse(await readFile(milestonePath, 'utf8'));
assert.equal(milestone.id, requirements.milestone, `expected ${requirements.milestone} milestone evidence`);
assert.equal(milestone.status, requirements.requiredMilestoneStatus);
for (const goal of milestone.goals) {
  if (goal.status === 'cancelled') continue;
  assert.equal(goal.status, 'complete', `${goal.id} is not complete`);
}

for (const candidate of requirements.packages) {
  const declared = rootPackage.dependencies?.[candidate.name];
  assert.equal(declared, `file:${candidate.tarball}`, `${candidate.name} must resolve from the vendored packed candidate`);
  const tarball = await readFile(path.join(root, candidate.tarball));
  assert.equal(createHash('sha256').update(tarball).digest('hex'), candidate.tarballSha256, `${candidate.name} tarball changed`);
  const lockEntry = lock.packages[`node_modules/${candidate.name}`];
  assert.ok(lockEntry, `${candidate.name} is absent from package-lock.json`);
  assert.equal(lockEntry.version, candidate.version);
  assert.equal(lockEntry.integrity, candidate.integrity);
  const manifest = JSON.parse(await readFile(path.join(root, 'node_modules', ...candidate.name.split('/'), 'package.json'), 'utf8'));
  assert.equal(manifest.name, candidate.name);
  assert.equal(manifest.version, candidate.version);
  assert.equal(manifest.license, candidate.license);
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), [...candidate.requiredExports].sort());
  const runtime = await import(candidate.name);
  for (const name of candidate.requiredRuntimeExports) assert.ok(name in runtime, `${candidate.name} misses ${name}`);
  for (const name of requirements.forbiddenRuntimeExports) assert.equal(name in runtime, false, `${candidate.name} leaks ${name}`);
  if (candidate.requiredConformanceExports) {
    const conformance = await import(`${candidate.name}/conformance`);
    for (const name of candidate.requiredConformanceExports) assert.ok(name in conformance, `${candidate.name}/conformance misses ${name}`);
  }
}

console.log(`[editor-candidates] M03 complete; ${requirements.packages.length} packed public packages, exports and lock integrities passed`);
