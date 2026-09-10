import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPackages, inputBinding, reference } from '../../../../../scripts/m14-capability-census.mjs';

const base = 'apps/ai-studio/test/test-output/desktop-notifications';
const output = 'docs/evidence/desktop-notifications';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const current = await inputBinding(await collectPackages());
assert.equal(current.digest, (await json(`${base}/final-input.json`)).digest);
const checks = await json(`${base}/checks.json`);
for (const key of ['capabilityCaptureExitCode', 'focusedCheckExitCode', 'rootCheckExitCode']) assert.equal(checks[key], 0);
const capability = await json('config/contracts/m14-capability-verification.json');
const integrationBase = 'apps/ai-studio/test/m14-integration/test-output';
const collected = await json(`${integrationBase}/collected-tests.json`);
for (const input of [capability, collected]) assert.equal(input.inputDigest, current.digest);
assert.equal(collected.executedFiles, collected.collectedFiles);
for (const result of collected.results) {
  for (const key of ['exitCode', 'failed', 'skipped', 'cancelled']) assert.equal(result[key], 0);
  assert.ok(result.passed > 0);
}
const ui = collected.results.find(result => result.file === 'apps/ai-studio/test/notification-ui-electron.test.mjs');
assert.ok(ui);
const uiLog = await readFile(`${integrationBase}/${ui.log}`, 'utf8');
const productDirectory = uiLog.match(/\[notification-product\] evidence: ([^\r\n]+)/u)?.[1];
assert.ok(productDirectory);
const product = await json(path.join(productDirectory, 'production.json'));
assert.equal(product.reloaded, true); assert.equal(product.final.preferences.sound, false);
assert.equal(product.nativeDeliveryDisabledForTest, true);
const native = await json(`${base}/native.json`);
assert.equal(native.nativeShowEvent, true); assert.equal(native.delivery, 'shown');
await mkdir(output, { recursive: true });
await copyFile(path.join(productDirectory, 'production-settings.png'), `${output}/settings.png`);
await copyFile(path.join(productDirectory, 'production.json'), `${output}/production.json`);
await copyFile(`${base}/native.json`, `${output}/native.json`);
const sources = [
  'apps/ai-studio/src/main.ts', 'apps/ai-studio/src/desktop-notifications.ts',
  'apps/ai-studio/src/electron-notifications.ts', 'apps/ai-studio/src/notification-settings.ts',
  'apps/ai-studio/src/notification-ui.ts', 'apps/ai-studio/src/ipc.ts',
  'apps/ai-studio/src/renderer.ts', 'apps/ai-studio/renderer/preload.cjs',
  'packages/agent-orchestration/src/conversation-attention.ts',
  'packages/agent-orchestration/src/project-conversation.ts',
  'packages/studio-shell/src/panels/chat/index.ts',
];
const artifacts = [`${base}/checks.json`, `${base}/focused-check.log`, `${base}/root-check.log`, `${base}/capability-capture.log`,
  `${integrationBase}/collected-tests.json`, `${integrationBase}/${ui.log}`, `${output}/settings.png`, `${output}/production.json`, `${output}/native.json`];
const focused = await readFile(`${base}/focused-check.log`, 'utf8');
const focusedCases = Number(focused.match(/tests\s+(\d+)\s*(?:\r?\n|$)/u)?.[1]);
assert.ok(focusedCases > 0);
const report = {
  schemaVersion: 1, scope: 'desktop-notifications-local', status: 'verified', verifiedAt: new Date().toISOString(), inputBinding: current,
  checks: { ...checks, focusedCases, capabilityCases: capability.checks.reduce((sum, item) => sum + item.passed, 0), integrationFiles: collected.collectedFiles, integrationCases: collected.results.reduce((sum, item) => sum + item.passed, 0) },
  native: { checkedAt: native.checkedAt, platform: native.platform, electron: native.electron, supported: native.supported, showEventObserved: true, systemSoundRequested: native.preferences.sound, manuallyHeard: false, manuallyClicked: false },
  navigation: 'Service click callbacks and real DOM card/task focus are tested; no approval or task intent is dispatched by a notification click.',
  scopeNotes: ['No live provider task was executed for this feature.', 'This feature report does not advance G09 or replace its historical, input-bound completion audit.'],
  sources: await Promise.all(sources.map(file => reference(file))),
  evidence: await Promise.all(artifacts.map(file => reference(file, 'verification'))),
};
await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ input: current.digest, ...report.checks, report: `${output}/verification.json` }, null, 2));
