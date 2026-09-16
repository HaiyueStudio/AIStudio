import { app, BrowserWindow, protocol } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BrowserWindowPreviewControl } from './g12-browser-window-preview-control.mjs';
const root=process.env.HAIYUE_MATERIAL_TEST_ROOT,previewRoot=path.resolve('apps/ai-studio/dist');
app.setPath('userData',path.join(root,'data'));
protocol.registerSchemesAsPrivileged([{scheme:'haiyue-preview',privileges:{standard:true,secure:true,supportFetchAPI:false,corsEnabled:true}}]);
app.whenReady().then(async()=>{
 const window=new BrowserWindow({width:660,height:1030,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
 window.webContents.on('console-message',d=>console.log('[alpha-window]',d.message));
 window.webContents.session.protocol.handle('haiyue-preview',async request=>{const file=path.resolve(previewRoot,new URL(request.url).pathname.slice(1));if(!file.startsWith(previewRoot+path.sep))return new Response('Forbidden',{status:403});return new Response(new Uint8Array(await readFile(file)),{headers:{'content-type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript'}})});
 await window.loadFile(path.join(root,'host.html')); window.showInactive();
 const control=new BrowserWindowPreviewControl(window);await control.ready();
 const results=[];
 for(const options of [{alpha:.01},{alpha:0},{alpha:1},{alpha:.01,policy:{blending:'none'}},{alpha:.5,policy:{blending:'normal',depthWrite:false}}]) {
  const {scene,plan}=await window.webContents.executeJavaScript(`window.transparencyTest.prepare(${JSON.stringify(options)})`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const authorImage=await window.webContents.capturePage({x:0,y:480,width:640,height:480});
  const author=await window.webContents.executeJavaScript(`window.transparencyTest.pixel(${JSON.stringify(authorImage.toPNG().toString('base64'))})`);
  await window.webContents.executeJavaScript('window.transparencyTest.dispose()');
  await control.start(scene,plan);
  let capture;for(let i=0;i<600;i++){try{await control.step(1);capture=await control.capture();if(capture.byteLength>1000)break;}catch(error){if(!/No rendered Play frame/.test(error.message))throw error;}await new Promise(r=>setTimeout(r,40));}
  assert.ok(capture?.byteLength>1000);
  const preview=await window.webContents.executeJavaScript(`window.transparencyTest.pixel(${JSON.stringify(capture.base64)})`);
  const result={options,author,preview};console.log(JSON.stringify(result));results.push(result);
  assert.ok(author.every((v,i)=>Math.abs(v-preview[i])<=3),JSON.stringify(result));
  for(const pixels of [author,preview]) {
   if(options.alpha===1||options.policy?.blending==='none')assert.ok(pixels[0]<8,JSON.stringify(result));
   else if(options.alpha<.02)assert.ok(pixels[0]>230,JSON.stringify(result));
   else assert.ok(pixels[0]>80&&pixels[0]<230,JSON.stringify(result));
  }
  await writeFile(path.join(root,`alpha-${results.length}.png`),Buffer.from(capture.base64,'base64'));
  await control.stop();
 }
 await writeFile(path.join(root,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({root,passed:results.length}));window.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
