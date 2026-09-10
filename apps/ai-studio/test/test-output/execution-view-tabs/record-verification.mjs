import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPackages, inputBinding, reference } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/test-output/execution-view-tabs';
const output = 'docs/evidence/execution-view-tabs';
const integration = 'apps/ai-studio/test/m14-integration/test-output';
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
const current = await inputBinding(await collectPackages());
assert.equal(current.digest, (await json(`${base}/input.json`)).digest);
const checks = await json(`${base}/checks.json`);
for (const field of ['focusedExitCode', 'capabilityExitCode', 'rootExitCode']) assert.equal(checks[field], 0);
const collected = await json(`${integration}/collected-tests.json`);
const capabilities = await json('config/contracts/m14-capability-verification.json');
for (const report of [collected, capabilities]) assert.equal(report.inputDigest, current.digest);
assert.equal(collected.collectedFiles, collected.executedFiles);
for (const result of [...collected.results, ...capabilities.checks]) {
  for (const field of ['exitCode', 'failed', 'skipped', 'cancelled']) assert.equal(result[field], 0);
  assert.ok(result.passed > 0);
}
const ui = collected.results.find(item => item.file === 'apps/ai-studio/test/graph-ui-electron.test.mjs');
const approvalUi = collected.results.find(item => item.file === 'apps/ai-studio/test/plan-review-electron.test.mjs');
assert.ok(ui && approvalUi);
const log = await readFile(`${integration}/${ui.log}`, 'utf8');
const approvalLog = await readFile(`${integration}/${approvalUi.log}`, 'utf8');
const directory = log.match(/\[graph-ui\] evidence: ([^\r\n]+)/u)?.[1]; assert.ok(directory);
const approvalDirectory = approvalLog.match(/\[plan-review\] evidence: ([^\r\n]+)/u)?.[1]; assert.ok(approvalDirectory);
const browser = await json(path.join(directory, 'result.json')); assert.equal(browser.status, 'passed');
assert.ok(browser.presentationTabs);
for (const value of Object.values(browser.presentationTabs)) assert.equal(value, true);
const approval = await json(path.join(approvalDirectory, 'result.json')); assert.equal(approval.status, 'passed');
await mkdir(output, { recursive: true });
const artifacts = ['result.json', ...browser.screenshots];
for (const file of artifacts) await copyFile(path.join(directory, file), `${output}/${file}`);
const approvalArtifacts = approval.sizes.map(([width, height]) => `plan-steps-${width}x${height}.png`);
for (const file of approvalArtifacts) await copyFile(path.join(approvalDirectory, file), `${output}/${file}`);
await copyFile(path.join(approvalDirectory, 'result.json'), `${output}/approval-result.json`);
const sources = ['packages/studio-shell/src/panels/chat/index.ts', 'apps/ai-studio/renderer/styles.css', 'apps/ai-studio/src/main.ts', 'apps/ai-studio/test/fixtures/graph-ui-browser.mjs', 'apps/ai-studio/test/fixtures/graph-ui-main.mjs', 'apps/ai-studio/test/fixtures/plan-review-browser.mjs', 'apps/ai-studio/test/fixtures/plan-review-main.mjs', 'apps/ai-studio/test/fixtures/notification-ui-browser.mjs', 'apps/ai-studio/test/execution-graph-electron.test.mjs'];
const files = [`${base}/input.json`, `${base}/input-initial.json`, `${base}/checks.json`, `${base}/focused-check-initial.log`, `${base}/focused-check.log`, `${base}/product-recheck.log`, `${base}/root-check.log`, `${base}/capability-capture-initial.log`, `${base}/capability-capture.log`, `${integration}/collected-tests.json`, 'config/contracts/m14-capability-verification.json', `${integration}/${ui.log}`, `${integration}/${approvalUi.log}`, ...[...artifacts, ...approvalArtifacts, 'approval-result.json'].map(file => `${output}/${file}`)];
const focused = await readFile(`${base}/focused-check.log`, 'utf8');
const focusedCases = Number(focused.match(/tests\s+(\d+)\s*(?:\r?\n|$)/u)?.[1]); assert.equal(focusedCases, 34);
const productRecheck = await readFile(`${base}/product-recheck.log`, 'utf8'); assert.match(productRecheck, /pass\s+1/u); assert.match(productRecheck, /fail\s+0/u);
const report = {
  schemaVersion: 1, status: 'verified', scope: 'execution-view-tabs', verifiedAt: new Date().toISOString(), inputBinding: current,
  cause: 'Topology and the conversation step feed were mounted as vertically stacked regions in one workspace.',
  behavior: 'Public hy-tabs offers mutually exclusive topology and execution-steps views. The graph fills available height; the transcript remains a graph detail action. View choice, graph pan/zoom/selection, feed position and composer draft/focus survive updates. Pending approvals remain in a shared visible area; notification navigation reveals the target view.',
  checks: { ...checks, focusedCases, productRecheckCases: 1, capabilityCases: capabilities.checks.reduce((sum, item) => sum + item.passed, 0), integrationFiles: collected.collectedFiles, integrationCases: collected.results.reduce((sum, item) => sum + item.passed, 0) },
  browser, approval,
  initialFocusedRun: { passed: 33, failed: 1, reason: 'The old G09 test page had no bounded parent height and relied on the graph fixed minimum height. The fixture now provides viewport height like the product. All original fit, scroll and location assertions pass with the fluid graph layout.' },
  initialCapabilityRun: { passed: 122, failed: 1, reason: 'The product smoke assertion still required exactly three HYTabs instances. The new execution-view tabs bring the actual count to four. The exact assertion was updated to four, the product flow was rerun successfully, and capability capture was then rerun against the updated source binding.' },
  scopeNotes: ['Uses actual Electron input with isolated fixture data; Tab labels, keyboard switching and mutually exclusive visibility are asserted.', 'Approval buttons remain hittable in both views at 320x600, 360x720 and 720x900.', 'No live provider task was started, no user approval decision was made, and the running editor was not restarted.', 'G09 milestone status and existing approval policy remain unchanged.'],
  sources: await Promise.all(sources.map(file => reference(file))), evidence: await Promise.all(files.map(file => reference(file, 'verification'))),
};
await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: `${output}/verification.json`, inputDigest: current.digest, ...report.checks }, null, 2));
