import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPackages, inputBinding, reference } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/test-output/task-graph-continuity';
const output = 'docs/evidence/task-graph-continuity';
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
for (const result of collected.results) {
  for (const field of ['exitCode', 'failed', 'skipped', 'cancelled']) assert.equal(result[field], 0);
  assert.ok(result.passed > 0);
}
for (const result of capabilities.checks) {
  for (const field of ['exitCode', 'failed', 'skipped', 'cancelled']) assert.equal(result[field], 0);
}
const ui = collected.results.find(item => item.file === 'apps/ai-studio/test/graph-ui-electron.test.mjs');
assert.ok(ui);
const log = await readFile(`${integration}/${ui.log}`, 'utf8');
const directory = log.match(/\[graph-ui\] evidence: ([^\r\n]+)/u)?.[1]; assert.ok(directory);
const browser = await json(path.join(directory, 'result.json')); assert.equal(browser.status, 'passed');
assert.ok(browser.taskContinuity.afterHandoff > browser.taskContinuity.before);
assert.ok(browser.taskContinuity.afterExecution > browser.taskContinuity.afterHandoff);
for (const field of ['selectionAndZoomPreserved', 'separateRequests', 'historySelection']) assert.equal(browser.taskContinuity[field], true);
await mkdir(output, { recursive: true });
const artifacts = ['result.json', ...browser.screenshots];
for (const file of artifacts) await copyFile(path.join(directory, file), `${output}/${file}`);
const sources = [
  'packages/studio-shell/src/conversation/execution-graph-types.ts',
  'packages/studio-shell/src/conversation/execution-graph.ts',
  'packages/studio-shell/src/panels/chat/index.ts',
  'packages/agent-orchestration/src/conversation-host.ts',
  'apps/ai-studio/src/renderer.ts',
  'packages/studio-shell/test/execution-graph.test.mjs',
  'apps/ai-studio/test/execution-graph-context-ui.test.mjs',
  'apps/ai-studio/test/fixtures/graph-ui-browser.mjs',
  'apps/ai-studio/test/fixtures/graph-ui-main.mjs',
  'apps/ai-studio/test/fixtures/g09-execution-graph-main.mjs',
];
const related = collected.results.filter(item => /execution-graph|graph-ui/u.test(item.file));
const files = [`${base}/input.json`, `${base}/checks.json`, `${base}/focused-check-initial.log`, `${base}/focused-check.log`, `${base}/root-check.log`, `${base}/capability-capture.log`, `${integration}/collected-tests.json`, 'config/contracts/m14-capability-verification.json', ...related.map(item => `${integration}/${item.log}`), ...artifacts.map(file => `${output}/${file}`)];
const focused = await readFile(`${base}/focused-check.log`, 'utf8');
const focusedCases = Number(focused.match(/tests\s+(\d+)\s*(?:\r?\n|$)/u)?.[1]); assert.equal(focusedCases, 42);
const report = {
  schemaVersion: 1, status: 'verified', scope: 'task-graph-continuity', verifiedAt: new Date().toISOString(), inputBinding: current,
  cause: 'Approval/continuation can start another provider session for the same durable task. The UI previously selected only the newest session graph; a new session initially has just a goal and a turn. Overlapping snapshot/replay responses could also restore older graph state.',
  behavior: 'Compose all retained source-session phases using durable task identity. Namespace nodes by source session, preserve graph selection and zoom across handoff, retain legacy history and separate new requests. Follow the current task during unbound provider bootstrap. Reject older session snapshots and renderer replay responses. Context compaction still targets the actual provider session.',
  checks: { ...checks, focusedCases, capabilityCases: capabilities.checks.reduce((sum, item) => sum + item.passed, 0), integrationFiles: collected.collectedFiles, integrationCases: collected.results.reduce((sum, item) => sum + item.passed, 0) },
  browser,
  initialFocusedRun: { passed: 41, failed: 1, reason: 'The existing G09 drag test timed out waiting for animation frames in a background window. Test windows now disable background frame throttling; no production window policy changed. The complete 42-case focused run then passed.' },
  scopeNotes: ['Uses actual Electron mouse input with isolated fixture data.', 'Task membership comes from durable turn.started taskId, never similar titles or timestamps.', 'Existing per-session durable storage, approvals, context ownership and G09 milestone status were not changed.', 'No live provider task was started and the user application was not stopped or restarted.'],
  sources: await Promise.all(sources.map(file => reference(file))), evidence: await Promise.all(files.map(file => reference(file, 'verification'))),
};
await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: `${output}/verification.json`, inputDigest: current.digest, ...report.checks }, null, 2));
