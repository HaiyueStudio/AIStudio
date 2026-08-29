import { app, BrowserWindow, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const target = process.env.HAIYUE_G08_PREVIEW_ASSET_FILE;
if (!target) throw new Error('HAIYUE_G08_PREVIEW_ASSET_FILE is required.');
if (process.env.HAIYUE_G08_USER_DATA) app.setPath('userData', process.env.HAIYUE_G08_USER_DATA);
const deadline = setTimeout(() => finish(1, 'deadline exceeded'), 60_000);
let finished = false;
protocol.registerSchemesAsPrivileged([
  { scheme: 'g08host', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
  { scheme: 'haiyue-preview', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
]);

app.whenReady().then(async () => {
  const hostRoot = path.dirname(path.resolve(target));
  const previewRoot = path.resolve(process.env.HAIYUE_G08_PREVIEW_ROOT ?? '.');
  const window = new BrowserWindow({ width: 640, height: 480, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.session.protocol.handle('g08host', async (request) => {
    if (new URL(request.url).pathname !== '/host.html') return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(await readFile(path.join(hostRoot, 'host.html'))), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  window.webContents.session.protocol.handle('haiyue-preview', async (request) => {
    const relative = new URL(request.url).pathname.replace(/^\//u, '');
    const candidate = path.resolve(previewRoot, relative);
    if (candidate !== previewRoot && !candidate.startsWith(`${previewRoot}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    const bytes = await readFile(candidate);
    const contentType = candidate.endsWith('.html') ? 'text/html; charset=utf-8' : candidate.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': contentType, 'access-control-allow-origin': '*' } });
  });
  window.webContents.on('console-message', (_event, level, message) => console.log(`[g08-preview-asset:${level}] ${message}`));
  await window.loadURL('g08host://app/host.html');
  try {
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 45000;
      const poll = () => {
        if (document.body.dataset.previewAssetStatus === 'passed') return resolve(JSON.parse(document.body.dataset.previewAssetResult));
        if (document.body.dataset.previewAssetStatus === 'failed' || Date.now() > deadline) return reject(new Error(document.body.dataset.previewAssetError || 'preview asset timeout'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    if (result.textures !== 1 || result.materials !== 1 || result.cleanup !== 0) throw new Error(JSON.stringify(result));
    finish(0, `blob-texture textures=${result.textures} materials=${result.materials} cleanup=${result.cleanup}`);
  } catch (cause) { finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)); }
}).catch((cause) => finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)));

function finish(code, message) { if (finished) return; finished = true; clearTimeout(deadline); console.log(`[g08-preview-asset-smoke] ${message}`); app.exit(code); }
