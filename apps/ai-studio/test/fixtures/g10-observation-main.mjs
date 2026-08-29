import { app, BrowserWindow, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const target = process.env.HAIYUE_G10_HOST_FILE;
if (!target) throw new Error('HAIYUE_G10_HOST_FILE is required.');
if (process.env.HAIYUE_G10_USER_DATA) app.setPath('userData', process.env.HAIYUE_G10_USER_DATA);
const deadline = setTimeout(() => finish(1, 'deadline exceeded'), 60_000);
let finished = false;
protocol.registerSchemesAsPrivileged([
  { scheme: 'g10host', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
  { scheme: 'haiyue-preview', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
]);

app.whenReady().then(async () => {
  const hostRoot = path.dirname(path.resolve(target));
  const previewRoot = path.resolve(process.env.HAIYUE_G10_PREVIEW_ROOT ?? '.');
  const window = new BrowserWindow({ width: 640, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.session.protocol.handle('g10host', async (request) => new URL(request.url).pathname === '/host.html'
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
  await window.loadURL('g10host://app/host.html');
  try {
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 45000;
      const poll = () => {
        if (document.body.dataset.g10Status === 'passed') return resolve(JSON.parse(document.body.dataset.g10Result));
        if (document.body.dataset.g10Status === 'failed' || Date.now() > deadline) return reject(new Error(document.body.dataset.g10Error || 'observation preview timeout'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    if (result.tick !== 1 || result.frame < 1 || result.pngBytes < 8 || !result.sameTick || result.cleanup !== 0 || !result.hud) throw new Error(JSON.stringify(result));
    finish(0, `tick=${result.tick} frame=${result.frame} pngBytes=${result.pngBytes} sameTick=${result.sameTick} hud=${result.hud} cleanup=${result.cleanup}`);
  } catch (cause) { finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)); }
}).catch((cause) => finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)));

function finish(code, message) { if (finished) return; finished = true; clearTimeout(deadline); console.log(`[g10-observation-smoke] ${message}`); app.exit(code); }
