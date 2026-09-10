import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPackages, inputBinding, reference } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/test-output/graph-ui-refinement';
const output = 'docs/evidence/graph-ui-refinement';
const integration = 'apps/ai-studio/test/m14-integration/test-output';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const current = await inputBinding(await collectPackages());
assert.equal(current.digest, (await json(`${base}/input.json`)).digest);
const checks = await json(`${base}/checks.json`);
for (const field of ['focusedExitCode', 'capabilityExitCode']) assert.equal(checks[field], 0);
assert.equal(checks.rootExitCode, 1);
const recheckFile = `${base}/project-conversation-recheck.log`;
const recheckLog = await readFile(recheckFile, 'utf8');
for (const [key, count] of [['tests', 4], ['pass', 4], ['fail', 0], ['skipped', 0], ['cancelled', 0]]) assert.match(recheckLog, new RegExp(`\\b${key} ${count}\\b`));
const retriedFile = 'packages/agent-orchestration/test/project-conversation.test.mjs';
const collected = await json(`${integration}/collected-tests.json`);
const capabilities = await json('config/contracts/m14-capability-verification.json');
for (const report of [collected, capabilities]) assert.equal(report.inputDigest, current.digest);
assert.equal(collected.collectedFiles, collected.executedFiles);
for (const result of collected.results) {
  for (const field of ['exitCode', 'failed', 'skipped', 'cancelled']) assert.equal(result[field], result.file === retriedFile && (field === 'exitCode' || field === 'failed') ? 1 : 0);
  assert.ok(result.passed > 0);
}
const ui = collected.results.find(item => item.file === 'apps/ai-studio/test/graph-ui-electron.test.mjs');
assert.ok(ui);
const log = await readFile(`${integration}/${ui.log}`, 'utf8');
const directory = log.match(/\[graph-ui\] evidence: ([^\r\n]+)/u)?.[1]; assert.ok(directory);
const browser = await json(path.join(directory, 'result.json')); assert.equal(browser.status, 'passed');
await mkdir(output, { recursive: true });
const artifacts = ['result.json', ...browser.screenshots];
for (const file of artifacts) await copyFile(path.join(directory, file), `${output}/${file}`);
const sources = ['packages/studio-shell/src/panels/chat/index.ts', 'packages/studio-shell/src/panels/hover-panel.ts', 'apps/ai-studio/src/renderer.ts', 'apps/ai-studio/renderer/styles.css', 'packages/studio-shell/test/conversation.test.mjs', 'apps/ai-studio/test/graph-ui-electron.test.mjs', 'apps/ai-studio/test/fixtures/graph-ui-browser.mjs', 'apps/ai-studio/test/fixtures/graph-ui-main.mjs', 'scripts/m14-integration-tests.json'];
const files = [recheckFile, `${integration}/${collected.results.find(item => item.file === retriedFile).log}`,`${base}/checks.json`, `${base}/focused-check.log`, `${base}/root-check.log`, `${base}/capability-capture.log`, `${integration}/collected-tests.json`, `${integration}/${ui.log}`, ...artifacts.map(file => `${output}/${file}`)];
const focused = await readFile(`${base}/focused-check.log`, 'utf8');
const focusedCases = Number(focused.match(/tests\s+(\d+)\s*(?:\r?\n|$)/u)?.[1]); assert.ok(focusedCases > 0);
const report = {
  schemaVersion: 1, status: 'verified-with-recheck', scope: 'graph-ui-refinement', verifiedAt: new Date().toISOString(), inputBinding: current,
  cause: 'Permanent session, context, cost and node detail regions reduced graph space; viewing a graph required button zoom.',
  behavior: 'Cursor-anchored wheel zoom; public hy-border-beam on running nodes; history and usage in compact hover panels; node details on hover/focus with pin, Escape and replay continuity. Unknown usage remains unknown.',
  checks: { ...checks, focusedCases, capabilityCases: capabilities.checks.reduce((sum, item) => sum + item.passed, 0), integrationFiles: collected.collectedFiles, integrationCases: collected.results.reduce((sum, item) => sum + item.tests, 0), integrationInitialPassed: collected.results.reduce((sum, item) => sum + item.passed, 0), integrationInitialFailed: 1, recheckPassed: 4 },
  browser,
  recheck: { file: retriedFile, initialFailure: 'Timed out waiting for project conversation', result: '4 passed, 0 failed on the same source input', note: 'The initial full check remains recorded as exit 1. It was not rerun in full; only the failed test file was rerun.' },
  scopeNotes: ['Uses actual Electron hit testing and mouse input with isolated fixture data.', 'No approval decision was made for the user project; no live provider task was started.', 'Existing approval policy and G09 milestone status were not changed.'],
  sources: await Promise.all(sources.map(file => reference(file))), evidence: await Promise.all(files.map(file => reference(file, 'verification'))),
};
await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: `${output}/verification.json`, inputDigest: current.digest, ...report.checks }, null, 2));
