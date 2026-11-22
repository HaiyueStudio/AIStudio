import {app,BrowserWindow} from 'electron';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {X509Certificate,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import path from 'node:path';
import {MobilePreviewServer} from '../../dist/mobile-preview-server.js';

// This fixture trusts only a leaf signed by its ephemeral test CA, in this session.
// It never changes an OS trust store or disables certificate checks globally.
export async function withMobilePreview({root,game,output},work){
 app.setPath('userData',path.join(root,'electron-user'));await app.whenReady();await mkdir(output,{recursive:true});
 const key=randomBytes(32),protector={seal(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');},open(value){const data=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');}};
 const server=new MobilePreviewServer({dist:path.resolve('apps/ai-studio/dist'),certificateDirectory:path.join(root,'tls-'+randomBytes(4).toString('hex')),protector,addresses:()=>[{name:'test',address:'127.0.0.1'}],listenHost:'127.0.0.1'});
 const info=await server.start(game),authority=new X509Certificate(Buffer.from(info.certificateBase64,'base64'));
 const window=new BrowserWindow({x:-10000,y:-10000,show:false,width:600,height:800,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
 window.webContents.session.setCertificateVerifyProc((request,callback)=>{
  try{const leaf=new X509Certificate(request.certificate.data);callback(request.hostname==='127.0.0.1'&&leaf.checkIP('127.0.0.1')&&leaf.verify(authority.publicKey)&&Date.parse(leaf.validTo)>Date.now()&&Date.parse(leaf.validFrom)<Date.now()?0:-2);}catch{callback(-2);}
 });
 const messages=[];window.webContents.on('console-message',(_event,_level,message)=>{messages.push(message.slice(0,500));});
 const evaluate=code=>window.webContents.executeJavaScript(code,true);
 const wait=async(code,label)=>{const until=Date.now()+20000;for(;;){const result=await evaluate(code);if(result)return result;if(Date.now()>until)throw Error(label+': '+await evaluate(`JSON.stringify({game:document.body.dataset.game,status:document.querySelector('#mobile-status')?.textContent,messages:window.testMessages??[]})`)+': '+JSON.stringify(messages.slice(-8)));await new Promise(resolve=>setTimeout(resolve,40));}};
 const inspect=()=>evaluate(`new Promise((resolve,reject)=>{const frame=document.querySelector('iframe'),id='native-'+Math.random(),timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(Error('inspection timeout'));},5000);const listener=e=>{if(e.source!==frame.contentWindow||e.data?.protocol!=='haiyue-preview/1'||e.data.requestId!==id)return;clearTimeout(timer);window.removeEventListener('message',listener);e.data.type==='inspection'?resolve(e.data.value):reject(Error(e.data.message));};window.addEventListener('message',listener);frame.contentWindow.postMessage({protocol:'haiyue-preview/1',type:'inspect',requestId:id},'*');})`);
 let heldButtons=0;
 const mouse=async(type,button,x,y)=>{const bit=button==='left'?1:button==='right'?2:4;if(type==='mouseDown')heldButtons|=bit;else if(type==='mouseUp')heldButtons&=~bit;await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:type==='mouseMove'?'mouseMoved':type==='mouseDown'?'mousePressed':'mouseReleased',button:type==='mouseMove'?'none':button,buttons:heldButtons,x:Math.round(x),y:Math.round(y),clickCount:type==='mouseMove'?0:1});await new Promise(resolve=>setTimeout(resolve,55));};
 const click=async(button,x,y)=>{await mouse('mouseMove',button,x,y);await mouse('mouseDown',button,x,y);await mouse('mouseUp',button,x,y);};
 try{
  await window.loadURL(info.urls[0].url);window.showInactive();window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await wait(`!document.querySelector('#mobile-start').disabled`,'secure browser ready');
  const security=await evaluate(`({secure:isSecureContext,webgpu:!!navigator.gpu,bridge:typeof window.haiyueStudio})`);
  if(!security.secure||!security.webgpu||security.bridge!=='undefined')throw Error('Mobile isolation failed');
  await evaluate(`window.testMessages=[];window.addEventListener('message',e=>{if(['failed','runtime-error','started','ready'].includes(e.data?.type))window.testMessages.push({type:e.data.type,message:e.data.message});});document.querySelector('#mobile-start').click()`);await wait(`document.body.dataset.game==='playing'`,'mobile game started');
  const frame=window.webContents.mainFrame.frames.find(f=>f.url.includes('preview.html'));if(!frame)throw Error('Missing isolated runtime');
  await frame.executeJavaScript(`document.querySelector('canvas').focus();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
  await frame.executeJavaScript(`window.nativePointers=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.querySelector('canvas').addEventListener(type,e=>{window.nativePointers.push({type,button:e.button,buttons:e.buttons,isTrusted:e.isTrusted});});`);
  const rectangle=await evaluate(`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
  const result=await work({window,frame,server,evaluate,wait,inspect,mouse,click,rectangle,security});
  await writeFile(path.join(output,'mobile.png'),(await window.webContents.capturePage()).toPNG());
  const nativePointers=await window.webContents.mainFrame.frames.find(f=>f.url.includes('preview.html')).executeJavaScript('window.nativePointers??[]');
  await server.stop();await wait(`document.body.dataset.game==='stopped'`,'server revocation reaches player');
  const receipt={security,nativePointers,revoked:true,...result};await writeFile(path.join(output,'result.json'),JSON.stringify(receipt,null,2));return receipt;
 }finally{await server.dispose();window.destroy();}
}

export async function loadFixtureGame(file){return JSON.parse(await readFile(file,'utf8'));}
