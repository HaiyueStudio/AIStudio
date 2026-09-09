import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { collectPackages, inputBinding, localPath, fileDigest, readJson } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/m14-integration/test-output';
const archive = `${base}/diagnostics/before-completion-audit`;
const previous = await readJson(`${archive}/index.json`);
for (const item of previous.files) assert.equal(await fileDigest(item.archivedPath), `sha256:${item.sha256}`, item.archivedPath);
const report = await readJson(`${archive}/local-acceptance.json`);
const current = await inputBinding(await collectPackages());
const checks = await readJson(`${base}/completion-checks.json`);
const capability = await readJson('config/contracts/m14-capability-verification.json');
const collected = await readJson(`${base}/collected-tests.json`);
const latest = await readJson(`${base}/completion-adapter-latest.json`);
for (const input of [checks.inputDigest, capability.inputDigest, collected.inputDigest, latest.inputBinding.digest]) assert.equal(input, current.digest);
assert.equal(checks.capability.exitCode, 0); assert.equal(checks.rootCheck.exitCode, 0);
assert.equal(collected.executedFiles, collected.collectedFiles);
for (const entry of collected.results) {
  assert.equal(entry.exitCode, 0); assert.ok(entry.passed > 0);
  for (const key of ['failed', 'skipped', 'cancelled']) assert.equal(entry[key], 0);
}
const passed = collected.results.reduce((sum, entry) => sum + entry.passed, 0);
assert.ok((await readFile(localPath(checks.rootCheck.log), 'utf8')).includes(`${collected.executedFiles} files / ${passed} cases passed without skips`));
const adapter = await readJson(latest.check.path);
assert.equal(adapter.exitCode, 0); assert.equal(adapter.passed, 2);
for (const item of [latest.check, latest.runner, adapter.log, ...adapter.evidence]) assert.equal(await fileDigest(item.path), item.sha256);
report.verifiedAt = new Date().toISOString(); report.inputBinding = current;
report.rootCheck = checks.rootCheck;
report.capabilityChecks = capability.checks.reduce((sum, check) => sum + check.passed, 0);
report.integration = { files: collected.executedFiles, passed, failed: 0, skipped: 0 };
for (const game of report.games) {
  const actual = await readJson(`${base}/gameplay/${game.genre}.json`);
  assert.equal(actual.documentUnchanged, true); assert.equal(actual.rounds.length, 2);
  for (const round of actual.rounds) { assert.deepEqual(round.flows.map(f => f.signal), game.flows); assert.ok(round.flows.every(f => f.location)); assert.equal(round.cleanup.disposableCount, 0); }
  game.omittedCounts = actual.rounds.map(r => r.capture.truncation.omittedAtLeast);
}
const large = await readJson(`${base}/product/large/large.json`);
report.performance = { machine: large.machine, entityCount: large.entityCount, scriptCount: large.scriptCount, timings: large.timings, initialHeapBytes: large.initialHeapBytes, finalHeapBytes: large.finalHeapBytes, scope: report.performance.scope };
report.productScan = await readJson(`${base}/product/secret-scan.json`); assert.equal(report.productScan.passed, true);
const scan = await readJson(`${base}/secret-scan.json`); assert.equal(scan.passed, true); assert.equal(scan.inputDigest, current.digest);
report.uiComponents = { ...report.uiComponents, historical: true, verifiedInputDigest: previous.inputBinding.digest };
report.priorEvidenceArchive = `${archive}/index.json`;
report.fixtureStartTiming = { source: 'apps/ai-studio/test/m14-g08-adapter-review/device-main.mjs', productionRuntimeChanged: false, pausedStart: true, requiredInitialTick: 0, requiredInitialScore: 0, focusedPassed: 2, currentAdapterCheck: latest.check.path, failedAttempt: `${base}/completion-audit/2026-09-09T10-23-09-348Z/adapter.tap`, completionAudit: `${base}/completion-audit.json` };
const author = await readJson(`${base}/product/author/author.json`);
assert.ok(author.checks.includes('resource panel fits its container at desktop and narrow widths'));
report.resourceContainerLayout = { source: 'packages/studio-shell/src/panels/resources/resources.css', measurements: author.resourceLayout, standaloneHostWidth: 375, productionMinimumWindowWidth: 1024, verifiedBy: ['apps/ai-studio/test/m14-integration/product-electron.test.mjs', 'apps/ai-studio/test/resources/panel-electron.test.mjs'], screenshotsAfterUiSettled: true, failedAttempt: `${base}/diagnostics/resource-panel-before-fix.log`, priorCurrentEvidence: `${base}/diagnostics/before-resource-container-fix/index.json` };
const paths = [...new Set([
  ...report.evidence.map(item => item.path).filter(file => !file.startsWith(`${base}/ui-tabs-`)),
  checks.capability.log, checks.rootCheck.log, `${base}/completion-checks.json`,
  `${base}/completion-adapter-latest.json`, latest.check.path, latest.runner.path,
  adapter.log.path, ...adapter.evidence.map(e => e.path),
  `${base}/resource-container-product-final.log`,
])];
report.evidence = await Promise.all(paths.map(async file => ({ path: file, sha256: (await fileDigest(file)).slice(7) })));
assert.equal(report.productIntegrated, false); assert.equal(report.online.executed, false);
await writeFile(localPath(`${base}/local-acceptance.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ inputDigest: current.digest, inputFiles: current.fileCount, capabilityChecks: report.capabilityChecks, integration: report.integration, evidenceFiles: report.evidence.length }));
