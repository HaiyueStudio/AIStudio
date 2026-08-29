import { app, BrowserWindow, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const target = process.env.HAIYUE_INSTANCE_HOST_FILE;
if (!target) throw new Error('HAIYUE_INSTANCE_HOST_FILE is required.');
if (process.env.HAIYUE_INSTANCE_USER_DATA) app.setPath('userData', process.env.HAIYUE_INSTANCE_USER_DATA);
const deadline = setTimeout(() => finish(1, 'deadline exceeded'), 60_000);
let finished = false;
protocol.registerSchemesAsPrivileged([
  { scheme: 'instancehost', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
  { scheme: 'haiyue-preview', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
]);

app.whenReady().then(async () => {
  const hostRoot = path.dirname(path.resolve(target));
  const previewRoot = path.resolve(process.env.HAIYUE_INSTANCE_PREVIEW_ROOT ?? '.');
  const window = new BrowserWindow({ width: 640, height: 480, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.on('console-message', (_event, level, message) => console.log(`[preview-instancing-renderer:${level}] ${message}`));
  window.webContents.session.protocol.handle('instancehost', async (request) => new URL(request.url).pathname === '/host.html'
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
  await window.loadURL('instancehost://app/host.html');
  try {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 45000;
      const poll = () => {
        if (document.body.dataset.status === 'passed') return setTimeout(resolve, 100);
        if (document.body.dataset.status === 'failed' || Date.now() > deadline) return reject(new Error(document.body.dataset.error || 'instance preview timeout'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    const bitmap = (await window.webContents.capturePage()).toBitmap();
    let cyan = 0, chromatic = 0;
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      const b = bitmap[offset], g = bitmap[offset + 1], r = bitmap[offset + 2];
      if (g > 100 && b > 100 && r < 100) cyan++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 50) chromatic++;
    }
    if (cyan < 500 || chromatic < 500) throw new Error(`visual oracle failed cyan=${cyan} chromatic=${chromatic}`);
    finish(0, `cyan=${cyan} chromatic=${chromatic}`);
  } catch (cause) { finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)); }
}).catch((cause) => finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)));

function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  console.log(`[preview-instancing-smoke] ${message}`);
  app.exit(code);
}
