import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const reportPath = 'docs/evidence/execution-view-tabs/verification.json';
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const destination = 'apps/ai-studio/test/m14-integration/test-output/diagnostics/before-workspace-entity-tree';
await mkdir(destination, { recursive: true });
const references = [{ path: reportPath }, ...report.evidence, { path: 'config/contracts/m14-capability-census.json' }];
const entries = [];
for (const [index, ref] of references.entries()) {
  const bytes = await readFile(ref.path); const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (ref.sha256) assert.equal(sha256, ref.sha256, ref.path);
  const target = `${destination}/${String(index + 1).padStart(2, '0')}-${path.basename(ref.path)}`;
  await writeFile(target, bytes); entries.push({ original: ref.path, archived: target, sha256 });
}
await writeFile(`${destination}/index.json`, JSON.stringify({ schemaVersion: 1, archivedAt: new Date().toISOString(), priorInputDigest: report.inputBinding.digest, reason: 'Retain execution view verification before replacing the workspace entity selector.', entries }, null, 2) + '\n');
console.log(`Archived ${entries.length} references with verified hashes.`);

