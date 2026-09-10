import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPackages, inputBinding, reference } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/test-output/script-codemirror';
const output = 'docs/evidence/script-codemirror';
const integration = 'apps/ai-studio/test/m14-integration/test-output';
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
const current = await inputBinding(await collectPackages());
assert.equal(current.digest, (await json(`${base}/input.json`)).digest);
const checks = await json(`${base}/checks.json`);
for (const field of ['focusedExitCode', 'capabilityExitCode', 'rootExitCode']) assert.equal(checks[field], 0);
const focused = await readFile(`${base}/focused-check.log`, 'utf8');
assert.match(focused, /^# pass 2$/mu); assert.match(focused, /^# fail 0$/mu);
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
for (const value of Object.values(browser.codeMirror)) assert.equal(value, true);
await mkdir(output, { recursive: true });
const artifacts = ['result.json', 'workspace-script.png', 'workspace-drawer-900.png', 'workspace-drawer-375.png'];
for (const file of artifacts) await copyFile(path.join(directory, file), `${output}/${file}`);
const sources = ['package-lock.json', 'packages/studio-shell/package.json', 'packages/studio-shell/src/script-editor.ts', 'packages/studio-shell/src/script-format.ts', 'apps/ai-studio/src/renderer.ts', 'apps/ai-studio/renderer/index.html', 'apps/ai-studio/renderer/styles.css', 'apps/ai-studio/test/layout/script-editor-checks.mjs', 'apps/ai-studio/test/layout/workspace-browser.mjs', 'apps/ai-studio/test/layout/workspace-main.mjs'];
const files = [`${base}/input.json`, `${base}/checks.json`, `${base}/focused-check-initial.log`, `${base}/focus-recheck.log`, `${base}/focused-check.log`, `${base}/root-check.log`, `${base}/capability-capture.log`, `${integration}/collected-tests.json`, 'config/contracts/m14-capability-verification.json', ...artifacts.map(file => `${output}/${file}`)];
const report = {
  schemaVersion: 1, status: 'verified', scope: 'script-codemirror', verifiedAt: new Date().toISOString(), inputBinding: current,
  behavior: 'The script Drawer mounts CodeMirror 6 with TypeScript highlighting, line numbers, folding, history and accessible focus navigation. Formatting uses locally bundled Prettier, via a button or Shift+Alt+F, and never commits or executes scripts. Formatting is one undoable change; edits invalidate old validation results. Source/revision changes and disposal discard late formatting or validation. Stored CRLF source offsets map correctly to the normalized editor. Existing script capabilities are preserved during manual validation. Ordinary refresh and Drawer reopening retain the draft.',
  checks: { ...checks, focusedCases: 2, capabilityCases: capabilities.checks.reduce((n, x) => n + x.passed, 0), integrationFiles: collected.executedFiles, integrationCases: collected.results.reduce((n, x) => n + x.passed, 0) },
  initialFocusedRun: { passed: 1, failed: 1, reason: 'The old smoke assertion was initially translated to CodeMirror.hasFocus, which additionally requires a foreground OS window. The hidden smoke window intentionally has no OS focus. The final check asserts the actual contenteditable DOM focus target and exact range, retaining the original assertion semantics. No production focus workaround or test timeout relaxation was introduced.' },
  browser: browser.codeMirror,
  sources: await Promise.all(sources.map(file => reference(file))), evidence: await Promise.all(files.map(file => reference(file, 'verification'))),
  limitations: ['No real provider request, user project mutation or milestone status change.', 'Formatting changes the local draft and still requires validation and explicit commit.'],
};
await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: `${output}/verification.json`, inputDigest: current.digest, checks: report.checks }, null, 2));
