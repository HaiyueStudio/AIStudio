import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
const directory = process.env.HAIYUE_NOTIFICATION_TEST_ROOT;
app.setPath('userData', path.join(directory, 'user-data'));
let stage = 'ready';
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1000, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  stage = 'load'; await window.loadFile(path.join(directory, 'index.html'));
  window.showInactive();
  stage = 'assertions';
  const result = await window.webContents.executeJavaScript('window.testResult');
  if (result !== 'passed') throw new Error(JSON.stringify(result));
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  stage = 'capture';
  await writeFile(path.join(directory, 'notification-settings.png'), (await window.webContents.capturePage()).toPNG());
  console.log('[notification-ui] passed'); window.destroy(); app.exit(0);
}).catch(cause => { console.error(stage, cause); app.exit(1); });
