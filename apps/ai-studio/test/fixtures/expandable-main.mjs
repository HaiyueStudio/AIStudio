import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory = process.env.HAIYUE_EXPANDABLE_ROOT;
app.setPath('userData', path.join(directory, 'user-data'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1100, height: 860, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const evaluate = code => window.webContents.executeJavaScript(code);
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const clickToggle = async selector => {
    const point = await evaluate(`(() => {const b=document.querySelector(${JSON.stringify(selector)}).shadowRoot.querySelector('button'); const r=b.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    window.webContents.sendInputEvent({type:'mouseMove',...point});
    for (const type of ['mouseDown','mouseUp']) window.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
    await frame();
  };
  const escape = async () => { window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'}); await frame(); };
  await window.loadFile(path.join(directory,'index.html')); window.showInactive(); await frame();
  await evaluate(`(() => {
    window.mounts=0;window.unmounts=0;customElements.define('test-stateful',class extends HTMLElement { connectedCallback(){mounts++} disconnectedCallback(){unmounts++} });
    const clip=document.createElement('div');clip.id='clip';clip.style.cssText='position:absolute;top:0;left:0;width:240px;height:180px;overflow:hidden;transform:translateZ(0);z-index:5';
    const box=document.createElement('hy-expandable');box.id='generic';box.style.cssText='width:240px;height:180px';box.expandedWidth='700px';box.expandedHeight='500px';
    const content=document.createElement('test-stateful');const input=document.createElement('input');input.value='keep me';content.append(input);box.append(content);clip.append(box);document.body.append(clip);window.box=box;window.input=input;window.changes=[];box.addEventListener('expanded-change',e=>changes.push(e.detail.expanded));
  })()`); await frame();
  await clickToggle('#generic');
  assert.deepEqual(await evaluate(`(() => { const p=box.shadowRoot.querySelector('.panel'),r=p.getBoundingClientRect();return [box.expanded,p.matches(':popover-open'),getComputedStyle(p).position,Math.round(r.width),Math.round(r.height),mounts,unmounts,input.value];})()`),[true,true,'fixed',700,500,1,0,'keep me']);
  assert.equal(await evaluate(`box.shadowRoot.querySelector('button').getAttribute('aria-expanded')`),'true');
  for (const position of ['top-right','top-left','bottom-right','bottom-left']) {
    await evaluate(`box.buttonPosition=${JSON.stringify(position)}`); await frame();
    assert.equal(await evaluate(`(() => {const p=box.shadowRoot.querySelector('.panel').getBoundingClientRect(),r=box.shadowRoot.querySelector('button').getBoundingClientRect();return (r.left-p.left<p.width/2)===${position.endsWith('left')} && (r.top-p.top<p.height/2)===${position.startsWith('top')};})()`),true);
  }
  await evaluate(`const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('slot','restore-icon');box.append(icon);box.setAttribute('restore-label','恢复原尺寸');`);
  assert.equal(await evaluate(`box.shadowRoot.querySelector('slot[name="restore-icon"]').assignedElements().length`),1);
  await escape();
  assert.deepEqual(await evaluate(`[box.expanded,box.shadowRoot.querySelector('.panel').matches(':popover-open'),Math.round(box.getBoundingClientRect().height),mounts,unmounts,changes]`),[false,false,180,1,0,[true,false]]);
  assert.equal(await evaluate(`box.shadowRoot.activeElement===box.shadowRoot.querySelector('button')`),true,'Escape restores toggle focus');
  // Native keyboard activation and programmatic attribute changes use the same transition.
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});window.webContents.sendInputEvent({type:'char',keyCode:'\r'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await frame();
  assert.equal(await evaluate('box.expanded'),true);
  await clickToggle('#generic');assert.equal(await evaluate('box.expanded'),false);
  await evaluate(`box.expanded=true;box.remove();`);assert.equal(await evaluate(`box.shadowRoot.querySelector('.panel').hasAttribute('popover')`),false);
  await evaluate(`document.querySelector('#clip').append(box)`);await frame();assert.equal(await evaluate(`box.shadowRoot.querySelector('.panel').matches(':popover-open')`),true);
  await evaluate(`box.expanded=false;document.querySelector('#clip').remove();`); await frame();
  const normal = await evaluate(`document.querySelector('.execution-graph-viewport').getBoundingClientRect().height`);
  await evaluate(`window.originalViewport=document.querySelector('.execution-graph-viewport')`);
  await clickToggle('.execution-graph-expandable');
  assert.equal(await evaluate(`originalViewport===document.querySelector('.execution-graph-viewport')`),true);
  assert.ok(await evaluate(`document.querySelector('.execution-graph-viewport').getBoundingClientRect().height`) > normal);
  await writeFile(path.join(directory,'expanded.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate('showGraph()');await frame();
  assert.equal(await evaluate(`document.querySelector('hy-expandable').shadowRoot.querySelector('.panel').matches(':popover-open')`),true,'stream rerender keeps expansion');
  await evaluate(`document.querySelector('[aria-label="Zoom in execution graph"]').click()`);await frame();
  assert.equal(await evaluate(`document.querySelector('hy-expandable').expanded`),true,'toolbar rerender keeps expansion');
  for (const [width,height] of [[480,600],[1100,860]]) {
    window.setContentSize(width,height);await frame();
    assert.equal(await evaluate(`(() => {const r=document.querySelector('hy-expandable').shadowRoot.querySelector('.panel').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()`),true);
  }
  await clickToggle('.execution-graph-expandable');
  assert.equal(await evaluate(`document.querySelector('hy-expandable').expanded`),false);
  await writeFile(path.join(directory,'restored.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate('disposeGraph()');
  console.log('[expandable] component contracts and live graph integration passed'); app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
