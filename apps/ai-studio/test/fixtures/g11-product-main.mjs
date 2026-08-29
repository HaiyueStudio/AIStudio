import { app, BrowserWindow, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.env.HAIYUE_G11_PRODUCT_ROOT;
if (!root) throw new Error('HAIYUE_G11_PRODUCT_ROOT is required.');
if (process.env.HAIYUE_G11_USER_DATA) app.setPath('userData', process.env.HAIYUE_G11_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'g11product', privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: false } }]);
let finished = false;
const deadline = setTimeout(() => finish(1, 'deadline exceeded'), 45_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 520, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.session.protocol.handle('g11product', async (request) => {
    const name = new URL(request.url).pathname.replace(/^\//u, '') || 'host.html';
    const target = path.resolve(root, name); const base = path.resolve(root);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    try { return new Response(new Uint8Array(await readFile(target)), { status: 200, headers: { 'content-type': target.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  await window.loadURL('g11product://app/host.html');
  try {
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const until = Date.now() + 30000; const poll = () => { if (document.body.dataset.g11Status === 'passed') resolve(JSON.parse(document.body.dataset.g11Result)); else if (document.body.dataset.g11Status === 'failed' || Date.now() > until) reject(new Error(document.body.dataset.g11Error || 'product UI timeout')); else setTimeout(poll, 40); }; poll(); })`);
    finish(0, JSON.stringify(result));
  } catch (cause) { finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)); }
}).catch((cause) => finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)));

function finish(code, message) { if (finished) return; finished = true; clearTimeout(deadline); console.log(`[g11-product-smoke] ${message}`); app.exit(code); }
