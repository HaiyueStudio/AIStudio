import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.env.HAIYUE_PREVIEW_UI_ROOT;
app.setPath('userData', path.join(root, 'user-data'));
app.whenReady().then(async () => {
try {
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.join(root, 'index.html'));
  console.log('[preview-ui] loaded');
  win.showInactive();
  const agent = await win.webContents.executeJavaScript('window.previewUiFixture("agent")');
  await new Promise(resolve => setTimeout(resolve, 100));
  await writeFile(path.join(root, 'agent-preview.png'), (await win.webContents.capturePage()).toPNG());
  const manual = await win.webContents.executeJavaScript('window.previewUiFixture("manual")');
  const handoff = await win.webContents.executeJavaScript('window.previewApprovalFixture("agent")');
  await writeFile(path.join(root, 'approval-return.png'), (await win.webContents.capturePage()).toPNG());
  const manualHandoff = await win.webContents.executeJavaScript('window.previewApprovalFixture("manual")');
  const refreshFailure = await win.webContents.executeJavaScript('window.previewApprovalFixture("agent", true)');
  const exits = {};
  for (const [name, mode, outcome] of [['stale','agent','stale'], ['delayed','agent','delayed'], ['waiting','waiting','stale'], ['manual','manual','stale'], ['missing','missing-coordinates','stale']]) {
    exits[name] = await win.webContents.executeJavaScript(`window.previewExitFixture(${JSON.stringify(mode)}, ${JSON.stringify(outcome)})`);
  }
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ agent, manual, handoff, manualHandoff, refreshFailure, exits }, null, 2));
  app.exit(0);
} catch (error) { console.error(error); app.exit(1); }

}).catch(error => { console.error(error); app.exit(1); });
