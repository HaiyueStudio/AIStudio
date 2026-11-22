import{app,BrowserWindow}from'electron';
import assert from'node:assert/strict';
import{writeFile}from'node:fs/promises';
import path from'node:path';
const root=process.env.HAIYUE_LOADING_ROOT,output=process.env.HAIYUE_LOADING_OUTPUT;app.setPath('userData',path.join(root,'user'));app.disableHardwareAcceleration();
const deadline=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});const evaluate=code=>window.webContents.executeJavaScript(code,true);
 async function wait(code){const end=Date.now()+5000;while(!await evaluate(code)){if(Date.now()>end)throw Error('Loading condition timed out: '+code);await new Promise(resolve=>setTimeout(resolve,20));}}
 try{
  await window.loadFile(path.join(root,'index.html'));await wait("document.body.dataset.ready==='true'");
  await evaluate("document.querySelector('#open-project').focus();document.querySelector('#open-project').click()");await wait('fixture.calls===1');
  assert.equal(await evaluate('fixture.painted'),true);assert.equal(await evaluate("document.querySelector('#app').inert"),true);assert.equal(await evaluate("document.querySelector('#app').getAttribute('aria-busy')"),'true');assert.equal(await evaluate("document.querySelector('#project-loading').getAttribute('role')"),'status');
  assert.equal(await evaluate('fixture.duplicate()'),true);assert.equal(await evaluate('fixture.calls'),1);
  await new Promise(resolve=>setTimeout(resolve,120));await writeFile(path.join(output,'loading.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate('fixture.resolve()');await wait('!fixture.busy');assert.equal(await evaluate("document.querySelector('#app').inert"),false);assert.equal(await evaluate("document.querySelector('#app').hasAttribute('aria-busy')"),false);assert.equal(await evaluate("document.activeElement.id"),'open-project');
  for(const [count,error]of [[2,'project-selection-cancelled'],[3,'invalid project']]){await evaluate("document.querySelector('#open-project').click()");await wait(`fixture.calls===${count}`);await evaluate(`fixture.reject(${JSON.stringify(error)})`);await wait('!fixture.busy');assert.equal(await evaluate("document.querySelector('#project-loading').hidden"),true);assert.equal(await evaluate("document.querySelector('#app').inert"),false);}
  await evaluate("document.querySelector('#open-project').click()");await wait('fixture.calls===4');await evaluate("fixture.dispose();document.querySelector('#app').setAttribute('aria-busy','late-owner');fixture.resolve()");await wait('!fixture.busy');assert.equal(await evaluate("document.querySelector('#project-loading')===null"),true);assert.equal(await evaluate("document.querySelector('#app').getAttribute('aria-busy')"),'late-owner');
  await writeFile(path.join(output,'result.json'),JSON.stringify({painted:true,oneOperation:true,cancelledRecovered:true,failureRecovered:true,teardownSafe:true},null,2));clearTimeout(deadline);window.destroy();app.exit(0);
 }catch(error){console.error(error);window.destroy();app.exit(1);}
});
