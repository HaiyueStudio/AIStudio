import { app, BrowserWindow, protocol } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkGraphPanning } from '../graph-pan-input.mjs';

const root = process.env.HAIYUE_G09_GRAPH_ROOT;
if (!root) throw new Error('HAIYUE_G09_GRAPH_ROOT is required.');
if (process.env.HAIYUE_G09_USER_DATA) app.setPath('userData', process.env.HAIYUE_G09_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'g09graph', privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: false } }]);
let finished = false;
let stage = 'app-ready';
const deadline = setTimeout(() => finish(1, `deadline exceeded during ${stage}`), 45_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 1000, show: false, backgroundColor: '#080d18', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.on('did-fail-load', (_event, code, description) => finish(1, `load failed during ${stage}: ${code} ${description}`));
  window.webContents.on('render-process-gone', (_event, details) => finish(1, `renderer gone during ${stage}: ${JSON.stringify(details)}`));
  window.webContents.session.protocol.handle('g09graph', async (request) => {
    const name = new URL(request.url).pathname.replace(/^\//u, '') || 'host.html';
    const target = path.resolve(root, name); const base = path.resolve(root);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    try { return new Response(new Uint8Array(await readFile(target)), { status: 200, headers: { 'content-type': target.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  stage = 'navigation';
  await window.loadURL('g09graph://app/host.html');
  try {
    stage = 'product assertions';
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const until = Date.now() + 30000; const poll = () => { if (document.body.dataset.g09Status === 'passed') resolve(JSON.parse(document.body.dataset.g09Result)); else if (document.body.dataset.g09Status === 'failed' || Date.now() > until) reject(new Error(document.body.dataset.g09Error || 'execution graph UI timeout')); else setTimeout(poll, 40); }; poll(); })`);
    const screenshotPath = process.env.HAIYUE_G09_SCREENSHOT_OUT;
    stage = 'drag panning';
    window.showInactive();
    await window.webContents.executeJavaScript('window.prepareGraphPanCheck()');
    result.panning = await checkGraphPanning(window, '.execution-graph-viewport', 'is-selected');
    await window.webContents.executeJavaScript('window.runNarrowGraphCheck()');
    if (screenshotPath) {
      stage = 'screenshot preparation';
      window.showInactive();
      await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await new Promise((resolve) => setTimeout(resolve, 100));
      stage = 'screenshot capture';
      const image = await window.webContents.capturePage();
      if (image.isEmpty()) throw new Error('capturePage returned an empty image');
      await mkdir(path.dirname(screenshotPath), { recursive: true });
      await writeFile(screenshotPath, image.toPNG());
      window.hide();
    }
    stage = 'narrow viewport';
    window.showInactive();
    window.setSize(760, 1000);
    await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    result.narrowViewport = await window.webContents.executeJavaScript('window.runNarrowGraphCheck()');
    if (!result.narrowViewport) throw new Error('narrow viewport clipped graph nodes or scroll controls');
    await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (screenshotPath) await writeFile(`${screenshotPath}.narrow.png`, (await window.webContents.capturePage()).toPNG());
    window.hide();
    const errors = await window.webContents.executeJavaScript('window.graphComponentErrors');
    if (errors.length) throw new Error('Component errors after graph interactions: ' + JSON.stringify(errors));
    finish(0, JSON.stringify(result));
  } catch (cause) { finish(1, `${stage}: ${describe(cause)}`); }
}).catch((cause) => finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)));

function finish(code, message) { if (finished) return; finished = true; clearTimeout(deadline); console.log(`[g09-execution-graph-smoke] ${message}`); app.exit(code); }
function describe(cause) { return cause instanceof Error ? `${cause.name}: ${cause.stack ?? cause.message}` : String(cause); }
