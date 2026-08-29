import { app, BrowserWindow, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const target = process.env.HAIYUE_G09_HOST_FILE;
if (!target) throw new Error('HAIYUE_G09_HOST_FILE is required.');
if (process.env.HAIYUE_G09_USER_DATA) app.setPath('userData', process.env.HAIYUE_G09_USER_DATA);
const deadline = setTimeout(() => finish(1, 'deadline exceeded'), 60_000);
let finished = false;
protocol.registerSchemesAsPrivileged([
  { scheme: 'g09host', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
  { scheme: 'haiyue-preview', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
]);

app.whenReady().then(async () => {
  const hostRoot = path.dirname(path.resolve(target));
  const previewRoot = path.resolve(process.env.HAIYUE_G09_PREVIEW_ROOT ?? '.');
  const window = new BrowserWindow({ width: 640, height: 480, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.session.protocol.handle('g09host', async (request) => new URL(request.url).pathname === '/host.html'
    ? new Response(new Uint8Array(await readFile(path.join(hostRoot, 'host.html'))), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    : new Response('Not found', { status: 404 }));
  window.webContents.session.protocol.handle('haiyue-preview', async (request) => {
    const relative = new URL(request.url).pathname.replace(/^\//u, '');
    const candidate = path.resolve(previewRoot, relative);
    if (candidate !== previewRoot && !candidate.startsWith(`${previewRoot}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    const bytes = await readFile(candidate);
    const contentType = candidate.endsWith('.html') ? 'text/html; charset=utf-8' : candidate.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': contentType, 'access-control-allow-origin': '*' } });
  });
  await window.loadURL('g09host://app/host.html');
  try {
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 45000;
      const poll = () => {
        if (document.body.dataset.g09Status === 'passed') return resolve(JSON.parse(document.body.dataset.g09Result));
        if (document.body.dataset.g09Status === 'failed' || Date.now() > deadline) return reject(new Error(document.body.dataset.g09Error || 'multi-script preview timeout'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    if (result.scripts !== 2 || !result.stableOrder || !result.faultIsolated || result.cleanup !== 0) throw new Error(JSON.stringify(result));
    finish(0, `scripts=${result.scripts} stableOrder=${result.stableOrder} faultIsolated=${result.faultIsolated} cleanup=${result.cleanup}`);
  } catch (cause) { finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)); }
}).catch((cause) => finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)));

function finish(code, message) { if (finished) return; finished = true; clearTimeout(deadline); console.log(`[g09-multi-script-smoke] ${message}`); app.exit(code); }
