import assert from 'node:assert/strict';
import test from 'node:test';
import { IsolatedTrustedPreviewRuntime, PreviewAuthorizationService, hasDeclarativeGameplay } from '@haiyue/ai-studio-script-preview';
import { DeclarativePlayRuntime } from '../dist/declarative-play-components.js';
import { behaviorFixture, execute } from '../../../packages/game-authoring-tools/test/behavior-fixture.mjs';

test('scriptless timer/rule gameplay retains authorization, exact revision and an unchanged project', async t => {
  const f = await behaviorFixture({ declarative: true });
  let authorization, runtime;
  t.after(async () => { authorization?.dispose(); await runtime?.stop(); await f.close(); });
  const revision = () => f.workspace.snapshot().document.revision;
  await execute(f, 'entity.create', { baseRevision: revision(), kind: 'cube', material: 'basic', name: 'Visible object' });
  await execute(f, 'component.configure', { baseRevision: revision(), entityId: f.entityId, action: 'upsert', type: 'haiyue.gameplay.state', patch: { observationId: 'round', score: 0 } });
  await execute(f, 'component.configure', { baseRevision: revision(), entityId: f.entityId, action: 'upsert', type: 'haiyue.gameplay.rules', patch: { rules: [{ id: 'tick-score', once: false,
    when: { source: 'timer-event', value: 'elapsed', entityAId: '', entityBId: '', phase: 'enter' },
    actions: [{ kind: 'add-score', targetObservationId: 'round', key: '', numberValue: 1, textValue: '', booleanValue: false }],
  }] } });
  authorization = new PreviewAuthorizationService(f.projectScripts, f.validator, f.operationLog, Date.now, undefined, () => hasDeclarativeGameplay(f.workspace.gameSnapshot().components));
  runtime = new IsolatedTrustedPreviewRuntime(f.operationLog);
  const before = JSON.stringify(f.workspace.gameSnapshot()), undo = JSON.stringify(f.workspace.snapshot().history);
  const rejected = await authorization.prepare(); assert.deepEqual(rejected.scripts, []); assert.deepEqual(rejected.capabilities, []);
  assert.equal(await authorization.decide(rejected.id, false), null);
  assert.throws(() => authorization.consume('preview-grant:unapproved'));
  const plan = await authorization.prepare(), grant = await authorization.decide(plan.id, true), consumed = authorization.consume(grant.id);
  assert.throws(() => authorization.consume(grant.id), /already consumed/);
  assert.equal((await runtime.start(f.scene.snapshot(), consumed)).state, 'playing'); assert.equal(runtime.tick(1000 / 60, 1000 / 60).scriptCount, 0);
  const declarative = new DeclarativePlayRuntime(f.scene.snapshot().entities);
  let atTen;
  for (let tick = 1; tick <= 10; tick++) atTen = declarative.advance(tick);
  assert.equal(atTen.observations.find(item => item.id === 'round').value.score, 1);
  assert.ok(atTen.observations.some(item => item.id === 'rules' && item.value.firedRules.includes('tick-score')));
  assert.ok(atTen.observations.some(item => item.value.firedEvents?.includes('elapsed')));
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before); assert.equal(JSON.stringify(f.workspace.snapshot().history), undo);
  const stalePlan = await authorization.prepare(), staleGrant = await authorization.decide(stalePlan.id, true);
  await execute(f, 'entity.rename', { baseRevision: revision(), entityId: f.entityId, name: 'Changed' });
  assert.throws(() => authorization.consume(staleGrant.id), /stale|missing/);
  assert.equal(f.workspace.gameSnapshot().scripts.length, 0);
});
