import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertG12Acceptance } from '../evals/src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestArgument = process.argv.find((entry) => entry.startsWith('--manifest='));
const manifestPath = path.resolve(root, manifestArgument?.slice('--manifest='.length) ?? 'evals/evidence/g12/formal-acceptance.json');
assertContained(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

for (const artifact of manifest.artifacts ?? []) {
  const artifactPath = path.resolve(root, artifact.path);
  assertContained(artifactPath);
  const actual = `sha256:${createHash('sha256').update(await readFile(artifactPath)).digest('hex')}`;
  if (actual !== artifact.digest) throw new Error(`G12 artifact digest mismatch: ${artifact.path}`);
}

const repositories = { aistudio: root, engine: path.resolve(root, '..', 'Engine'), milestones: path.resolve(root, '..', 'milestones') };
for (const [name, repository] of Object.entries(repositories)) {
  const revision = git(repository, ['rev-parse', 'HEAD']);
  const dirty = git(repository, ['status', '--porcelain']);
  if (manifest.revisions?.[name]?.revision !== revision) throw new Error(`G12 ${name} revision is not the reviewed manifest revision.`);
  if (dirty !== '') throw new Error(`G12 ${name} worktree is not clean.`);
}

const result = assertG12Acceptance(manifest);
console.log(`[m12:g12] decision=${result.status} genres=7 backends=2 revisions=clean artifacts=${manifest.artifacts.length}`);

function assertContained(candidate) {
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error(`G12 path escapes AIStudio: ${candidate}`);
}

function git(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed for ${directory}: ${result.stderr}`);
  return result.stdout.trim();
}
