import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins';
import { inputBinding, collectPackages } from '../../../../scripts/m14-capability-census.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)), output = new URL('./test-output/', import.meta.url);
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
await mkdir(output, { recursive: true });
const packages = await collectPackages(), before = await inputBinding(packages);
const scope = JSON.parse(await readFile(path.join(root, 'config/contracts/m14-capability-first-release.json'), 'utf8'));
assert.deepEqual(scope.g08.selected.map(item => [item.capabilityId, item.adapterId]), [['play.capture', 'adapter.ui.hud']]);
const types = [...new Set([...scope.corpus.flatMap(item => item.componentTypes), 'haiyue.script.binding', 'haiyue.physics.world.2d', 'haiyue.physics.rigidbody.2d'])].sort();
const registry = new ComponentRegistry(), reviewed = types.map(type => {
  const definition = registry.get(type, '1.0.0'); assert.ok(definition.runtimeAdapter);
  return { type, version: definition.version, adapterId: definition.runtimeAdapter, capabilityId: definition.capability, effect: definition.effect, schemaDigest: digest(JSON.stringify(definition.valueSchema)) };
});
const groups = [
  ['document', ['packages/editor-plugins/test/g05-document-v2.test.mjs', 'packages/editor-plugins/test/g08-render-asset-components.test.mjs']],
  ['runtime', ['packages/script-preview/test/script-preview.test.mjs', 'packages/script-preview/test/behavior-runtime.test.mjs', 'apps/ai-studio/test/declarative-play-components.test.mjs', 'apps/ai-studio/test/logic-declarative-play.test.mjs', 'apps/ai-studio/test/logic-behavior-ipc.test.mjs', 'apps/ai-studio/test/play-simulation.test.mjs', 'apps/ai-studio/test/g07-physics-runtime.test.mjs', 'apps/ai-studio/test/g08-render-effects-runtime.test.mjs', 'apps/ai-studio/test/preview-asset-transfer.test.mjs']],
  ['tools', ['packages/game-authoring-tools/test/runtime.test.mjs', 'packages/game-authoring-tools/test/transactions.test.mjs', 'packages/game-authoring-tools/test/behavior-tools.test.mjs', 'packages/game-authoring-tools/test/g08-semantic-tools.test.mjs']],
  ['device', ['apps/ai-studio/test/m14-g08-adapter-review/adapter-device.test.mjs', 'apps/ai-studio/test/g09-multi-script-electron.test.mjs', 'apps/ai-studio/test/g08-preview-asset-electron.test.mjs', 'apps/ai-studio/test/g10-observation-electron.test.mjs']],
];
const checks = [];
for (const [id, files] of groups) {
  const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], start = performance.now();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', bytes => text += bytes); child.stderr.on('data', bytes => text += bytes);
    const timer = setTimeout(() => child.kill(), 240000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, text }); });
  });
  await writeFile(new URL(`${id}.tap`, output), result.text); assert.equal(result.code, 0, result.text);
  const count = key => Number(result.text.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1]);
  for (const key of ['fail', 'skipped', 'cancelled']) assert.equal(count(key), 0); assert.ok(count('pass') > 0);
  checks.push({ id, args, passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled'), durationMs: Math.round(performance.now() - start), outputDigest: digest(result.text) });
  console.log(`[m14-g08] ${id}: ${count('pass')} passed`);
}
const artifacts = [];
for (const file of (await readdir(output)).filter(file => /^(zero-script|mixed).*\.(png|json)$/u.test(file)).sort()) {
  artifacts.push({ path: file, digest: digest(await readFile(new URL(file, output))) });
}
assert.equal((await inputBinding(await collectPackages())).digest, before.digest, 'Sources changed during G08 verification');
await writeFile(new URL('checks.json', output), JSON.stringify({ schemaVersion: 1, status: 'passed', goal: 'g08-advanced-engine-runtime-adapters', verifiedAt: new Date().toISOString(), inputDigest: before.digest, productIntegrated: false, newAdapters: 0, repairedExistingBlockers: scope.g08.selected, reviewed, packages, checks, artifacts, limits: { hardwareDeviceLossTested: false, lossEventInjectionIsRegressionOnly: true, audioSourcePlaybackIsNotAdmitted: true } }, null, 2) + '\n');
console.log(`[m14-g08] ${before.digest}`);
