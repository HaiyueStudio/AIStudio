import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inputBinding, collectPackages } from '../../../../../scripts/m14-capability-census.mjs';

const output = 'apps/ai-studio/test/m14-integration/test-output/';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const report = await json(output + 'diagnostics/before-tool-failure-fix/local-acceptance.json');
const priorDigest = report.inputBinding.digest;
const binding = await inputBinding(await collectPackages());
const capability = await json('config/contracts/m14-capability-verification.json');
const collected = await json(output + 'collected-tests.json');
assert.equal(capability.inputDigest, binding.digest);
assert.equal(collected.inputDigest, binding.digest);
assert.equal(collected.executedFiles, collected.collectedFiles);
for (const result of collected.results) {
  assert.equal(result.exitCode, 0, result.file);
  for (const key of ['failed', 'skipped', 'cancelled']) assert.equal(result[key], 0, result.file);
  assert.ok(result.passed > 0);
}
const passed = collected.results.reduce((sum, result) => sum + result.passed, 0);
const rootLog = await readFile(output + 'tool-failures-root-check.log', 'utf8');
assert.ok(rootLog.includes(`${collected.executedFiles} files / ${passed} cases passed without skips`));
for (const [name, count] of [['tool-failures-focused.log', 13], ['tool-failures-barrier.log', 6]]) {
  const text = await readFile(output + name, 'utf8');
  for (const [key, value] of [['tests', count], ['pass', count], ['fail', 0], ['cancelled', 0], ['skipped', 0]]) assert.ok(text.includes(`ℹ ${key} ${value}`), name + ':' + key);
}
report.verifiedAt = new Date().toISOString();
report.inputBinding = binding;
report.rootCheck = { command: 'npm run check', exitCode: 0, log: output + 'tool-failures-root-check.log' };
report.capabilityChecks = capability.checks.reduce((sum, check) => sum + check.passed, 0);
report.integration = { files: collected.executedFiles, passed, failed: 0, skipped: 0 };
report.games = await Promise.all(report.games.map(async game => {
  const actual = await json(output + 'gameplay/' + game.genre + '.json');
  assert.equal(actual.documentUnchanged, true); assert.equal(actual.rounds.length, 2);
  for (const round of actual.rounds) {
    assert.deepEqual(round.flows.map(flow => flow.signal), game.flows);
    assert.ok(round.flows.every(flow => flow.location)); assert.equal(round.cleanup.disposableCount, 0);
  }
  return { ...game, runs: actual.rounds.length, documentUnchanged: actual.documentUnchanged, omittedCounts: actual.rounds.map(round => round.capture.truncation.omittedAtLeast) };
}));
const large = await json(output + 'product/large/large.json');
report.performance = { machine: large.machine, entityCount: large.entityCount, scriptCount: large.scriptCount, timings: large.timings, initialHeapBytes: large.initialHeapBytes, finalHeapBytes: large.finalHeapBytes, scope: report.performance.scope };
report.productScan = await json(output + 'product/secret-scan.json');
assert.equal(report.productScan.passed, true);
const scan = await json(output + 'secret-scan.json'); assert.equal(scan.passed, true); assert.equal(scan.inputDigest, binding.digest);
report.sendButtonFix = { ...report.sendButtonFix, historical: true, verifiedInputDigest: priorDigest, note: 'The prior read-only account/model readiness probe is preserved in the archive and was not rerun for this source revision.' };
report.toolFailureFix = { focusedTests: 19, publicSearchMaxLength: 512, fullPlanSelection: true, sharedEvaluatorAssertionValidation: true, preservedBarrierStatusExplained: true, existingWindowRequiresRestart: true };
report.priorEvidenceArchive = output + 'diagnostics/before-tool-failure-fix/index.json';
const replacements = new Map([
  [output + 'send-button-capability-capture.log', output + 'tool-failures-capability-capture.log'],
  [output + 'send-button-root-check.log', output + 'tool-failures-root-check.log'],
]);
const paths = [...report.evidence.map(item => replacements.get(item.path) ?? item.path).filter(file => !file.startsWith(output + 'send-button-')), output + 'tool-failures-focused.log', output + 'tool-failures-barrier.log', output + 'secret-scan.json', 'config/contracts/m14-capability-verification.json'];
report.evidence = await Promise.all(paths.map(async file => ({ path: file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })));
await writeFile(output + 'local-acceptance.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ inputDigest: binding.digest, files: binding.fileCount, capabilityChecks: report.capabilityChecks, integration: report.integration, performance: report.performance, evidence: report.evidence.length, scan }, null, 2));
