import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inputBinding, collectPackages } from '../../../../scripts/m14-capability-census.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)), output = fileURLToPath(new URL('./test-output/', import.meta.url));
await mkdir(output, { recursive: true });
const binding = await inputBinding(await collectPackages());
const groups = [
  { id: 'resource-services-and-model', files: ['packages/editor-plugins/test/resources/*.test.mjs', 'packages/studio-shell/test/resources/*.test.mjs'], timeout: 90000 },
  { id: 'existing-asset-regressions', files: ['packages/editor-plugins/test/g08-render-asset-components.test.mjs', 'apps/ai-studio/test/preview-asset-transfer.test.mjs'], timeout: 60000 },
  { id: 'resource-module-window', files: ['apps/ai-studio/test/resources/panel-electron.test.mjs'], timeout: 150000 },
  { id: 'existing-preview-asset-lifecycle', files: ['apps/ai-studio/test/g08-preview-asset-electron.test.mjs'], timeout: 120000 },
];
const reports = [];
for (const group of groups) {
  const started = performance.now(), args = ['--test', '--test-concurrency=1', '--test-reporter=tap', ...group.files];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; const timeout = setTimeout(() => { child.kill(); reject(Error(`${group.id} deadline\n${text}`)); }, group.timeout);
    child.stdout.on('data', chunk => text += chunk); child.stderr.on('data', chunk => text += chunk);
    child.once('error', error => { clearTimeout(timeout); reject(error); }); child.once('exit', code => { clearTimeout(timeout); resolve({ code, text }); });
  });
  await writeFile(path.join(output, `${group.id}.tap`), result.text);
  assert.equal(result.code, 0, result.text);
  const count = key => Number(result.text.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1]);
  for (const key of ['fail', 'skipped', 'cancelled']) assert.equal(count(key), 0, `${group.id}: ${key}`);
  assert.ok(count('pass') > 0);
  if (group.id === 'resource-module-window') {
    const directory = result.text.match(/G06 resource module evidence: (.+)\r?\n/u)?.[1].trim(); assert.ok(directory);
    await mkdir(path.join(output, 'window'), { recursive: true });
    const evidence = JSON.parse(await readFile(path.join(directory, 'verification.json'), 'utf8'));
    for (const file of ['verification.json', 'accessibility.json', ...evidence.screenshots]) await copyFile(path.join(directory, file), path.join(output, 'window', file));
  }
  reports.push({ id: group.id, args, passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled'), durationMs: Math.round(performance.now() - started), output: `${group.id}.tap`, outputDigest: `sha256:${createHash('sha256').update(result.text).digest('hex')}` });
  console.log(`[g06-resources] ${group.id}: ${count('pass')} passed`);
}
assert.equal((await inputBinding(await collectPackages())).digest, binding.digest, 'Source changed during resource verification.');
await writeFile(path.join(output, 'checks.json'), JSON.stringify({ schemaVersion: 1, mode: 'user-directed-independent-g06-acceptance', inputDigest: binding.digest, environment: { node: process.version, platform: process.platform, arch: process.arch }, verifiedAt: new Date().toISOString(), productIntegrated: false, checks: reports }, null, 2) + '\n');
console.log(`[g06-resources] source ${binding.digest}; evidence ${output}`);
