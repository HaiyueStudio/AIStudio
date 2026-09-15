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
  const table = await win.webContents.executeJavaScript('window.previewTableFixture()');
  await writeFile(path.join(root, 'verification-table.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(390, 844);
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  table.narrow = await win.webContents.executeJavaScript(`(() => { const panel = document.getElementById('play-agent-progress'), table = document.getElementById('play-agent-progress-table'); return table.scrollWidth <= table.clientWidth && panel.getBoundingClientRect().right <= innerWidth && panel.getBoundingClientRect().top >= document.getElementById('play-agent-notice').getBoundingClientRect().bottom; })()`);
  await writeFile(path.join(root, 'verification-table-narrow.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1100, 800);
  const manual = await win.webContents.executeJavaScript('window.previewUiFixture("manual")');
  const handoff = await win.webContents.executeJavaScript('window.previewApprovalFixture("agent")');
  await writeFile(path.join(root, 'approval-return.png'), (await win.webContents.capturePage()).toPNG());
  const manualHandoff = await win.webContents.executeJavaScript('window.previewApprovalFixture("manual")');
  const refreshFailure = await win.webContents.executeJavaScript('window.previewApprovalFixture("agent", true)');
  const exits = {};
  for (const [name, mode, outcome] of [['stale','agent','stale'], ['delayed','agent','delayed'], ['waiting','waiting','stale'], ['manual','manual','stale'], ['missing','missing-coordinates','stale']]) {
    exits[name] = await win.webContents.executeJavaScript(`window.previewExitFixture(${JSON.stringify(mode)}, ${JSON.stringify(outcome)})`);
  }
  const scriptPanel = await win.webContents.executeJavaScript('window.scriptPanelFixture()');
  const approvedRun = await win.webContents.executeJavaScript('window.previewRunConsentFixture(true)');
  const newRun = await win.webContents.executeJavaScript('window.previewRunConsentFixture(false)');
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ agent, manual, handoff, manualHandoff, refreshFailure, exits, approvedRun, newRun, scriptPanel, table }, null, 2));
  app.exit(0);
} catch (error) { console.error(error); app.exit(1); }

}).catch(error => { console.error(error); app.exit(1); });
