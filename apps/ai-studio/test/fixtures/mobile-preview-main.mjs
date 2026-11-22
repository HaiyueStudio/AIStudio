import {app} from 'electron';
import assert from 'node:assert/strict';
import {withMobilePreview,loadFixtureGame} from './mobile-preview-harness.mjs';
const root=process.env.HAIYUE_MOBILE_ROOT,output=process.env.HAIYUE_MOBILE_OUTPUT;
const deadline=setTimeout(()=>{console.error('Native mobile preview deadline');app.exit(1);},65000);
app.setPath('userData',root+'/electron-user');
app.whenReady().then(async()=>{try{
 const game=await loadFixtureGame(root+'/game.json');
 await withMobilePreview({root,game,output},async({window,inspect,mouse,click,rectangle,frame,evaluate,wait})=>{
  const x=rectangle.x+rectangle.width/2,y=rectangle.y+rectangle.height/2;
  const samples=[];
  for(const [first,second] of [['left','right'],['right','left']]){
   await mouse('mouseMove',first,x,y);await mouse('mouseDown',first,x,y);
   await mouse('mouseDown',second,x,y,['leftButtonDown','rightButtonDown']);
   await mouse('mouseUp',first,x,y,[second==='left'?'leftButtonDown':'rightButtonDown']);await mouse('mouseUp',second,x,y);
   const sample=await inspect(),edges=sample.gameplay.find(o=>o.id==='native-buttons').value.edges.filter(e=>e.phase!=='move').slice(-4);
   assert.deepEqual(edges.map(e=>[e.phase,e.button]),[['down',first==='left'?0:2],['down',second==='left'?0:2],['up',first==='left'?0:2],['up',second==='left'?0:2]]);samples.push(edges);
  }
  await click('left',x,y);const sample=await inspect();assert.equal(sample.runtimeErrorCount,0);
  const native=await frame.executeJavaScript('window.nativePointers');
  assert.ok(native.some(e=>e.type==='pointermove'&&e.button===2&&e.buttons===3&&e.isTrusted));
  assert.ok(native.some(e=>e.type==='pointermove'&&e.button===0&&e.buttons===3&&e.isTrusted));
  // Keep Chromium's trusted touch dispatch/capture, exposing Safari-sized ids at the DOM seam.
  await frame.executeJavaScript(`(()=>{
   const descriptor=Object.getOwnPropertyDescriptor(PointerEvent.prototype,'pointerId'),canvas=document.querySelector('canvas'),capture=canvas.setPointerCapture.bind(canvas),offset=2000000000;
   window.restorePointerIds=()=>{Object.defineProperty(PointerEvent.prototype,'pointerId',descriptor);canvas.setPointerCapture=capture;};
   Object.defineProperty(PointerEvent.prototype,'pointerId',{configurable:true,get(){const id=descriptor.get.call(this);return this.pointerType==='touch'?id+offset:id;}});
   canvas.setPointerCapture=id=>capture(id>=offset?id-offset:id);
   window.nativeTouch=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])canvas.addEventListener(type,e=>{if(e.pointerType==='touch')window.nativeTouch.push({type,pointerId:e.pointerId,trusted:e.isTrusted});});
  })()`);
  await window.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const touch=async(type,points)=>{await window.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:2,radiusY:2,force:1}))});await new Promise(resolve=>setTimeout(resolve,80));};
  await touch('touchStart',[[0,x,y]]);
  assert.equal(await evaluate(`document.body.dataset.game`),'playing',await evaluate(`document.querySelector('#mobile-status').textContent`));
  await touch('touchMove',[[0,x+20,y+20]]);await touch('touchEnd',[]);
  const touchState=await inspect(),touchEdges=touchState.gameplay.find(o=>o.id==='native-buttons').value.edges.slice(-3);
  assert.deepEqual(touchEdges.map(e=>e.phase),['down','move','up']);assert.ok(touchEdges.every(e=>e.pointerId===1));
  await touch('touchStart',[[0,x,y]]);await touch('touchStart',[[0,x,y],[1,x+50,y+50]]);
  const multiple=await inspect(),held=multiple.input.pointers.filter(p=>p.buttons.length);assert.equal(held.length,2);assert.equal(new Set(held.map(p=>p.pointerId)).size,2);assert.ok(held.every(p=>p.pointerId<=1000000));
  await touch('touchCancel',[]);const cancelled=await inspect();assert.equal(cancelled.runtimeErrorCount,0);assert.ok(cancelled.input.pointers.every(p=>!p.buttons.length));
  const nativeTouch=await frame.executeJavaScript('window.nativeTouch');assert.ok(nativeTouch.some(e=>e.pointerId>1000000&&e.trusted));assert.ok(nativeTouch.some(e=>e.type==='pointercancel'));
  assert.equal(await frame.executeJavaScript(`getComputedStyle(document.querySelector('canvas')).touchAction`),'none');
  await frame.executeJavaScript('window.restorePointerIds()');await window.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:false});
  await click('left',x,y);assert.equal((await inspect()).runtimeErrorCount,0);assert.equal(await evaluate(`document.body.dataset.game`),'playing');
  const viewportSamples=[];
  for(const [width,height]of [[393,852],[852,393],[430,740],[430,932]]){
   await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
   await wait(`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return Math.abs(r.width-${width})<=1&&Math.abs(r.height-${height})<=1&&r.x===0&&r.y===0;})()`,'phone viewport fills available screen');
   await frame.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+3000;const poll=()=>innerWidth===${width}&&innerHeight===${height}?resolve(true):Date.now()>end?reject(Error('Runtime viewport did not resize')):setTimeout(poll,20);poll();})`);
   const size=await frame.executeJavaScript(`({width:innerWidth,height:innerHeight,canvasWidth:document.querySelector('canvas').clientWidth,canvasHeight:document.querySelector('canvas').clientHeight})`);
   assert.equal(size.width,width);assert.equal(size.height,height);assert.equal(size.canvasWidth,width);assert.equal(size.canvasHeight,height);
   assert.equal((await inspect()).runtimeErrorCount,0);assert.equal(await evaluate(`document.body.dataset.game`),'playing');viewportSamples.push(size);
  }
  await evaluate(`document.querySelector('#mobile-restart').click()`);await wait(`document.body.dataset.game==='playing'`,'restart');
  // Read from the restarted frame, not the destroyed previous realm.
  const restarted=await inspect();assert.equal(restarted.runtimeErrorCount,0);
  return {samples,nativePointers:native,nativeTouch,safariTouch:true,viewportSamples,ordinaryClick:true,restarted:true};
 });clearTimeout(deadline);console.log('Native HTTPS mobile player and trusted mouse chord passed');app.exit(0);
}catch(cause){console.error(cause);app.exit(1);}}).catch(cause=>{console.error(cause);app.exit(1);});
