import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { png } from '../../../../packages/editor-plugins/test/resources/fixture.mjs';
import { behaviorFixture } from '../../../../packages/game-authoring-tools/test/behavior-fixture.mjs';
import { seedResourceProject } from '../../../../packages/editor-plugins/test/resources/large-fixture.mjs';
import { scanGeneratedEvidence } from './secret-scan.mjs';

test('production window uses public resource / advanced entries, real tools, exact approvals, Gizmo History, restart and accessibility', { timeout: 360000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-m14-integrated-product-'));
  await mkdir(path.join(directory, 'project', 'assets'), { recursive: true });
  await writeFile(path.join(directory, 'project', 'assets', 'sky.png'), png(2, 1));
  const f = await behaviorFixture({ noSource: true });
  try { await seedResourceProject(f, 1000, 200); await mkdir(path.join(directory, 'large-project')); await f.workspace.saveAs(path.join(directory, 'large-project')); }
  finally { await f.close(); }
  for (const phase of ['author', 'restart', 'large']) {
    const env = { ...process.env, HAIYUE_M14_PRODUCT_DIRECTORY: directory, HAIYUE_M14_PRODUCT_PHASE: phase, HAIYUE_ELECTRON_USER_DATA: path.join(directory, 'user-data'), HAIYUE_BOOT_TRACE: path.join(directory, `${phase}-boot.log`) };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'HAIYUE_ELECTRON_SMOKE', 'HAIYUE_STUDIO_DEEPSEEK_SECRET', 'DEEPSEEK_API_KEY']) delete env[name];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electron, [fileURLToPath(new URL('./product-main.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const deadline = setTimeout(() => { child.kill(); reject(Error(`Product ${phase} timed out\n${output}\n${directory}`)); }, 120000);
      child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); child.once('error', reject);
      child.once('exit', code => { clearTimeout(deadline); resolve({ code, output }); });
    });
    await writeFile(path.join(directory, `${phase}.log`), result.output);
    const output = fileURLToPath(new URL(`./test-output/product/${phase}/`, import.meta.url)); await mkdir(output, { recursive: true });
    // Retain only generated evidence, never browser credentials or caches.
    for (const name of [`${phase}.log`, `${phase}-boot.log`, `${phase}.json`, `${phase}-renderer-state.json`, `${phase}-failure.json`, `${phase}-failure.png`, 'advanced-desktop.png', 'resources-desktop.png', 'resources-restarted.png', 'large-desktop.png', 'large-narrow.png', 'accessibility.json']) {
      await cp(path.join(directory, name), path.join(output, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    assert.equal(result.code, 0, result.output + '\nEvidence: ' + directory);
  }
  const author = JSON.parse(await readFile(path.join(directory, 'author.json'), 'utf8')), restart = JSON.parse(await readFile(path.join(directory, 'restart.json'), 'utf8'));
  assert.equal(restart.assetId, author.assetId); assert.equal(restart.entityId, author.entityId); assert.ok(author.approvals.length >= 3);
  assert.equal(author.productionEntry, 'apps/ai-studio/dist/main.js'); assert.equal(author.platformDecisionDriver, 'explicit test decisions; real tool approvals');
  const scan = await scanGeneratedEvidence(directory, [process.env.DEEPSEEK_API_KEY, process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET]);
  await writeFile(new URL('./test-output/product/secret-scan.json', import.meta.url), JSON.stringify({ ...scan, scope: ['temporary projects', 'generated app user-data including journal/artifacts and any crash dumps', 'renderer DOM and public projections', 'window evidence'] }, null, 2));
  console.log('M14 integrated product evidence: ' + directory);
});
