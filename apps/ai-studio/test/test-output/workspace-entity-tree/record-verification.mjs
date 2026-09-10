import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPackages, inputBinding, reference } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/test-output/workspace-entity-tree';
const output = 'docs/evidence/workspace-entity-tree';
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
const log = await readFile(`${base}/root-check.log`, 'utf8');
const directories = [...log.matchAll(/M14 workspace artifacts: ([^\r\n]+)/gu)];
const directory = directories.at(-1)?.[1]; assert.ok(directory);
const browser = await json(path.join(directory, 'result.json'));
assert.deepEqual(browser.samples.map(item => item.count), [1, 100, 1000, 10000]);
for (const field of ['desktop', 'keyboard', 'reload', 'rollback', 'teardown']) assert.equal(browser[field], true);
await mkdir(output, { recursive: true });
const artifacts = ['result.json', 'workspace-desktop.png', 'workspace-900.png', 'workspace-375.png'];
for (const file of artifacts) await copyFile(path.join(directory, file), `${output}/${file}`);
const sources = [
  'packages/studio-shell/src/workspace/workspace.ts', 'packages/studio-shell/src/workspace/ports.ts',
  'apps/ai-studio/src/renderer.ts', 'apps/ai-studio/renderer/styles.css',
  'apps/ai-studio/test/layout/workspace-browser.mjs', 'apps/ai-studio/test/layout/workspace-main.mjs',
  'apps/ai-studio/test/layout/workspace-electron.test.mjs',
];
const files = [
  `${base}/input.json`, `${base}/checks.json`, `${base}/focused-check-initial.log`, `${base}/focused-check.log`,
  `${base}/tree-recheck.log`, `${base}/root-check.log`, `${base}/capability-capture.log`,
  `${integration}/collected-tests.json`, 'config/contracts/m14-capability-verification.json',
  ...artifacts.map(file => `${output}/${file}`),
];
const focused = await readFile(`${base}/focused-check.log`, 'utf8');
assert.match(focused, /pass\s+4/u); assert.match(focused, /fail\s+0/u);
const report = {
  schemaVersion: 1, status: 'verified', scope: 'workspace-entity-tree', verifiedAt: new Date().toISOString(), inputBinding: current,
  behavior: 'The logic workspace uses public hy-tree for single object selection and real scene parent-child relationships. Search keeps and expands ancestor paths, viewport selection reveals its object, and layout reparenting restores data and selected visibility. Clipboard edits and drag are disabled in this selection-only view. Large lists use the component virtualized rendering.',
  checks: { ...checks, focusedCases: 4, capabilityCases: capabilities.checks.reduce((sum, item) => sum + item.passed, 0), integrationFiles: collected.collectedFiles, integrationCases: collected.results.reduce((sum, item) => sum + item.passed, 0) },
  browser,
  initialFocusedRun: { passed: 4, failed: 1, reason: 'The public Tree resets expanded branches on reconnection. Selected objects could become hidden after layout reparenting. The workspace now explicitly reveals its authoritative selection after applying the layout. The isolated regression and final full check pass.' },
  scopeNotes: ['Real sandboxed Electron workspace exercises keyboard and mouse selection, filtering, hierarchy, virtualized large lists, literal labels, layout migration and teardown.', 'Tests use isolated project data and no online provider tasks.', 'The running user editor was not restarted. Existing approval policy and milestone status are unchanged.'],
  sources: await Promise.all(sources.map(file => reference(file))), evidence: await Promise.all(files.map(file => reference(file, 'verification'))),
};
await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: `${output}/verification.json`, inputDigest: current.digest, ...report.checks }, null, 2));
