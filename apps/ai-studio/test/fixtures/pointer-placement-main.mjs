import { app, BrowserWindow, protocol } from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Camera3D, Entity, SphericalTransform3D, World } from '@haiyue/engine/experimental';
import { ScriptValidationWorker } from '@haiyue/ai-studio-script-preview';
import { BrowserWindowPreviewControl } from './g12-browser-window-preview-control.mjs';

const output = process.env.HAIYUE_POINTER_OUTPUT;
if (!output) throw new Error('HAIYUE_POINTER_OUTPUT is required');
app.setPath('userData', path.join(output, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '2');
protocol.registerSchemesAsPrivileged([
  { scheme: 'pointerhost', privileges: { standard: true, secure: true } },
  { scheme: 'haiyue-preview', privileges: { standard: true, secure: true, corsEnabled: true } },
]);
const previewRoot = path.resolve(fileURLToPath(new URL('../../dist/', import.meta.url)));
const example = fileURLToPath(new URL('../../../../docs/examples/grid-placement.ts', import.meta.url));
let clicks = 0;
const results = [];

app.whenReady().then(async () => {
try {
  console.log('[pointer-placement] validating example');
  const validator = new ScriptValidationWorker();
  let validation;
  try {
    validation = await validator.validate({ scriptId: 'script:placement', textRevision: 1, sourcePath: 'scripts/grid-placement.ts', text: await readFile(example, 'utf8'), capabilities: ['scene', 'input'] });
    assert.deepEqual(validation.diagnostics, []);
  } finally { await validator.dispose(); }
  const window = new BrowserWindow({ width: 900, height: 850, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  const host = (await readFile(new URL('./g12-preview-host.html', import.meta.url), 'utf8')).replace('width:393px;height:852px;border:0', 'width:640px;height:480px;border:0;margin:23px 31px');
  window.webContents.session.protocol.handle('pointerhost', () => new Response(host, { headers: { 'content-type': 'text/html' } }));
  window.webContents.session.protocol.handle('haiyue-preview', async request => {
    const target = path.resolve(previewRoot, new URL(request.url).pathname.replace(/^\//, ''));
    if (!target.startsWith(`${previewRoot}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    return new Response(new Uint8Array(await readFile(target)), { headers: { 'content-type': target.endsWith('.html') ? 'text/html' : target.endsWith('.css') ? 'text/css' : 'text/javascript', 'access-control-allow-origin': '*' } });
  });
  await window.loadURL('pointerhost://app/host.html');
  window.webContents.debugger.attach('1.3');
  const control = new BrowserWindowPreviewControl(window);
  await control.ready();
  console.log('[pointer-placement] preview ready');
  for (const projection of ['orthographic', 'perspective']) {
    for (const pose of [{ target: { x: 0, y: 0, z: 0 }, azimuthDegrees: 0, elevationDegrees: 90 }, { target: { x: 1, y: 0, z: -1 }, azimuthDegrees: 28, elevationDegrees: 68 }]) {
      const camera = { projection, distance: 45, fovDegrees: 45, orthographicSize: 36, near: 0.01, far: 100, ...pose };
      const scene = { documentId: 'document:placement', revision: 1, camera, entities: [
        { id: 'entity:board', name: 'Board', kind: 'cube', parentId: null, order: 0, transform: { position: { x: 0, y: -0.1, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 16, y: 0.2, z: 16 } }, appearance: { material: 'basic', color: [0.3, 0.2, 0.1, 1] }, components: [{ id: 'component:pointer', type: 'haiyue.interaction.pointer', version: '1.0.0', enabled: true, value: { events: ['click'], penetrable: false, draggable: false, capturePointer: true, maxEventsPerTick: 32 } }] },
        { id: 'entity:marker', name: 'Marker', kind: 'cube', parentId: null, order: 1, transform: { position: { x: 30, y: 0, z: 30 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, appearance: { material: 'basic', color: [0.05, 0.9, 0.95, 1] } },
      ] };
      const plan = { id: 'preview-plan:placement', documentId: scene.documentId, documentRevision: 1, selection: 'all-enabled', scriptSetDigest: `sha256:${'b'.repeat(64)}`, scripts: [{ scriptId: 'script:placement', entityId: 'entity:marker', order: 0, textRevision: 1, digest: 'a'.repeat(64), capabilities: validation.capabilities, emittedText: validation.emittedText, diagnostics: [] }], capabilities: validation.capabilities, runtimeConfig: { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'haiyue-play' }, risk: 'trusted-project', diagnostics: [] };
      await control.start(scene, plan);
      console.log(`[pointer-placement] started ${projection} azimuth=${pose.azimuthDegrees}`);
      await control.step(1);
      let placements = 0;
      for (const size of [[700, 450], [460, 760]]) {
        await window.webContents.executeJavaScript(`document.querySelector('iframe').style.width='${size[0]}px';document.querySelector('iframe').style.height='${size[1]}px'`);
        await delay(100); // ResizeObserver runs in the isolated preview renderer.
        window.focus();
        window.webContents.focus();
        const previewFrame = window.webContents.mainFrame.frames.find(frame => frame.url.includes('haiyue-preview:'));
        assert.ok(previewFrame);
        await previewFrame.executeJavaScript("document.querySelector('canvas').focus()");
        await delay(100);
        await control.step(1); // Drain focus/blur transitions before the gesture.
        for (const [column, row] of [[7, 7], [0, 0], [14, 0], [0, 14], [14, 14]]) {
          const expected = [column - 7, 0, row - 7];
          const pointer = project(camera, size, expected);
          assert.ok(pointer[0] > 0 && pointer[0] < 1 && pointer[1] > 0 && pointer[1] < 1, JSON.stringify({ camera, size, pointer }));
          const x = Math.round(31 + pointer[0] * size[0]), y = Math.round(23 + pointer[1] * size[1]);
          // CDP routes trusted input into the sandboxed out-of-process iframe;
          // webContents.sendInputEvent targets the main frame's iframe element.
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
          await delay(50);
          const observation = await control.step(1);
          const placement = observation.value.gameplay.find(item => item.id === 'placement')?.value;
          assert.deepEqual(placement && { ...placement, column: placement.column + 0, row: placement.row + 0 }, { schemaVersion: 1, column, row, placements: ++placements, position: { x: expected[0], y: 0.2, z: expected[2] } }, JSON.stringify({ projection, pose, size, placement, input: observation.value.input, errors: observation.value.runtimeErrorCount }));
          assert.equal(observation.value.runtimeErrorCount, 0);
          // Verify the visible instance, not just the game's own observation.
          await previewFrame.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
          const marker = project(camera, size, [expected[0], 0.3, expected[2]]);
          const pixels = await window.webContents.capturePage({ x: Math.round(31 + marker[0] * size[0]) - 5, y: Math.round(23 + marker[1] * size[1]) - 5, width: 11, height: 11 });
          const bitmap = pixels.toBitmap();
          let cyan = 0;
          for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i] > 140 && bitmap[i + 1] > 140 && bitmap[i + 2] < 120) cyan++;
          if (cyan < 4) await writeFile(path.join(output, 'placement-failure.png'), (await window.webContents.capturePage()).toPNG());
          assert.ok(cyan >= 4, `rendered marker missing at expected point: ${JSON.stringify({ projection, size, column, row, cyan })}`);
          results.push({ projection, pose, size, column, row, cyan });
          clicks++;
        }
      }
      await control.stop();
    }
  }
  // Run real pointer drags against the public script lookup and captured interaction path.
  const dragValidator = new ScriptValidationWorker();
  let dragValidation;
  try { dragValidation = await dragValidator.validate({ scriptId: 'script:drag', textRevision: 1, sourcePath: 'scripts/drag.ts', text: await readFile(new URL('../../../../docs/examples/drag-target.ts', import.meta.url), 'utf8'), capabilities: ['read', 'scene', 'input'] }); assert.deepEqual(dragValidation.diagnostics, []); }
  finally { await dragValidator.dispose(); }
  await window.webContents.executeJavaScript("document.querySelector('iframe').style.width='640px';document.querySelector('iframe').style.height='480px'");
  const dragScene = { documentId: 'document:drag', revision: 1, camera: { projection: 'perspective', distance: 8, fovDegrees: 45, orthographicSize: 10, near: .01, far: 100, target: { x:0,y:0,z:0 }, azimuthDegrees: 0, elevationDegrees: 0 }, entities: [{ id:'entity:drag-target', name:'Different runtime name', kind:'rounded-box', parentId:null, order:0, transform:{position:{x:0,y:0,z:0},rotationDegrees:{x:0,y:0,z:0},scale:{x:2,y:2,z:2}}, appearance:{material:'basic',color:[.1,.8,.9,1]}, components:[{id:'component:drag',type:'haiyue.interaction.pointer',version:'1.0.0',enabled:true,value:{events:['down','move','drag','up','cancel','click'],penetrable:false,draggable:true,capturePointer:true,maxEventsPerTick:32}}] }] };
  const dragPlan = { id:'preview-plan:drag',documentId:dragScene.documentId,documentRevision:1,selection:'all-enabled',scriptSetDigest:`sha256:${'c'.repeat(64)}`,scripts:[{scriptId:'script:drag',entityId:'entity:drag-target',order:0,textRevision:1,digest:`sha256:${'d'.repeat(64)}`,capabilities:dragValidation.capabilities,emittedText:dragValidation.emittedText,diagnostics:[]}],capabilities:dragValidation.capabilities,runtimeConfig:{schemaVersion:1,mode:'fixed-step',tickRateHz:60,maxSubSteps:1000,seed:'haiyue-play'},risk:'trusted-project',diagnostics:[] };
  await control.start(dragScene, dragPlan); await control.step(1);
  const nativePointer = async (type, x, y) => { await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:31+x*640,y:23+y*480,...(type==='mouseMoved'?{buttons:1}:{button:'left',buttons:type==='mousePressed'?1:0,clickCount:1})}); await delay(30); return control.step(1); };
  await nativePointer('mousePressed', .5,.5);
  const moved = await nativePointer('mouseMoved', .92,.5);
  assert.ok(moved.value.state.entities[0].rotation[1] > 1, JSON.stringify(moved.value));
  assert.ok(moved.value.interactions.some(hit => hit.type==='drag' && hit.entityId==='entity:drag-target'));
  const released = await nativePointer('mouseReleased', .92,.5);
  assert.ok(released.value.interactions.some(hit => hit.type==='up' && hit.entityId==='entity:drag-target'));
  assert.equal(released.value.interactions.some(hit => hit.type==='click'), false);
  const beforeCamera = released.value.state.camera.theta;
  await nativePointer('mousePressed', .08,.08); await nativePointer('mouseMoved', .22,.12);
  const background = await nativePointer('mouseReleased', .22,.12);
  assert.notEqual(background.value.state.camera.theta, beforeCamera);
  assert.deepEqual(background.value.state.entities[0].rotation, released.value.state.entities[0].rotation);
  assert.equal(background.value.runtimeErrorCount, 0);
  // Synthetic down/move/up in one tick must still see an active drag (not the final released snapshot).
  await control.stop(); await control.start(dragScene, dragPlan);
  for (const event of [{phase:'down',x:.5,y:.5},{phase:'move',x:.92,y:.5},{phase:'up',x:.92,y:.5}]) await control.input({kind:'pointer',source:'synthetic',tick:1,pointerId:5,...event});
  const sameTick = await control.step(1);
  assert.ok(sameTick.value.interactions.some(hit=>hit.type==='drag'));
  assert.ok(sameTick.value.interactions.some(hit=>hit.type==='up'));
  assert.equal(sameTick.value.interactions.some(hit=>hit.type==='click'),false);
  assert.ok(sameTick.value.state.entities[0].rotation[1]>1);
  await control.input({kind:'pointer',source:'synthetic',tick:2,pointerId:5,phase:'down',x:.5,y:.5}); await control.step(1);
  await control.input({kind:'reset',source:'system',tick:3,reason:'blur'});
  const reset = await control.step(1); assert.ok(reset.value.interactions.some(hit=>hit.type==='cancel'));
  await control.stop();
  // A selectable child must resolve to its composite owner, not fall into camera control.
  const child = { ...dragScene.entities[0], id:'entity:face-tile', name:'Child surface', parentId:'entity:drag-target', order:1, transform:{position:{x:0,y:0,z:.55},rotationDegrees:{x:0,y:0,z:0},scale:{x:.75,y:.75,z:.05}}, appearance:{material:'basic',color:[1,.2,.1,1]}, components:[{...dragScene.entities[0].components[0],id:'component:tile-pointer'}] };
  await control.start({...dragScene,entities:[...dragScene.entities,child]},dragPlan); await control.step(1);
  const tileDown = await nativePointer('mousePressed',.5,.5);
  assert.ok(tileDown.value.interactions.some(hit=>hit.type==='down' && hit.entityId===child.id), JSON.stringify(tileDown.value.interactions));
  const beforeOrbit = tileDown.value.state.camera.theta;
  const tileMoved = await nativePointer('mouseMoved',.92,.5);
  const tileReleased = await nativePointer('mouseReleased',.92,.5);
  assert.ok(tileMoved.value.state.entities.find(item=>item.id==='entity:drag-target').rotation[1]>1);
  assert.equal(tileReleased.value.state.camera.theta,beforeOrbit);
  assert.ok(tileReleased.value.interactions.some(hit=>hit.type==='up' && hit.entityId===child.id));
  assert.equal(tileReleased.value.runtimeErrorCount,0);
  await control.stop();
  results.push({compositeChildHit:child.id,ownerRotated:true,cameraUnchanged:true});
  console.log('[pointer-placement] native object/background drags, capture outside target, same-tick gesture and blur cancellation passed');
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ clicks, results }, null, 2));
  console.log(`[pointer-placement] ${JSON.stringify({ clicks, output })}`);
  app.exit(0);
} catch (cause) { console.error(cause); app.exit(1); }
}).catch(cause => { console.error(cause); app.exit(1); });

function project(camera, size, point) {
  const world = new World('projection-oracle'), entity = new Entity('camera'), component = new Camera3D();
  component.projectionType = camera.projection; component.fov = camera.fovDegrees * Math.PI / 180;
  component.near = camera.near; component.far = camera.far; component.aspect = size[0] / size[1];
  component.orthoTop = camera.orthographicSize / 2; component.orthoBottom = -component.orthoTop;
  component.orthoRight = component.orthoTop * component.aspect; component.orthoLeft = -component.orthoRight;
  const transform = new SphericalTransform3D(); transform.setTarget(camera.target.x, camera.target.y, camera.target.z);
  transform.set(camera.distance, camera.azimuthDegrees * Math.PI / 180, Math.max(0.005, (90 - camera.elevationDegrees) * Math.PI / 180));
  entity.addComponent(transform); entity.addComponent(component); world.addEntity(entity); world.update(0, 0);
  const m = world.frameData.getCamera3D(entity, component, { width: size[0], height: size[1] }).viewProjectionMatrix;
  const w = m[3] * point[0] + m[7] * point[1] + m[11] * point[2] + m[15];
  const x = (m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12]) / w;
  const y = (m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13]) / w;
  world.destroy();
  return [(x + 1) / 2, (1 - y) / 2];
}
