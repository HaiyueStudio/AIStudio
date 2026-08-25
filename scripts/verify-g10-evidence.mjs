import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POC_COMMON_PLUGIN_IDS, POC_EDITOR_PROFILES } from '../apps/ai-studio/dist/profiles/agent-game-authoring.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'docs/evidence/g10-expected-manifest.json'), 'utf8'));
const revalidation = JSON.parse(await readFile(path.join(root, 'docs/evidence/g10-revalidation-2026-08-25.json'), 'utf8'));
const pins = JSON.parse(await readFile(path.join(root, 'config/upstream/pins.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const appPackage = JSON.parse(await readFile(path.join(root, 'apps/ai-studio/package.json'), 'utf8'));
const enginePackage = JSON.parse(await readFile(path.join(root, 'node_modules/@haiyue/engine/package.json'), 'utf8'));
const uiPackage = JSON.parse(await readFile(path.join(root, 'node_modules/@haiyue/ui/package.json'), 'utf8'));

assert.equal(manifest.schemaVersion, 1);
assert.deepEqual(manifest.commonPluginIds, POC_COMMON_PLUGIN_IDS);
for (const [id, profile] of Object.entries(POC_EDITOR_PROFILES)) {
  assert.deepEqual(manifest.profiles[id], { backend: profile.backend, auth: profile.auth });
}
assert.equal(manifest.versions.deepseekHarnessTag, pins.deepseekHarness.tag);
assert.equal(manifest.versions.deepseekHarnessCommit, pins.deepseekHarness.commit);
assert.equal(manifest.versions.deepseekHarnessLicense, pins.deepseekHarness.license);
assert.equal(manifest.versions.codexCli, pins.codex.version);
assert.equal(manifest.versions.codexSchemaSha256, pins.codex.schemaTreeSha256);
assert.equal(packageJson.engines.node, '>=22.19.0');
assert.deepEqual(manifest.realAgentGolden.backends.sort(), ['codex-app-server', 'harness-api-key']);
assert.equal(manifest.approvalAudit.negativeMutationCount, 0);
for (const candidate of manifest.editorCandidates) {
  const bytes = await readFile(path.join(root, 'vendor', candidate.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), candidate.sha256, candidate.file);
}
assert.equal(findForbiddenSecretKey(manifest), null);
assert.equal(revalidation.schemaVersion, 1);
assert.match(revalidation.implementationCommit, /^[a-f0-9]{40}$/u);
execFileSync('git', ['cat-file', '-e', `${revalidation.implementationCommit}^{commit}`], { cwd: root });
execFileSync('git', ['merge-base', '--is-ancestor', revalidation.implementationCommit, 'HEAD'], { cwd: root });
if (process.env.G10_ALLOW_DIRTY_EVIDENCE !== '1') assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '', 'G10 evidence must be checked from a clean worktree');
assert.deepEqual(revalidation.profiles, manifest.profiles);
assert.deepEqual(revalidation.commonPluginIds, POC_COMMON_PLUGIN_IDS);
assert.equal(revalidation.versions.nodeRunner, process.version.slice(1));
assert.equal(revalidation.versions.electron, appPackage.devDependencies.electron);
assert.equal(revalidation.versions.engine, enginePackage.version);
assert.equal(revalidation.versions.ui, uiPackage.version);
assert.equal(revalidation.versions.codexCli, pins.codex.version);
assert.equal(revalidation.versions.deepseekHarnessCommit, pins.deepseekHarness.commit);
assert.equal(revalidation.gates.workspaceCheck, 'pass');
assert.equal(revalidation.gates.packageTests.passed, 127);
assert.equal(revalidation.gates.packageTests.failed, 0);
assert.equal(revalidation.gates.appFocusedTests.passed, 25);
assert.equal(revalidation.gates.appFocusedTests.failed, 0);
assert.equal(revalidation.gates.audit.totalVulnerabilities, 0);
assert.deepEqual(revalidation.realAgentGolden.map((item) => item.backend).sort(), ['codex-app-server', 'harness-api-key']);
for (const result of revalidation.realAgentGolden) {
  assert.equal(result.terminal, 'completed');
  assert.equal(result.revision, 3);
  assert.equal(result.persistenceObserved, false);
  assert.deepEqual(result.mutations, ['entity.create', 'transform.set']);
}
assert.equal(revalidation.browserWebGpu.status, 'pass');
assert.equal(revalidation.electronWebGpu.status, 'pass');
assert.equal(revalidation.electronWebGpu.passed, 2);
assert.equal(revalidation.electronWebGpu.failed, 0);
assert.equal(revalidation.electronWebGpu.electronSecurity.rendererSandbox, true);
assert.equal(revalidation.electronWebGpu.electronSecurity.gpuSandbox, true);
assert.equal(revalidation.electronWebGpu.electronSecurity.contextIsolation, true);
assert.equal(revalidation.bugBundle.offlineVerification, 'pass');
assert.equal(revalidation.bugBundle.tamperRejection, 'pass');
assert.equal(revalidation.approvalAudit.negativeMutationCount, 0);
assert.equal(revalidation.approvalAudit.expiryMs, 300000);
assert.equal(revalidation.decision, 'GO');
assert.deepEqual(revalidation.blockingConditions, []);
assert.equal(findForbiddenSecretKey(revalidation), null);
console.log(`[g10-evidence] historicalCommit=${manifest.baseCommit.slice(0, 12)} implementationCommit=${revalidation.implementationCommit.slice(0, 12)} profiles=2 plugins=${manifest.commonPluginIds.length} packages=${revalidation.gates.packageTests.passed} app=${revalidation.gates.appFocusedTests.passed} electron=${revalidation.electronWebGpu.passed}/${revalidation.electronWebGpu.passed + revalidation.electronWebGpu.failed} decision=${revalidation.decision} secretKeys=0`);

function findForbiddenSecretKey(value, currentPath = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenSecretKey(value[index], `${currentPath}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (/api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|password|credential|private[-_]?key|secret/i.test(key)) return `${currentPath}.${key}`;
    const found = findForbiddenSecretKey(child, `${currentPath}.${key}`);
    if (found) return found;
  }
  return null;
}
