import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPackages, inputBinding, reference } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/test-output/plan-review-visibility';
const output = 'docs/evidence/plan-review-visibility';
const integration = 'apps/ai-studio/test/m14-integration/test-output';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const current = await inputBinding(await collectPackages());
assert.equal(current.digest, (await json(`${base}/input.json`)).digest);
const checks = await json(`${base}/checks.json`);
for (const field of ['focusedExitCode', 'capabilityExitCode', 'rootExitCode']) assert.equal(checks[field], 0);
const collected = await json(`${integration}/collected-tests.json`);
const capabilities = await json('config/contracts/m14-capability-verification.json');
for (const report of [collected, capabilities]) assert.equal(report.inputDigest, current.digest);
assert.equal(collected.collectedFiles, collected.executedFiles);
for (const result of collected.results) {
  for (const field of ['exitCode', 'failed', 'skipped', 'cancelled']) assert.equal(result[field], 0);
  assert.ok(result.passed > 0);
}
const ui = collected.results.find(item => item.file === 'apps/ai-studio/test/plan-review-electron.test.mjs');
assert.ok(ui);
const log = await readFile(`${integration}/${ui.log}`, 'utf8');
const directory = log.match(/\[plan-review\] evidence: ([^\r\n]+)/u)?.[1]; assert.ok(directory);
const browser = await json(path.join(directory, 'result.json')); assert.equal(browser.status, 'passed');
await mkdir(output, { recursive: true });
const artifacts = ['result.json', ...browser.sizes.map(([width, height]) => `plan-${width}x${height}.png`)];
for (const file of artifacts) await copyFile(path.join(directory, file), `${output}/${file}`);
const sources = ['packages/studio-shell/src/panels/chat/index.ts', 'apps/ai-studio/renderer/styles.css', 'packages/studio-shell/test/conversation.test.mjs', 'apps/ai-studio/test/plan-review-electron.test.mjs', 'apps/ai-studio/test/fixtures/plan-review-browser.mjs', 'apps/ai-studio/test/fixtures/plan-review-main.mjs', 'scripts/m14-integration-tests.json'];
const files = [`${base}/checks.json`, `${base}/focused-check.log`, `${base}/root-check.log`, `${base}/capability-capture.log`, `${integration}/collected-tests.json`, `${integration}/${ui.log}`, ...artifacts.map(file => `${output}/${file}`)];
const focused = await readFile(`${base}/focused-check.log`, 'utf8');
const focusedCases = Number(focused.match(/tests\s+(\d+)\s*(?:\r?\n|$)/u)?.[1]); assert.ok(focusedCases > 0);
const report = {
  schemaVersion: 1, status: 'verified', scope: 'plan-review-visibility', verifiedAt: new Date().toISOString(), inputBinding: current,
  cause: 'Conditional graph, task and cost panels occupied a fixed five-row chat grid, pushing the plan card outside the clipped panel.',
  behavior: 'Actionable plan/question/approval cards have a bounded area above the scrollable workspace. Composer and approval controls remain visible; completed and expired approvals stay in history.',
  checks: { ...checks, focusedCases, capabilityCases: capabilities.checks.reduce((sum, item) => sum + item.passed, 0), integrationFiles: collected.collectedFiles, integrationCases: collected.results.reduce((sum, item) => sum + item.passed, 0) },
  browser,
  scopeNotes: ['Uses actual Electron hit testing and mouse input with isolated fixture data.', 'No approval decision was made for the user project; no live provider task was started.', 'Existing approval policy and G09 milestone status were not changed.'],
  sources: await Promise.all(sources.map(file => reference(file))), evidence: await Promise.all(files.map(file => reference(file, 'verification'))),
};
await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: `${output}/verification.json`, inputDigest: current.digest, ...report.checks }, null, 2));
