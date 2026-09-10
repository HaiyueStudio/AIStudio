import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectPackages, inputBinding } from './m14-capability-census.mjs';
import { scanGeneratedEvidence } from '../apps/ai-studio/test/m14-integration/secret-scan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const inventory = JSON.parse(await readFile(new URL('./m14-integration-tests.json', import.meta.url), 'utf8'));
async function files(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true }), result = [];
  for (const entry of entries) {
    if (entry.name === 'test-output') continue;
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(name));
    else if (entry.name.endsWith('.test.mjs')) result.push(name);
  }
  return result;
}
const actual = [...new Set([...inventory.extraFiles, ...(await Promise.all(inventory.directories.map(files))).flat()])].sort();
assert.deepEqual(actual, inventory.files, 'M14 test inventory changed: review the file list before accepting a test count.');
console.log(`[m14-integration] collected ${actual.length} test files; all owned nested directories checked`);
if (!process.argv.includes('--inventory')) {
  assert.equal(process.argv.length, 2, 'Use no arguments or --inventory.');
  const output = path.join(root, 'apps/ai-studio/test/m14-integration/test-output'); await mkdir(output, { recursive: true });
  const binding = await inputBinding(await collectPackages());
  const env = { ...process.env, HAIYUE_M14_G09_OUTPUT: output, HAIYUE_STUDIO_DISABLE_NOTIFICATIONS: '1' };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','DEEPSEEK_API_KEY','HAIYUE_STUDIO_DEEPSEEK_SECRET','HAIYUE_M14_ALLOW_REAL']) delete env[key];
  const results = [];
  for (const [index, file] of actual.entries()) {
    const started = Date.now(), args = ['--test','--test-reporter=tap', file];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
      let text = ''; const timer = setTimeout(() => child.kill(), 370000);
      child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, text }); });
    });
    const log = `collected-${String(index + 1).padStart(2, '0')}.tap`; await writeFile(path.join(output, log), result.text);
    const count = key => Number(result.text.match(new RegExp(`^# ${key} (\\d+)$`, 'mu'))?.[1] ?? NaN);
    results.push({ file, log, elapsedMs: Date.now()-started, exitCode: result.code, tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') });
    await writeFile(path.join(output, 'collected-tests.json'), JSON.stringify({ schemaVersion: 1, inputDigest: binding.digest, collectedFiles: actual.length, executedFiles: results.length, results }, null, 2));
    if (result.code !== 0) console.error(result.text);
    console.log(`[m14-integration] ${file}: ${count('pass')} passed / ${count('fail')} failed`);
  }
  assert.equal((await inputBinding(await collectPackages())).digest, binding.digest, 'Source changed during integration checks.');
  const scan = await scanGeneratedEvidence(output, [process.env.DEEPSEEK_API_KEY, process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET]);
  await writeFile(path.join(output, 'secret-scan.json'), JSON.stringify({ ...scan, inputDigest: binding.digest }, null, 2));
  for (const result of results) {
    assert.equal(result.exitCode, 0, `${result.file} failed`); assert.ok(result.passed > 0, `${result.file} executed no tests`);
    for (const key of ['failed','skipped','cancelled']) assert.equal(result[key], 0, `${result.file}: ${key}`);
  }
  console.log(`[m14-integration] ${results.length} files / ${results.reduce((n,r)=>n+r.passed,0)} cases passed without skips`);
}
