import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPackages, inputBinding, reference } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/test-output/workspace-advanced-drawer';
const output = 'docs/evidence/workspace-advanced-drawer';
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
const directory = [...log.matchAll(/M14 workspace artifacts: ([^\r\n]+)/gu)].at(-1)?.[1]; assert.ok(directory);
const browser = await json(path.join(directory, 'result.json'));
for (const field of ['desktop', 'keyboard', 'reload', 'rollback', 'teardown']) assert.equal(browser[field], true);
await mkdir(output, { recursive: true });
const artifacts = ['result.json', 'workspace-advanced.png', 'workspace-script.png', 'workspace-drawer-900.png', 'workspace-drawer-375.png'];
for (const file of artifacts) await copyFile(path.join(directory, file), `${output}/${file}`);
await copyFile(`${integration}/product/author/advanced-desktop.png`, `${output}/product-advanced-desktop.png`);
const sources = ['packages/studio-shell/src/workspace/workspace.ts', 'apps/ai-studio/src/renderer.ts', 'apps/ai-studio/src/editor-panels.ts', 'apps/ai-studio/renderer/styles.css', 'apps/ai-studio/test/layout/workspace-browser.mjs', 'apps/ai-studio/test/layout/workspace-main.mjs', 'apps/ai-studio/test/m14-integration/product-main.mjs'];
const files = [
  `${base}/input.json`, `${base}/checks.json`, `${base}/focused-check-initial.log`, `${base}/drawer-diagnostic.log`, `${base}/focused-check.log`,
  `${base}/root-check.log`, `${base}/capability-capture.log`, `${integration}/collected-tests.json`, 'config/contracts/m14-capability-verification.json',
  `${base}/product-recheck.log`, `${base}/conversation-recheck.log`, `${base}/pointer-recheck.log`,
  ...['input.json', 'checks.json', 'root-check.log', 'capability-capture.log', 'collected-tests.json', 'collected-13.tap', 'collected-28.tap', 'm14-capability-verification.json', 'm14-capability-census.json'].map(file => `${base}/initial-full-run/${file}`),
  ...['input.json', 'checks.json', 'root-check.log', 'capability-capture.log', 'collected-tests.json', 'collected-13.tap', 'm14-capability-verification.json', 'm14-capability-census.json'].map(file => `${base}/second-full-run/${file}`),
  ...[...artifacts, 'product-advanced-desktop.png'].map(file => `${output}/${file}`),
];
const focused = await readFile(`${base}/focused-check.log`, 'utf8');
assert.match(focused, /pass\s+4/u); assert.match(focused, /fail\s+0/u);
const productRecheck = await readFile(`${base}/product-recheck.log`, 'utf8');
assert.match(productRecheck, /pass\s+2/u); assert.match(productRecheck, /fail\s+0/u);
const conversationRecheck = await readFile(`${base}/conversation-recheck.log`, 'utf8');
assert.match(conversationRecheck, /pass\s+4/u); assert.match(conversationRecheck, /fail\s+0/u);
const pointerRecheck = await readFile(`${base}/pointer-recheck.log`, 'utf8');
assert.match(pointerRecheck, /pass\s+1/u); assert.match(pointerRecheck, /fail\s+0/u);
const report = {
  schemaVersion: 1, status: 'verified', scope: 'workspace-advanced-drawer', verifiedAt: new Date().toISOString(), inputBinding: current,
  behavior: 'Hierarchy/property and script entry points open the public hy-drawer from the right. Component mask, Escape, close buttons and focus restoration replace the native dialog. Existing editors stay mounted and keep draft text and selection. The workspace restores viewport placement on drawer-close. Source navigation waits for initial Drawer focus before selecting the exact script range or component location. Reopening waits for previous asynchronous cancellation; aria-busy exposes completion for the current transition and superseded or disposed callbacks cannot change it.',
  checks: { ...checks, focusedCases: 4, productRecheckCases: 2, conversationRecheckCases: 4, pointerRecheckCases: 1, capabilityCases: capabilities.checks.reduce((sum, item) => sum + item.passed, 0), integrationFiles: collected.collectedFiles, integrationCases: collected.results.reduce((sum, item) => sum + item.passed, 0) },
  browser,
  initialFocusedRun: { passed: 4, failed: 1, reason: 'The hidden fixture window stopped delivering animation frames during native Tab input after opening the Drawer. A diagnostic repeat pinpointed the frame wait. The fixture now presents an inactive window, preserving the original timeout and all interaction assertions. Focused and final full checks pass.' },
  initialFullRun: { passed: 213, failed: 2, reasons: ['The large product query raced asynchronous editor/cancel after closing the Drawer. Reopening now waits for cancellation and exposes the transition completion; the product test observes this completion before its independent resource query and covers rapid reopening.', 'The unchanged headless project-conversation test hit its 5 ms duration threshold. All four tests passed in the isolated recheck without source or assertion changes.'], evidenceDirectory: `${base}/initial-full-run` },
  secondFullRun: { passed: 214, failed: 1, reason: 'The product fixture presented the window with showInactive but did not establish native input focus before injecting the Gizmo drag. No transform approval or gesture transaction was produced. The fixture now focuses the window, awaits focus, and asserts that the coordinates hit the visible X handle before sending real input. The isolated product recheck passed with the original one-transaction assertion; the other 214 cases already passed in this run.', evidenceDirectory: `${base}/second-full-run` },
  scopeNotes: ['Actual sandboxed Electron tests cover both entry buttons, keyboard focus, Escape, mask and component-close actions, editor identity/draft/selection, reload and teardown.', 'Open Drawer geometry is checked through its public panel part at 900 px and 375 px. Production source navigation and public advanced editor composition also pass.', 'No live provider task was started; no user project was changed or running editor restarted. Milestone status and approval policy remain unchanged.'],
  sources: await Promise.all(sources.map(file => reference(file))), evidence: await Promise.all(files.map(file => reference(file, 'verification'))),
};
await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: `${output}/verification.json`, inputDigest: current.digest, ...report.checks }, null, 2));
