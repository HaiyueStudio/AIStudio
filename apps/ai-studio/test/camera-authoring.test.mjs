import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Camera3D } from '@haiyue/engine/components';
import { transformPoint } from '@haiyue/ai-studio-script-preview/transforms';
import { fitDeviceCamera } from '../dist/device-camera.js';

test('device projection keeps the design area visible on portrait and landscape screens without changing desktop projection',()=>{
 for(const type of ['orthographic','perspective'])for(const aspect of [393/852,852/393,1]){
  const camera=new Camera3D({type,fov:Math.PI/4,near:.1,far:100});camera.aspect=aspect;
  camera.orthoTop=7.125;camera.orthoBottom=-7.125;camera.orthoRight=7.125*aspect;camera.orthoLeft=-7.125*aspect;
  const original=Array.from(camera.projectionMatrix);fitDeviceCamera(camera,aspect,false);assert.deepEqual(Array.from(camera.projectionMatrix),original);
  fitDeviceCamera(camera,aspect,true);
  for(const x of [-7,7])for(const y of [-7,7]){const point=transformPoint(camera.projectionMatrix,[x,y,-22]);assert.ok(Math.abs(point[0])<=1&&Math.abs(point[1])<=1,JSON.stringify({type,aspect,point}));}
 }
});

test('Play uses an active gameplay camera component and keeps the authoring camera as fallback', async () => {
  const renderer = await readFile(new URL('../src/renderer.ts', import.meta.url), 'utf8');
  const preview = await readFile(new URL('../src/preview-runtime.ts', import.meta.url), 'utf8');
  assert.match(renderer, /projectCameraFromSettings\(project\.document\.settings\)/);
  assert.match(renderer, /applyProjectCamera\(engineScene, nextCamera/);
  assert.match(renderer, /camera: sourceScene\.camera \?\? currentProjectCamera\(\)/);
  assert.match(preview, /normalizeProjectCamera\(rawScene\.camera\)/);
  assert.match(preview, /applyProjectCamera\(ownedScene, activeCamera/);
  assert.match(preview, /applyProjectCameraProjection\(ownedScene, activeCamera/);
  assert.match(preview, /configureGameplayCamera\(snapshot\.entities, ownedScene, canvas\)/);
  assert.match(preview, /ownedScene\.setCamera\(entity\)/);
  assert.match(preview, /haiyue\.camera\.follow/);
  assert.match(preview, /resizeGameplayCamera\(gameplayCamera/);
});
