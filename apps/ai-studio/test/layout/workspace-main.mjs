import { app, BrowserWindow, protocol } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.env.HAIYUE_LAYOUT_ROOT;
if (!root) throw Error('HAIYUE_LAYOUT_ROOT required');
app.setPath('userData', path.join(root, 'user-data'));
protocol.registerSchemesAsPrivileged([{ scheme: 'workspacetest', privileges: { standard: true, secure: true, corsEnabled: true } }]);
const deadline = setTimeout(() => finish(1, 'layout deadline exceeded'), 50_000);
let finished = false;
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
  window.webContents.session.protocol.handle('workspacetest', async request => {
    const target = path.resolve(root, '.' + new URL(request.url).pathname);
    if (!target.startsWith(path.resolve(root) + path.sep)) return new Response('Forbidden', { status: 403 });
    try { return new Response(new Uint8Array(await readFile(target)), { headers: { 'content-type': target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  const evaluate = code => window.webContents.executeJavaScript(`(async () => { const {workspace,get,assert,settle,base,intents,samples,update} = window.layoutTest; ${code} })()`);
  const waitReady = status => window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=Date.now()+15000;const poll=()=>{const s=document.body.dataset.layoutStatus;if(s==='${status}')return resolve(true);if(s==='failed'||Date.now()>until)return reject(Error(document.body.dataset.layoutError||'layout not ready: '+s));setTimeout(poll,30)};poll()})`);
  const capture = async name => writeFile(path.join(root, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  const press = keyCode => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
  await window.loadURL('workspacetest://app/host.html'); await waitReady('ready');
  const result = await evaluate(`
    const r=id=>get(id).getBoundingClientRect();
    assert(r('intent-workspace').right<=r('viewport-panel').left && r('viewport-panel').right<=r('right-sidebar').left,'desktop columns');
    assert(r('viewport-panel').height>700 && Math.abs(r('viewport-panel').height-r('intent-workspace').height)<2,'full-height viewport');
    assert(typeof process==='undefined','sandbox');
    return {samples, locations:intents.filter(i=>i.type==='workspace/locate').map(i=>i.location)};
  `);
  await capture('workspace-desktop');
  await evaluate(`workspace.setTab('resources'); get('workspace-category').value='lights';get('workspace-category').dispatchEvent(new Event('change'));await settle();`);
  await capture('workspace-resources');
  await evaluate(`get('workspace-advanced-button').focus();get('workspace-advanced-button').click();await settle();assert(get('workspace-advanced').open && get('hierarchy-panel').getBoundingClientRect().height>100,'manual drawer visible: '+JSON.stringify({open:get('workspace-advanced').open,hierarchy:get('hierarchy-panel').getBoundingClientRect().toJSON(),manual:get('left-sidebar-split').getBoundingClientRect().toJSON(),dialog:get('workspace-advanced').getBoundingClientRect().toJSON(),host:get('workspace-manual-inspect').getBoundingClientRect().toJSON()}));assert(document.activeElement===get('workspace-advanced-close'),'modal initial focus');`);
  for (let i = 0; i < 12; i++) {
    press('Tab'); await evaluate(`await settle(); assert(get('workspace-advanced').contains(document.activeElement),'native modal traps focus');`);
  }
  await capture('workspace-advanced');
  press('Escape'); await evaluate(`await settle(); assert(!get('workspace-advanced').open && document.activeElement===get('workspace-advanced-button'),'Escape closes and restores focus');workspace.openAdvanced('script');await settle();assert(!get('script-panel').hidden && get('script-source').getBoundingClientRect().height>200,'script entry reachable');`);
  await capture('workspace-script');
  press('Escape'); await evaluate(`await settle(); assert(get('script-panel').hidden,'script hidden after closing');workspace.setTab('logic');`);
  for (const width of [900, 375]) {
    window.setContentSize(width, 900);
    await evaluate(`await settle();assert(get('workspace-split').getAttribute('direction')==='vertical','narrow split orientation');assert(document.documentElement.scrollWidth<=innerWidth+1,'no page horizontal overflow');assert(get('viewport-panel').getBoundingClientRect().height>=130,'narrow viewport reachable');get('workspace-advanced-button').click();await settle();assert(get('workspace-advanced').getBoundingClientRect().right<=innerWidth,'drawer fits narrow screen');get('workspace-advanced-close').click();await settle();`);
    await capture(`workspace-${width}`);
  }
  window.setContentSize(1440, 920);
  await evaluate(`await settle();workspace.setMode('classic');await settle();const a=get('viewport-panel').getBoundingClientRect(),b=get('assets-panel').getBoundingClientRect();assert(a.bottom<=b.top,'classic stacked authoring');localStorage.setItem('layout-test-phase','reload');`);
  await capture('workspace-classic');
  await window.reload(); await waitReady('reloaded');
  await evaluate(`workspace.dispose();workspace.dispose();assert(!get('intent-workspace')&&!get('workspace-advanced'),'idempotent teardown');assert(get('viewport-panel').parentElement===get('authoring-split') && get('script-panel').hidden,'teardown restores owners');`);
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ ...result, desktop: true, narrow: [900, 375], keyboard: true, reload: true, rollback: true, teardown: true }, null, 2));
  finish(0, 'layout, provenance, keyboard, narrow, reload and rollback passed');
}).catch(error => finish(1, error.stack ?? String(error)));
function finish(code, message) { if (finished) return; finished = true; clearTimeout(deadline); console.log(`[m14-workspace] ${message}`); app.exit(code); }
