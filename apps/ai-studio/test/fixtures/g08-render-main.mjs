import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const target = process.env.HAIYUE_G08_RENDER_FILE;
if (!target) throw new Error('HAIYUE_G08_RENDER_FILE is required.');
if (process.env.HAIYUE_G08_USER_DATA) app.setPath('userData', process.env.HAIYUE_G08_USER_DATA);
const deadline = setTimeout(() => finish(1, 'deadline exceeded'), 60_000);
let finished = false;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.on('console-message', (_event, level, message) => console.log(`[g08-renderer:${level}] ${message}`));
  await window.loadFile(target);
  try {
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 45000;
      const poll = () => {
        if (document.body.dataset.renderStatus === 'passed') return resolve(JSON.parse(document.body.dataset.manifest));
        if (Date.now() > deadline) return reject(new Error(document.body.dataset.renderError || 'render timeout'));
        setTimeout(poll, 50);
      }; poll();
    })`);
    const image = await window.webContents.capturePage();
    const bitmap = image.toBitmap();
    let dark = 0, bright = 0, chromatic = 0, minLuminance = 255, maxLuminance = 0;
    for (let offset = 0; offset < bitmap.length; offset += 16) {
      const b = bitmap[offset], g = bitmap[offset + 1], r = bitmap[offset + 2];
      const luminance = (r + g + b) / 3;
      minLuminance = Math.min(minLuminance, luminance); maxLuminance = Math.max(maxLuminance, luminance);
      if (luminance < 18) dark++;
      if (luminance > 80) bright++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 35) chromatic++;
    }
    const candidate = process.env.HAIYUE_G08_RENDER_PIXEL;
    if (candidate) { await mkdir(path.dirname(candidate), { recursive: true }); await writeFile(candidate, image.toPNG()); }
    if (bright < 100 || chromatic < 100 || maxLuminance - minLuminance < 35) throw new Error(`visual oracle failed dark=${dark} bright=${bright} chromatic=${chromatic} range=${minLuminance.toFixed(1)}..${maxLuminance.toFixed(1)}`);
    if (result.postprocess.map(item => item.kind).join(',') !== 'outline,fxaa' || result.owners.particles3d !== 1 || result.owners.materials !== 2 || result.owners.lighting < 2) throw new Error(JSON.stringify(result));
    finish(0, `visual-oracle dark=${dark} bright=${bright} chromatic=${chromatic} range=${minLuminance.toFixed(1)}..${maxLuminance.toFixed(1)} effects=${result.postprocess.length}`);
  } catch (cause) { finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)); }
}).catch((cause) => finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)));

function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  console.log(`[g08-render-smoke] ${message}`);
  const receipt = process.env.HAIYUE_G08_RENDER_RESULT;
  if (!receipt) {
    app.exit(code);
    return;
  }
  void mkdir(path.dirname(receipt), { recursive: true })
    .then(() => writeFile(receipt, `${JSON.stringify({ code, message })}\n`, 'utf8'))
    .then(() => app.exit(code))
    .catch((cause) => {
      console.error(`[g08-render-smoke] failed to write result receipt: ${cause instanceof Error ? cause.message : String(cause)}`);
      app.exit(1);
    });
}
