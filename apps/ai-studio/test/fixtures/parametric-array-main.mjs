import {app,BrowserWindow,protocol,nativeImage} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.env.HAIYUE_ARRAY_TEST_ROOT),output=path.resolve(process.env.HAIYUE_ARRAY_OUTPUT),preview=path.resolve(process.env.HAIYUE_ARRAY_PREVIEW_ROOT);
const stage=async value=>{console.log(`[array-main] ${value}`);await writeFile(path.join(root,'stage.txt'),value);};
console.log('[array-main] boot');
app.setPath('userData',path.join(root,'electron-user'));
protocol.registerSchemesAsPrivileged([{scheme:'array-test',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}},{scheme:'haiyue-preview',privileges:{standard:true,secure:true,supportFetchAPI:false,corsEnabled:true}}]);
app.whenReady().then(async()=>{
await stage('ready');
const deadline=setTimeout(()=>{console.error('Array fixture main deadline');app.exit(1);},60000);
const window=new BrowserWindow({width:800,height:600,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
for(const [scheme,base]of[['array-test',root],['haiyue-preview',preview]])window.webContents.session.protocol.handle(scheme,async request=>{try{const relative=new URL(request.url).pathname.replace(/^\//u,'')||'index.html',file=path.resolve(base,relative);if(!file.startsWith(base+path.sep))return new Response('Forbidden',{status:403});const bytes=await readFile(file),mime=file.endsWith('.html')?'text/html':file.endsWith('.json')?'application/json':file.endsWith('.css')?'text/css':'text/javascript';return new Response(bytes,{headers:{'content-type':mime}});}catch{return new Response('Not found',{status:404});}});
const waitReady=()=>window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+30000;const poll=()=>document.body.dataset.arrayStatus==='editor-ready'?resolve(window.arrayEditorState):document.body.dataset.arrayStatus==='failed'?reject(Error(document.body.dataset.arrayError)):Date.now()>end?reject(Error('Editor array timeout')):setTimeout(poll,50);poll();})`);
window.webContents.on('console-message',(_event,_level,message)=>console.log(`[array-renderer] ${message}`));
try{
 await stage('loading');await window.loadURL('array-test://app/index.html');await stage('loaded');const editor=await waitReady();await stage('editor');
 if(editor.count!==400||Math.abs(editor.sample[0].position[0]-7.7)>.001||Math.abs(editor.sample[0].position[1]+5.7)>.001)throw Error(JSON.stringify(editor));
 const image=await window.webContents.capturePage();await writeFile(path.join(output,'editor.png'),image.toPNG());
 let coloredPixels=0;const pixels=image.toBitmap();for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>50)coloredPixels++;
 if(coloredPixels<1000)throw Error(`Editor array did not render: ${coloredPixels}`);
 const loaded=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.reload();await loaded;const reloaded=await waitReady();await stage('reloaded');
 if(JSON.stringify(reloaded)!==JSON.stringify(editor))throw Error('Array changed after renderer restart');
 await writeFile(path.join(output,'reloaded.png'),(await window.webContents.capturePage()).toPNG());
 const result=await window.webContents.executeJavaScript('window.runArrayPlay()');await stage('played');
 const bytes=Buffer.from(result.capture.base64,'base64');await writeFile(path.join(output,'play.png'),bytes);
 const playPixels=nativeImage.createFromBuffer(bytes).toBitmap();let whitePixels=0;
 for(let i=0;i<playPixels.length;i+=4)if(playPixels[i]>220&&playPixels[i+1]>220&&playPixels[i+2]>220)whitePixels++;
 if(whitePixels<100)throw Error(`Play did not render the white instance after script takeover: ${whitePixels}`);
 result.capture={byteLength:result.capture.byteLength,whitePixels};
 await window.webContents.executeJavaScript('window.disposeArrayEditor()');
 await writeFile(path.join(output,'result.json'),JSON.stringify({editor,reloaded,coloredPixels,...result},null,2));
 if(result.cleanup!==0)throw Error(JSON.stringify(result));console.log('[parametric-array] editor, reload, Play and cleanup passed');app.exit(0);
}catch(cause){console.error(cause);app.exit(1);}
}).catch(cause=>{console.error(cause);app.exit(1);});
