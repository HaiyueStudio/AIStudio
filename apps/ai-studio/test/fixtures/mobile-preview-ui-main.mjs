import {app,BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.env.HAIYUE_MOBILE_QR_ROOT,output=process.env.HAIYUE_MOBILE_QR_OUTPUT;app.setPath('userData',path.join(root,'user'));
app.whenReady().then(async()=>{try{
 const window=new BrowserWindow({show:false,width:900,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadFile(path.join(root,'index.html'));
 const run=code=>window.webContents.executeJavaScript(code,true);
 const button=await run(`(()=>{const b=document.querySelector('#play-share'),t=b.closest('hy-tooltip');return {text:b.textContent,svg:!!b.querySelector('svg'),label:b.getAttribute('aria-label'),tooltip:t.label,delay:t.delay,title:b.hasAttribute('title')};})()`);
 assert.deepEqual(button,{text:'',svg:true,label:'扫码运行',tooltip:'扫码运行',delay:1000,title:false});
 await run(`document.activeElement?.blur();const t=document.querySelector('#play-share').closest('hy-tooltip');t.dispatchEvent(new PointerEvent('pointerleave'));t.dispatchEvent(new PointerEvent('pointerenter'));`);
 await new Promise(resolve=>setTimeout(resolve,800));assert.equal(await run(`document.querySelector('hy-tooltip').shadowRoot.querySelector('[role=tooltip]').classList.contains('visible')`),false);
 await new Promise(resolve=>setTimeout(resolve,300));assert.equal(await run(`document.querySelector('hy-tooltip').shadowRoot.querySelector('[role=tooltip]').classList.contains('visible')`),true);
 await writeFile(path.join(output,'share-icon.png'),(await window.webContents.capturePage()).toPNG());await run(`document.querySelector('hy-tooltip').dispatchEvent(new PointerEvent('pointerleave'))`);
 assert.equal(await run('fixture.calls.length'),0);await run('fixture.open()');
 const qr=await run('fixture.qr()');assert.equal(qr.status,'ready');assert.ok(qr.svg);assert.equal(qr.value,await run('fixture.info.urls[0].url'));
 // Count encoded modules from SVG path commands, without reaching into library internals.
 qr.modules=await run(`document.querySelector('hy-qr-code').shadowRoot.querySelector('path')?.getAttribute('d')?.split('M').length??0`);assert.ok(qr.modules>20);
 await writeFile(path.join(output,'qr-dialog.png'),(await window.webContents.capturePage()).toPNG());
 await run(`document.querySelector('select').value='1';document.querySelector('select').dispatchEvent(new Event('change'));`);assert.equal((await run('fixture.qr()')).value,await run('fixture.info.urls[1].url'));
 await run('fixture.close()');assert.equal(await run(`fixture.calls.filter(c=>c.method==='preview/share-stop').length`),0);
 await run(`fixture.mode('stale');fixture.open()`);assert.equal((await run('fixture.qr()')).value,'');await run('fixture.close()');
 await run(`fixture.mode('pending');fixture.open()`);await run('fixture.close()');assert.equal(await run('fixture.pending.signal.aborted'),true);assert.equal(await run(`document.querySelector('#play-share').disabled`),false);
 await run('fixture.pending.resolve(fixture.info);fixture.settle()');assert.equal((await run('fixture.qr()')).value,'');
 await run(`fixture.mode('normal');fixture.open()`);assert.equal((await run('fixture.qr()')).status,'ready');
 await run('fixture.stopGame()');assert.equal(await run(`document.querySelector('#play-share').disabled`),true);assert.equal((await run('fixture.qr()')).value,'');
 await run('fixture.dispose()');assert.equal(await run(`document.querySelector('hy-dialog')===null`),true);
 await writeFile(path.join(output,'result.json'),JSON.stringify({qr:{status:qr.status,modules:qr.modules,svg:qr.svg},iconOnly:true,tooltipDelayMs:1000,cancelled:true,staleCleared:true,noAutomaticStart:true},null,2));console.log('Production QR dialog lifecycle passed');app.exit(0);
}catch(cause){console.error(cause);app.exit(1);}});
