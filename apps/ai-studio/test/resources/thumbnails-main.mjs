import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { resourceFixture, execute } from '../../../../packages/editor-plugins/test/resources/fixture.mjs';
const directory=process.env.HAIYUE_RESOURCE_TEST_ROOT;
app.setPath('userData',path.join(directory,'data'));
let window,f;
app.whenReady().then(async()=>{
  f=await resourceFixture();
  for(const [kind,name,color] of [['rounded-box','圆角棋盘',[.9,.15,.08,1]],['sphere','蓝色棋子',[.1,.3,.9,1]]]) {
    const result=await execute(f,'entity.create',{baseRevision:f.workspace.gameSnapshot().revision,kind,name,material:'pbr',color}); assert.equal(result.status,'completed');
  }
  await f.importTexture('assets/thumb.png',16,8);
  const page=async query=>{
    const result=await f.page({...query,projectOnly:true});
    return {projectKey:result.binding.projectId,viewToken:result.binding.digest,state:'ready',items:result.items.map(item=>({...item,configuration:JSON.stringify(item.configuration),metadata:item.asset?[['格式',item.asset.mimeType],['文件字节',item.asset.byteLength],['解码预算',item.asset.decodedBytes],['宽度',item.asset.width],['高度',item.asset.height]].map(([label,value])=>({label,value:String(value)})):[]})),total:result.total,nextCursor:result.nextCursor,categories:result.categories,diagnostics:[],target:null};
  };
  window=new BrowserWindow({width:520,height:800,show:false,webPreferences:{preload:path.join(directory,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message', details => console.log('[thumbnail-renderer]', details.message));
  const sender=e=>assert.equal(e.sender,window.webContents);
  ipcMain.handle('query',async(e,q)=>{sender(e);return page(q)});
  ipcMain.handle('read',async(e,id)=>{sender(e);const asset=(await f.page({kind:'asset'})).items.find(row=>row.entry.ref.assetId===id)?.asset;assert.ok(asset);const bytes=await f.workspace.readControlledAsset(asset.projectPath,asset.byteLength);return {assetId:id,digest:asset.digest,mimeType:asset.mimeType,byteLength:bytes.length,base64:Buffer.from(bytes).toString('base64')};});
  await window.loadFile(path.join(directory,'host.html'));
  const until=async code=>{for(let i=0;i<300;i++){if(await window.webContents.executeJavaScript(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('Window assertion deadline');};
  await until('window.thumbnailTest?.done');
  await writeFile(path.join(directory,'textures.png'),(await window.webContents.capturePage()).toPNG());
  for(const category of ['Geometry','Material']) {await window.webContents.executeJavaScript(`window.thumbnailTest.category('${category}')`);await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');await writeFile(path.join(directory,category+'.png'),(await window.webContents.capturePage()).toPNG());}
  window.setContentSize(230,700);
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'),true);
  await window.webContents.executeJavaScript(`(()=>{const {panel,thumbnails}=window.thumbnailTest;const canvas=document.createElement('canvas'),signal=new AbortController();signal.abort();return thumbnails.render(canvas,${JSON.stringify((await page({category:'Geometry'})).items[0])},signal.signal).then(()=>{throw Error('abort ignored')},()=>{});})()`);
  await window.webContents.executeJavaScript('window.thumbnailTest.thumbnails.setProject("other-project");window.thumbnailTest.thumbnails.dispose();window.thumbnailTest.thumbnails.dispose();window.thumbnailTest.panel.dispose()');
  console.log('Thumbnail window passed: '+directory);
  await f.close();window.destroy();app.exit(0);
}).catch(async error=>{console.error(error);await f?.close();window?.destroy();app.exit(1);});
