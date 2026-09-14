import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createResourceTestController } from './controller.mjs';

const directory = process.env.HAIYUE_RESOURCE_TEST_ROOT;
app.setPath('userData', path.join(directory, 'user-data'));
let window, controller, finishing = false;
const deadline = setTimeout(() => finish(1, 'Resource module deadline exceeded'), 95000);
app.whenReady().then(async () => {
  controller = await createResourceTestController();
  window = new BrowserWindow({ width: 1060, height: 940, show: false, webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
  const sender = event => { assert.equal(event.sender, window.webContents); assert.equal(event.senderFrame, window.webContents.mainFrame); };
  ipcMain.handle('g06-resource-current', event => { sender(event); return controller.display(); });
  ipcMain.handle('g06-resource-intent', async (event, input) => { sender(event); return controller.dispatch(input); });
  await window.loadFile(path.join(directory, 'host.html'));
  const evaluate = code => window.webContents.executeJavaScript(`(async()=>{const {panel,get,assert,intents,idle,query,tab,select,action,update}=window.resourceTest;${code}})()`);
  const update = async data => evaluate(`update(${JSON.stringify(data)});await idle();`);
  const screenshot = async name => { await evaluate('await idle();'); await writeFile(path.join(directory, name), (await window.webContents.capturePage()).toPNG()); };
  await evaluate(`assert(JSON.stringify(get('tabs').options.map(o=>o.label))===JSON.stringify(['几何体','纹理','材质','脚本','模型']),'five primary tabs in requested order');assert(get('tabs').value==='Geometry','default geometry tab');assert(window.resourceTest.data.items.every(item=>item.entry.category==='Geometry'),'initial query matches tab');assert(!get('more').open && get('import').hidden,'compact initial controls');
    for(const category of ['Texture','Material','Script','Model','Geometry']) { await tab(category);assert(intents.at(-1).query.category===category && !intents.at(-1).query.cursor,'tab queries category at first page');assert(window.resourceTest.data.items.every(item=>item.entry.category===category),'server filtered tab results');assert(get('content').slot===category,'active content in tab panel');assert(get('detail').hidden,'selection clears across tabs'); }
    await tab('Texture');assert(get('import').textContent==='导入纹理' && get('import-kind').value==='texture','texture import context');await tab('Model');assert(get('import').textContent==='导入模型' && get('import-kind').value==='model','model import context');
    await query('kind','asset');get('unused').checked=true;await tab('Geometry');assert(!intents.at(-1).query.kind && !intents.at(-1).query.unused,'tab clears incompatible filters');
    get('tabs').shadowRoot.querySelector('[data-value="Geometry"]').focus();`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await evaluate(`await idle();assert(get('tabs').value==='Texture','native arrow key switches tab');assert(get('tabs').shadowRoot.activeElement?.dataset.value==='Texture','tab keyboard focus retained');await tab('Geometry');`);
  await screenshot('resource-tabs-desktop.png');
  window.setContentSize(375, 850);
  await evaluate(`await idle();assert(document.documentElement.scrollWidth<=innerWidth,'five tabs fit narrow panel');const tabs=get('tabs').shadowRoot.querySelector('[role="tablist"]');assert(tabs.scrollWidth<=tabs.clientWidth,'all five tabs visible without horizontal overflow');assert(get('list').getBoundingClientRect().top<300,'resources visible near top');`);
  await screenshot('resource-tabs-narrow.png');
  window.setContentSize(206, 850);
  await evaluate(`await idle();const bar=get('tabs').shadowRoot.querySelector('[role="tablist"]');assert(bar.scrollWidth>bar.clientWidth,'extreme narrow tabs scroll');for(const button of bar.querySelectorAll('button'))assert(getComputedStyle(button).whiteSpace==='nowrap' && button.scrollWidth<=button.clientWidth,'tab labels stay on one line');assert(panel.root.scrollWidth<=panel.root.clientWidth,'only tab bar scrolls');get('tabs').shadowRoot.querySelector('[data-value="Geometry"]').focus();`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
  await evaluate(`await idle();assert(get('tabs').value==='Model','End selects last category');const bar=get('tabs').shadowRoot.querySelector('[role="tablist"]'),selected=bar.querySelector('[aria-selected="true"]');assert(bar.scrollLeft>0 && selected.getBoundingClientRect().right<=bar.getBoundingClientRect().right+1,'keyboard selection scrolls into view');`);
  await screenshot('resource-tabs-206.png'); window.setContentSize(1060, 940);
  await evaluate(`assert(typeof process==='undefined','renderer sandbox');await query('kind','template');await query('category','Lighting');select(item=>item.entry.ref.templateId==='haiyue.light.point');assert(!panel.root.querySelector('[data-resource-action="asset.assign"]'),'light template is not asset');`);
  const before = controller.f.workspace.gameSnapshot().entities.length;
  await evaluate(`await action('template.create');`);
  assert.equal(controller.f.workspace.gameSnapshot().entities.length, before + 1); assert.equal(controller.f.requests.at(-1).toolId, 'entity.create');
  await evaluate(`await query('kind','instance');assert(window.resourceTest.data.items.some(item=>item.entry.category==='Lighting'),'real light instance');select(item=>item.entry.ref.componentId===null);await action('instance.inspect');await action('resource.locate');`);
  assert.equal(controller.last.kind, 'location'); assert.equal(controller.last.location.target.ref.kind, 'instance');
  await evaluate(`await query('kind','asset');select(item=>item.entry.kind==='asset');get('assignment').value='texture.environment-diffuse';await action('asset.assign');`);
  assert.equal(controller.f.requests.at(-1).toolId, 'asset.assign');
  await evaluate(`assert(get('detail').textContent.includes('1 处已知使用'),'actual use count');const use=[...get('detail').querySelectorAll('button')].find(button=>button.textContent.includes('/diffuseAssetId'));assert(use,'known use field');use.click();await idle();`);
  assert.equal(controller.last.target.kind, 'component'); assert.equal(controller.last.target.field, '/diffuseAssetId');
  await screenshot('resource-desktop.png');
  await update(await controller.reopen());
  await evaluate(`assert(window.resourceTest.data.items.length===1,'same asset after reopen');select(item=>item.entry.kind==='asset');await action('asset.inspect');assert(get('detail').textContent.includes('已核验'),'file digest verified');get('import').click();await idle();assert(!get('error').hidden && get('error').textContent.includes('资源操作失败'),'real import failure visible');`);
  await update(await controller.missing());
  await evaluate(`select(item=>item.entry.kind==='asset');await action('asset.inspect');assert(get('detail').textContent.includes('文件缺失'),'missing file visible');assert(!panel.root.querySelector('[data-resource-action="asset.assign"]'),'missing file unavailable');`);
  await screenshot('resource-missing.png');
  for (const count of [0, 1, 100, 1000]) {
    await update(await controller.seed(count, count === 1000 ? 200 : 0));
    await evaluate(`await query('kind','instance');await query('category','');`);
    await evaluate(`assert(window.resourceTest.data.total===${count * 2 + (count === 1000 ? 200 : 0)},'real entity/script total');assert(get('list').querySelectorAll('button').length<=25,'bounded DOM');assert(!panel.root.querySelector('img'),'project text never HTML');`);
    if (!count) await evaluate(`assert(get('list').textContent.includes('还没有项目资源'),'empty project');`);
    if (count === 1) await evaluate(`get('list').querySelector('button').focus();`);
    if (count === 1000) {
      await evaluate(`const first=window.resourceTest.data.items[0].entry.catalogEntryId;get('kind').value='instance';get('next').click();await idle();assert(window.resourceTest.data.items[0].entry.catalogEntryId!==first,'real cursor paging');await query('category','Script');assert(window.resourceTest.data.total===200,'200 scripts searchable');select(item=>item.entry.category==='Script');await action('resource.locate');`);
      assert.equal(controller.last.location.target.kind, 'script');
    }
  }
  await evaluate(`get('search').value='not-present';get('filters').requestSubmit();await idle();assert(window.resourceTest.data.total===0,'search empty state');get('search').value='';get('filters').requestSubmit();await idle();await query('kind','preset');assert(window.resourceTest.data.items.every(item=>item.entry.status==='unavailable'),'unsupported preset');select(()=>true);assert(!panel.root.querySelector('[data-resource-action="preset.apply"]'),'no invented preset workflow');await query('kind','instance');`);
  window.webContents.debugger.attach('1.3');
  const tree = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
  const names = tree.nodes.filter(node => !node.ignored).map(node => node.name?.value);
  for (const name of ['项目资源', '搜索资源', '资源分类', '几何体', '纹理', '材质', '脚本', '模型', '更多筛选', '资源列表']) assert.ok(names.includes(name), `AX name ${name}`);
  await writeFile(path.join(directory, 'accessibility.json'), JSON.stringify(tree, null, 2)); window.webContents.debugger.detach();
  await evaluate(`get('list').querySelector('button').focus();`);
  const key = keyCode => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
  key('Enter'); await evaluate(`await idle();assert(document.activeElement?.dataset.resourceEntry,'native keyboard selection retains focus');`);
  key('Tab'); await evaluate(`assert(panel.root.contains(document.activeElement),'Tab stays in usable panel controls');`);
  window.setContentSize(375, 850);
  await evaluate(`await idle();assert(document.documentElement.scrollWidth<=innerWidth,'375px layout fits');`);
  await screenshot('resource-narrow.png');
  await evaluate(`const old=window.resourceTest.data;let reject;window.resourceTest.setBlock(new Promise((_, fail)=>reject=fail));get('tabs').shadowRoot.querySelector('[data-value=Texture]').click();await Promise.resolve();await Promise.resolve();assert(get('cancel').disabled===false,'cancel during pending action');assert(get('list').querySelectorAll('button').length===0,'pending query clears previous category items immediately');assert(get('list').textContent.includes('正在加载'),'pending query explains loading');assert(get('tabs').value==='Texture','pending category changes immediately');get('tabs').shadowRoot.querySelector('[data-value=Material]').click();await Promise.resolve();await Promise.resolve();assert(get('tabs').value==='Material','another category supersedes a pending query');assert(get('list').querySelectorAll('button').length===0,'superseded category cannot show old items');update({...old,projectKey:'switched-project',viewToken:'new-token',items:[],total:0});reject(Error('SECRET_CANARY late failure'));await Promise.resolve();await Promise.resolve();assert(!panel.root.textContent.includes('SECRET_CANARY'),'late failure redacted');window.resourceTest.setBlock(null);panel.dispose();panel.dispose();assert(!document.querySelector('.resource-explorer'),'idempotent panel teardown');`);
  await writeFile(path.join(directory, 'verification.json'), JSON.stringify({ schemaVersion: 1, scope: 'isolated-real-resource-module', productIntegrated: false, entityCounts: [0, 1, 100, 1000], scripts: 200, sandbox: true, axTree: 'accessibility.json', keyboard: true, narrowWidth: 375, cases: ['light-template-create', 'light-instance-inspect-locate', 'environment-asset-assign', 'proven-use-location', 'reopen', 'file-digest', 'import-failure', 'missing-file', 'unsupported-preset', 'pagination', 'search', 'literal-long-name', 'late-result', 'dispose'], screenshots: ['resource-desktop.png', 'resource-missing.png', 'resource-narrow.png'] }, null, 2));
  await finish(0, 'G06 resource module passed real workflows, UI, accessibility and lifecycle');
}).catch(error => finish(1, error.stack ?? String(error)));
async function finish(code, message) {
  if (finishing) return; finishing = true; clearTimeout(deadline); console.log(message);
  ipcMain.removeHandler('g06-resource-current'); ipcMain.removeHandler('g06-resource-intent');
  try { await controller?.close(); } catch (error) { console.error(error); code = 1; }
  window?.destroy(); app.exit(code);
}
