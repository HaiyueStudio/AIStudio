import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POC_COMMON_PLUGIN_IDS, POC_EDITOR_PROFILES } from '../apps/ai-studio/dist/profiles/agent-game-authoring.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'docs/evidence/g10-expected-manifest.json'), 'utf8'));
const pins = JSON.parse(await readFile(path.join(root, 'config/upstream/pins.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

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
console.log(`[g10-evidence] profiles=2 plugins=${manifest.commonPluginIds.length} candidates=${manifest.editorCandidates.length} secretKeys=0`);

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
