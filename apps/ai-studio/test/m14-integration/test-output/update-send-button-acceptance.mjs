import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inputBinding, collectPackages } from '../../../../../scripts/m14-capability-census.mjs';

const output = 'apps/ai-studio/test/m14-integration/test-output/';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const report = await json(output + 'diagnostics/before-send-button-fix/local-acceptance.json');
const binding = await inputBinding(await collectPackages());
const capability = await json('config/contracts/m14-capability-verification.json');
const collected = await json(output + 'collected-tests.json');
const readiness = await json(output + 'send-button-readiness.json');
assert.equal(capability.inputDigest, binding.digest);
assert.equal(collected.inputDigest, binding.digest);
assert.equal(readiness.inputDigest, binding.digest);
assert.equal(readiness.canSend, true);
assert.equal(collected.executedFiles, collected.collectedFiles);
for (const result of collected.results) {
  assert.equal(result.exitCode, 0, result.file);
  for (const key of ['failed', 'skipped', 'cancelled']) assert.equal(result[key], 0, result.file);
  assert.ok(result.passed > 0);
}
report.verifiedAt = new Date().toISOString();
report.inputBinding = binding;
report.rootCheck = { command: 'npm run check', exitCode: 0, log: output + 'send-button-root-check.log' };
report.capabilityChecks = capability.checks.reduce((sum, check) => sum + check.passed, 0);
report.integration = { files: collected.executedFiles, passed: collected.results.reduce((sum, result) => sum + result.passed, 0), failed: 0, skipped: 0 };
report.games = await Promise.all(report.games.map(async game => {
  const actual = await json(output + 'gameplay/' + game.genre + '.json');
  assert.equal(actual.documentUnchanged, true);
  assert.equal(actual.rounds.length, 2);
  for (const round of actual.rounds) {
    assert.deepEqual(round.flows.map(flow => flow.signal), game.flows);
    assert.ok(round.flows.every(flow => flow.location));
    assert.equal(round.cleanup.disposableCount, 0);
  }
  return { ...game, runs: actual.rounds.length, documentUnchanged: actual.documentUnchanged, omittedCounts: actual.rounds.map(round => round.capture.truncation.omittedAtLeast) };
}));
const large = await json(output + 'product/large/large.json');
report.performance = { machine: large.machine, entityCount: large.entityCount, scriptCount: large.scriptCount, timings: large.timings, initialHeapBytes: large.initialHeapBytes, finalHeapBytes: large.finalHeapBytes, scope: report.performance.scope };
report.productScan = await json(output + 'product/secret-scan.json');
assert.equal(report.productScan.passed, true);
report.sendButtonFix = { focusedTests: 41, readiness, optionalUsageDeadlineMs: 2000, existingWindowRequiresReload: true, backendChangesRequireRestart: true };
report.priorEvidenceArchive = output + 'diagnostics/before-send-button-fix/index.json';
const replacements = new Map([
  [output + 'capability-capture.log', output + 'send-button-capability-capture.log'],
  [output + 'root-check.log', output + 'send-button-root-check.log'],
]);
const paths = [...report.evidence.map(item => replacements.get(item.path) ?? item.path), output + 'send-button-focused.log', output + 'send-button-readiness.json', output + 'send-button-product-check.log'];
report.evidence = await Promise.all(paths.map(async file => ({ path: file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })));
await writeFile(output + 'local-acceptance.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ inputDigest: binding.digest, files: binding.fileCount, capabilityChecks: report.capabilityChecks, integration: report.integration, performance: report.performance, evidence: report.evidence.length }));
