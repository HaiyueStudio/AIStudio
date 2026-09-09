import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electronPath from 'electron';
import { parseGameDocumentV2 } from '@haiyue/ai-studio-editor-plugins';
import { PreviewAuthorizationService, hasDeclarativeGameplay, createBehaviorRuntimePlan } from '@haiyue/ai-studio-script-preview';
import { behaviorFixture, execute } from '../../../../packages/game-authoring-tools/test/behavior-fixture.mjs';
import { createWorkspaceBehaviorPorts } from '../../dist/behavior-adapters.js';

const output = process.env.HAIYUE_M14_G09_OUTPUT ? path.join(process.env.HAIYUE_M14_G09_OUTPUT, 'adapter-review') : fileURLToPath(new URL('./test-output/', import.meta.url));
for (const mixed of [false, true]) test(`G08 ${mixed ? 'mixed' : 'zero-script'}: authorized production iframe, provenance, runtime and teardown`, { timeout: 100000 }, async t => {
  const f = await behaviorFixture({ declarative: true, noSource: true, script: mixed ? 'if (time > 10) Math.sin(time);' : '' });
  let authorization, ports;
  t.after(async () => { authorization?.dispose(); await ports?.reader.dispose(); await f.close(); });
  const revision = () => f.workspace.snapshot().document.revision;
  const edit = async (id, args) => { const result = await execute(f, id, { baseRevision: revision(), ...args }); assert.equal(result.status, 'completed', JSON.stringify(result)); return result.value; };
  const configure = (entityId, type, patch) => edit('component.configure', { entityId, type, action: 'upsert', patch });
  const visible = await edit('entity.create', { kind: 'cube', material: 'basic', name: 'Animated marker' });
  await configure(f.entityId, 'haiyue.gameplay.state', { observationId: 'review-round', score: 0 });
  const rule = (id, source, value, score, once = false) => ({ id, once, when: { source, value, entityAId: '', entityBId: '', phase: 'enter' }, actions: [{ kind: 'add-score', targetObservationId: 'review-round', key: '', numberValue: score, textValue: '', booleanValue: false }] });
  const rules = [rule('timer-score', 'timer-event', 'elapsed', 1), rule('input-score', 'input-pressed', 'HardDrop', 10, true)];
  if (mixed) {
    await configure(f.entityId, 'haiyue.physics.world.2d', { gravity: { x: 0, y: 0 } });
    rules.push(rule('contact-score', 'trigger', 'contact', 100, true));
    for (const [name, type, trigger] of [['Trigger', 'static', true], ['Body', 'dynamic', false]]) {
      const created = await edit('entity.create', { kind: 'empty', name });
      await configure(created.entity.id, 'haiyue.physics.rigidbody.2d', { type });
      await configure(created.entity.id, 'haiyue.physics.collider.2d', { trigger, size: { x: 10, y: 10 } });
    }
    const transform = x => ({ position: { x, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
    await configure(visible.entity.id, 'haiyue.animation.transform-clips', { initialClip: 'Move', clips: [{ name: 'Move', durationTicks: 60, loop: false, from: transform(0), to: transform(6) }] });
  }
  await configure(f.entityId, 'haiyue.gameplay.rules', { rules });
  const hud = f.workspace.componentRegistry.get('haiyue.ui.hud', '1.0.0').defaults.items[0];
  await configure(f.entityId, 'haiyue.ui.hud', { items: [{ ...hud, id: 'review-score', text: 'Score {score}' }] });
  await configure(f.entityId, 'haiyue.audio.listener', { masterGain: 0.75 });
  assert.equal(f.workspace.gameSnapshot().scripts.length, mixed ? 1 : 0);
  const before = JSON.stringify(f.workspace.gameSnapshot()), history = JSON.stringify(f.workspace.snapshot().history);
  assert.deepEqual(parseGameDocumentV2(JSON.parse(before), f.workspace.componentRegistry), f.workspace.gameSnapshot());
  ports = createWorkspaceBehaviorPorts(f.workspace, f.operationLog);
  const source = await ports.readSource(new AbortController().signal), manifest = await ports.reader.analyze(source);
  authorization = new PreviewAuthorizationService(f.projectScripts, f.validator, f.operationLog, Date.now, undefined, () => hasDeclarativeGameplay(f.workspace.gameSnapshot().components));
  const denied = await authorization.prepare(); assert.equal(await authorization.decide(denied.id, false), null);
  assert.throws(() => authorization.consume('preview-grant:unapproved'));
  const kind = mixed ? 'mixed' : 'zero-script', runs = [];
  for (let i = 0; i < 4; i++) {
    const proposed = await authorization.prepare(), grant = await authorization.decide(proposed.id, true), plan = authorization.consume(grant.id);
    assert.throws(() => authorization.consume(grant.id), /already consumed/);
    runs.push({ scene: f.scene.snapshot(), plan, assets: [], behavior: createBehaviorRuntimePlan(source, manifest, { playId: `play:g08-${kind}-${i}`, generation: i + 1, scripts: plan.scripts }) });
  }
  await mkdir(output, { recursive: true });
  const input = path.join(f.directory, 'device-input.json'), userData = path.join(f.directory, 'electron');
  await writeFile(input, JSON.stringify({ kind, scriptCount: mixed ? 1 : 0, animatedId: visible.entity.id, binding: manifest.binding, manifestDigest: manifest.digest, runs }));
  const env = { ...process.env, HAIYUE_REVIEW_INPUT: input, HAIYUE_REVIEW_USER_DATA: userData, HAIYUE_REVIEW_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [fileURLToPath(new URL('./device-main.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let text = ''; child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b);
    const timer = setTimeout(() => child.kill(), 92000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, text }); });
  });
  await writeFile(path.join(output, `${kind}.log`), result.text); assert.equal(result.code, 0, result.text);
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(JSON.stringify(f.workspace.snapshot().history), history);
  const reportFile = path.join(output, `${kind}.json`), report = JSON.parse(await readFile(reportFile, 'utf8'));
  report.projectUnchanged = true; report.historyUnchanged = true;
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
});
