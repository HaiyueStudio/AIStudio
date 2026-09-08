import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';
import { BehaviorReadService, instrumentBehaviorScripts, createBehaviorRuntimePlan, BehaviorRuntimeRecorder, sealBehaviorRuntimeCapture } from '@haiyue/ai-studio-script-preview';
import { declarativeInput, makeInput } from '../../../packages/script-preview/test/behavior-fixtures.mjs';

test('logic panel operates on real G02 structure, explanation and executed trace in a sandboxed window', { timeout: 60000 }, async t => {
  const reader = new BehaviorReadService(); t.after(() => reader.dispose());
  const input = declarativeInput('async function a() { return 1; } async function b() { return 2; } async function run() { await Promise.all([a(), b()]); return 3; } return run();');
  const manifest = await reader.analyze(input), program = instrumentBehaviorScripts(input, manifest)[0];
  const explanation = reader.explain({ schemaVersion: 1, manifestDigest: manifest.digest, sourceBindingDigest: manifest.binding.digest, nodeIds: [manifest.nodes[0].id], language: 'zh-CN' });
  const plan = createBehaviorRuntimePlan(input, manifest, { playId: 'play:panel', generation: 1, scripts: [{ scriptId: program.scriptId, emittedText: program.originalEmittedText }] });
  const recorder = new BehaviorRuntimeRecorder(plan); recorder.beginTick(1, 0);
  await recorder.compiler(() => program.scriptId)(program.originalEmittedText, { component: {}, sourceUrl: 'panel.js' })(null,null,null,1,1,null,{});
  const trace = sealBehaviorRuntimeCapture(plan, manifest, recorder.snapshot(), { id: 'observation:panel', taskId: 'task:panel', turnId: 'turn:panel', capturedAt: '2026-09-07T00:00:00Z', viewport: null, device: null, producerVersion: '0.0.0' }).artifact;
  const large = await reader.analyze(makeInput({ script: 'Math.sin(time);\n'.repeat(120) }));
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-m14-logic-panel-'));
  await writeFile(path.join(directory, 'logic-fixture.generated.json'), JSON.stringify({ manifest, explanation, trace, large }));
  await build({ entryPoints: [fileURLToPath(new URL('./logic-panel-browser.mjs', import.meta.url))], outfile: path.join(directory, 'panel.js'), bundle: true, platform: 'browser', format: 'esm', plugins: [{ name: 'fixture', setup(build) { build.onResolve({ filter: /logic-fixture\.generated\.json$/ }, () => ({ path: path.join(directory, 'logic-fixture.generated.json') })); } }] });
  await copyFile(new URL('../renderer/styles.css', import.meta.url), path.join(directory, 'styles.css'));
  await writeFile(path.join(directory, 'host.html'), '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="styles.css"></head><body style="margin:0;overflow:auto"><main id="host" style="padding:12px"></main><script type="module" src="panel.js"></script></body></html>');
  const result = await new Promise((resolve,reject) => {
    const env = { ...process.env, HAIYUE_LOGIC_PANEL_ROOT: directory }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [fileURLToPath(new URL('./logic-panel-main.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = ''; const timeout = setTimeout(() => { child.kill(); reject(Error(output)); }, 45000);
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    child.once('error', error => { clearTimeout(timeout); reject(error); }); child.once('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output + '\nArtifacts: ' + directory);
  console.log('M14 logic panel evidence: ' + directory);
});
