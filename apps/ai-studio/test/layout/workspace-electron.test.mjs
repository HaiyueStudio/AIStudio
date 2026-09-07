import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';
import { BehaviorReadService, parseBehaviorContract } from '@haiyue/ai-studio-script-preview';
import { resourceExamples } from '../../../../packages/script-preview/test/behavior-fixtures.mjs';

test('real sandboxed workspace consumes G02 projections and preserves editor controls at desktop and narrow sizes', { timeout: 85_000 }, async t => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const output = await mkdtemp(path.join(tmpdir(), 'haiyue-m14-workspace-'));
  const service = new BehaviorReadService(); t.after(() => service.dispose());
  const corpus = JSON.parse(await readFile(new URL('../../../../config/contracts/fixtures/m14-behavior-inputs.json', import.meta.url), 'utf8'));
  const manifest = await service.analyze(corpus.mixed);
  const catalog = resourceExamples.map(entry => parseBehaviorContract('resource-catalog-entry', entry));
  await writeFile(path.join(output, 'fixtures.generated.json'), JSON.stringify({ manifest, catalog }));
  await build({ stdin: { contents: await readFile(path.join(directory, 'workspace-browser.mjs'), 'utf8'), resolveDir: directory, sourcefile: 'workspace-browser.mjs' }, outfile: path.join(output, 'app.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome132', plugins: [{ name: 'generated-contract-fixtures', setup(build) { build.onResolve({ filter: /fixtures\.generated\.json$/ }, () => ({ path: path.join(output, 'fixtures.generated.json') })); } }] });
  let html = await readFile(new URL('../../renderer/index.html', import.meta.url), 'utf8');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '').replace('</body>', '<script type="module" src="./app.js"></script></body>');
  await writeFile(path.join(output, 'host.html'), html);
  await copyFile(new URL('../../renderer/styles.css', import.meta.url), path.join(output, 'styles.css'));
  const result = await new Promise((resolve, reject) => {
    const env = { ...process.env, HAIYUE_LAYOUT_ROOT: output }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [path.join(directory, 'workspace-main.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; const deadline = setTimeout(() => { child.kill(); reject(Error('Electron layout timed out\n' + logs)); }, 65_000);
    child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
    child.once('error', error => { clearTimeout(deadline); reject(error); }); child.once('exit', code => { clearTimeout(deadline); resolve({ code, logs }); });
  });
  assert.equal(result.code, 0, result.logs + '\nArtifacts: ' + output);
  const evidence = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
  assert.deepEqual(evidence.samples.map(item => item.count), [1, 100, 1000]);
  assert.deepEqual([...new Set(evidence.locations.map(location => location.target.source.kind))].sort(), ['declarative-component', 'runtime-adapter', 'script']);
  for (const location of evidence.locations) assert.equal(service.resolveLocation(parseBehaviorContract('editor-location', location)).status, 'current');
  console.log('M14 workspace artifacts: ' + output);
});
