import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.env.HAIYUE_HISTORY_UI_ROOT;
if (!root) throw new Error('HAIYUE_HISTORY_UI_ROOT is required.');
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();
let finished = false;
const deadline = setTimeout(() => finish(1, 'History window timed out.'), 45_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 540, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  window.webContents.on('render-process-gone', (_event, details) => finish(1, JSON.stringify(details)));
  await window.loadFile(path.join(root, 'index.html'));
  await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const poll=()=>{if(document.body.dataset.historyStatus==='passed')resolve();else if(document.body.dataset.historyStatus==='failed')reject(new Error(document.body.dataset.historyError));else setTimeout(poll,40);};poll();})`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise(resolve => setTimeout(resolve, 100));
  const screenshot = await window.webContents.capturePage();
  if (screenshot.isEmpty()) throw new Error('History screenshot is empty.');
  await writeFile(path.join(root, 'project-history.png'), screenshot.toPNG());
  finish(0, 'history: expanded, paged, project-isolated');
}).catch(cause => finish(1, cause instanceof Error ? cause.stack : String(cause)));
function finish(code, message) { if (finished) return; finished = true; clearTimeout(deadline); console.log(message); app.exit(code); }
