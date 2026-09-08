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
  const evaluate = code => window.webContents.executeJavaScript(`(async()=>{const {panel,get,assert,intents,idle,query,select,action,update}=window.resourceTest;${code}})()`);
  const update = async data => evaluate(`update(${JSON.stringify(data)});await idle();`);
  const screenshot = async name => { await evaluate('await idle();'); await writeFile(path.join(directory, name), (await window.webContents.capturePage()).toPNG()); };
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
    await evaluate(`assert(window.resourceTest.data.total===${count * 2 + (count === 1000 ? 200 : 0)},'real entity/script total');assert(get('list').querySelectorAll('button').length<=25,'bounded DOM');assert(!panel.root.querySelector('img'),'project text never HTML');`);
    if (!count) await evaluate(`assert(get('list').textContent.includes('没有匹配资源'),'empty project');`);
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
  for (const name of ['项目资源', '搜索资源', '分类', '种类', '状态', '导入项目资源', '资源列表']) assert.ok(names.includes(name), `AX name ${name}`);
  await writeFile(path.join(directory, 'accessibility.json'), JSON.stringify(tree, null, 2)); window.webContents.debugger.detach();
  await evaluate(`get('list').querySelector('button').focus();`);
  const key = keyCode => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
  key('Enter'); await evaluate(`await idle();assert(document.activeElement?.dataset.resourceEntry,'native keyboard selection retains focus');`);
  key('Tab'); await evaluate(`assert(panel.root.contains(document.activeElement),'Tab stays in usable panel controls');`);
  window.setContentSize(375, 850);
  await evaluate(`await idle();assert(document.documentElement.scrollWidth<=innerWidth,'375px layout fits');`);
  await screenshot('resource-narrow.png');
  await evaluate(`const old=window.resourceTest.data;let reject;window.resourceTest.setBlock(new Promise((_, fail)=>reject=fail));get('refresh').click();await Promise.resolve();await Promise.resolve();assert(get('cancel').disabled===false,'cancel during pending action');update({...old,projectKey:'switched-project',viewToken:'new-token',items:[],total:0});reject(Error('SECRET_CANARY late failure'));await Promise.resolve();await Promise.resolve();assert(!panel.root.textContent.includes('SECRET_CANARY'),'late failure redacted');window.resourceTest.setBlock(null);panel.dispose();panel.dispose();assert(!document.querySelector('.resource-explorer'),'idempotent panel teardown');`);
  await writeFile(path.join(directory, 'verification.json'), JSON.stringify({ schemaVersion: 1, scope: 'isolated-real-resource-module', productIntegrated: false, entityCounts: [0, 1, 100, 1000], scripts: 200, sandbox: true, axTree: 'accessibility.json', keyboard: true, narrowWidth: 375, cases: ['light-template-create', 'light-instance-inspect-locate', 'environment-asset-assign', 'proven-use-location', 'reopen', 'file-digest', 'import-failure', 'missing-file', 'unsupported-preset', 'pagination', 'search', 'literal-long-name', 'late-result', 'dispose'], screenshots: ['resource-desktop.png', 'resource-missing.png', 'resource-narrow.png'] }, null, 2));
  await finish(0, 'G06 resource module passed real workflows, UI, accessibility and lifecycle');
}).catch(error => finish(1, error.stack ?? String(error)));
async function finish(code, message) {
  if (finishing) return; finishing = true; clearTimeout(deadline); console.log(message);
  ipcMain.removeHandler('g06-resource-current'); ipcMain.removeHandler('g06-resource-intent');
  try { await controller?.close(); } catch (error) { console.error(error); code = 1; }
  window?.destroy(); app.exit(code);
}
