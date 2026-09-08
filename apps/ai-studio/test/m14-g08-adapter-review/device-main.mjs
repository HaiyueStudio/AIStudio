import assert from 'node:assert/strict';
import { app, BrowserWindow, protocol, nativeImage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../../dist/', import.meta.url)));
app.setPath('userData', process.env.HAIYUE_REVIEW_USER_DATA);
protocol.registerSchemesAsPrivileged(['g08review','haiyue-preview'].map(scheme => ({ scheme, privileges: { standard: true, secure: true, corsEnabled: true } })));
let window, stage = 'initialization';
const deadline = setTimeout(() => { console.error(`G08 deadline during ${stage}`); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  const fixture = JSON.parse(await readFile(process.env.HAIYUE_REVIEW_INPUT, 'utf8'));
  const output = process.env.HAIYUE_REVIEW_OUTPUT;
  window = new BrowserWindow({ width: 700, height: 600, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.protocol.handle('g08review', async request => new URL(request.url).pathname === '/host.html'
    ? new Response(new Uint8Array(await readFile(new URL('./preview-host.html', import.meta.url))), { headers: { 'content-type': 'text/html' } }) : new Response('Not found', { status: 404 }));
  window.webContents.session.protocol.handle('haiyue-preview', async request => {
    const url = new URL(request.url), relative = decodeURIComponent(url.pathname).replace(/^\//u, '');
    const candidate = path.resolve(root, relative);
    if (url.host !== 'app' || !candidate.startsWith(root + path.sep) || !/\.(?:html|css|js|wasm)$/u.test(candidate)) return new Response('Forbidden', { status: 403 });
    try { return new Response(new Uint8Array(await readFile(candidate)), { headers: { 'content-type': candidate.endsWith('.html') ? 'text/html' : candidate.endsWith('.wasm') ? 'application/wasm' : candidate.endsWith('.css') ? 'text/css' : 'text/javascript', 'access-control-allow-origin': '*' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  stage = 'host-ready'; await window.loadURL('g08review://app/host.html');
  window.showInactive();
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const end = performance.now() + 15000;
    function check() { if (document.body.dataset.ready === 'true') resolve(); else if (performance.now() > end) reject(Error('iframe not ready')); else requestAnimationFrame(check); } check();
  })`);
  const command = (kind, payload = {}) => window.webContents.executeJavaScript(`window.reviewCommand(${JSON.stringify(kind)}, ${JSON.stringify(payload)})`);
  const device = await window.webContents.executeJavaScript(`(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw Error('No real WebGPU adapter');
    const info = adapter.info;
    return { userAgent: navigator.userAgent, vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter ?? null };
  })()`);
  const rounds = [];
  const game = snapshot => snapshot.value.gameplay.find(item => item.id === 'review-round').value;
  for (let round = 0; round < 2; round++) {
    const run = fixture.runs[round];
    stage = `start-${round}`; const started = await command('start', run);
    assert.equal(started.started.scriptCount, fixture.scriptCount);
    assert.equal(started.started.seed, 'haiyue-play'); assert.equal(started.started.tickRateHz, 60);
    const baseline = await command('inspect');
    assert.ok(baseline.value.tick < 10, 'Pause must precede the first timer event.');
    assert.ok((fixture.scriptCount ? [0, 100] : [0]).includes(game(baseline).score));
    stage = `step-${round}`;
    await command('input', { tick: baseline.value.tick + 1, kind: 'action', action: 'HardDrop', phase: 'down', source: 'synthetic' });
    const stepped = await command('step', { count: 10 - baseline.value.tick });
    const value = game(stepped);
    assert.equal(stepped.value.tick, 10); assert.equal(value.score, fixture.scriptCount ? 111 : 11);
    assert.equal(stepped.value.hud.find(item => item.id === 'review-score').text, `Score ${value.score}`);
    assert.equal(stepped.value.gameplay.find(item => item.id === 'audio-listener').value.masterGain, 0.75);
    assert.equal(stepped.value.runtimeErrorCount, 0);
    if (fixture.scriptCount) {
      assert.equal(stepped.value.physics.resources.bodies, 2);
      assert.ok(Math.abs(stepped.value.state.entities.find(item => item.id === fixture.animatedId).position[0] - 1) < 0.001);
    }
    const trace = (await command('behavior-inspect')).capture;
    assert.ok(trace.events.some(event => event.event === 'timer-fired'));
    assert.ok(trace.events.some(event => event.event === 'action-completed'));
    assert.equal(trace.events.some(event => event.scriptId !== null), fixture.scriptCount > 0);
    if (fixture.scriptCount) assert.ok(trace.events.some(event => event.event === 'physics-trigger-enter'));
    stage = `resize-${round}`; const resized = await command('resize', { width: 480, height: 320 });
    assert.equal(resized.value.renderEffects.viewport.width, 480); assert.equal(resized.value.renderEffects.viewport.height, 320);
    const afterResize = await command('step', { count: 10 });
    assert.equal(afterResize.value.tick, 20); assert.equal(game(afterResize).score, fixture.scriptCount ? 112 : 12);
    await writeFile(path.join(output, `${fixture.kind}-window.png`), (await window.webContents.capturePage()).toPNG());
    const capture = await command('capture');
    assert.equal(capture.tick, 20); assert.ok(capture.byteLength > 1000);
    const png = Buffer.from(capture.base64, 'base64'); assert.equal(png.readUInt32BE(16), 480); assert.equal(png.readUInt32BE(20), 320);
    const bitmap = nativeImage.createFromBuffer(png).toBitmap(); let bluePixels = 0, whitePixels = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      if (bitmap[i] > 160 && bitmap[i + 1] > 60 && bitmap[i + 2] < 80) bluePixels++;
      if (Math.min(bitmap[i], bitmap[i + 1], bitmap[i + 2]) > 180) whitePixels++;
    }
    assert.ok(bluePixels > 100 && whitePixels > 30, `Capture must contain the blue model and white HUD, got ${bluePixels}/${whitePixels} pixels`);
    await writeFile(path.join(output, `${fixture.kind}-${round}.png`), png);
    stage = `stop-${round}`; const cleanup = await command('stop'); assert.equal(cleanup.disposableCount, 0);
    rounds.push({ started, baseline, stepped, resized, afterResize, trace, capture: { tick: capture.tick, frame: capture.frame, byteLength: capture.byteLength, bluePixels, whitePixels, file: `${fixture.kind}-${round}.png` }, cleanup });
  }
  stage = 'cancel-start'; const cancelled = await command('cancel-start', fixture.runs[2]); assert.equal(cancelled.disposableCount, 0);
  stage = 'retry'; const retry = await command('start', fixture.runs[3]); assert.equal(retry.started.scriptCount, fixture.scriptCount);
  const retried = await command('step', { count: 1 }); assert.equal(retried.value.runtimeErrorCount, 0);
  assert.ok(game(retried).score < 101, 'Held input and previous timer/rule state must not survive restart.');
  // Delay only PNG completion to make Stop/async encoding ordering deterministic.
  // All acceptance PNGs above were captured without injected browser behavior.
  const previewFrame = window.webContents.mainFrame.frames.find(frame => frame.url.startsWith('haiyue-preview:'));
  await previewFrame.executeJavaScript(`(() => { const original=HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob=function(callback,...args) { return original.call(this, blob => setTimeout(() => callback(blob), 100), ...args); }; })()`);
  const captureStopped = await command('capture-stop');
  const cleanup = captureStopped.cleanup; assert.equal(cleanup.disposableCount, 0);
  assert.match(captureStopped.rejected.message, /stopped or restarted/);
  const events = await window.webContents.executeJavaScript('window.reviewEvidence()'); assert.deepEqual(events.errors, []);
  const gpu = await app.getGPUInfo('complete');
  const report = { schemaVersion: 1, kind: fixture.kind, status: 'passed', recordedAt: new Date().toISOString(), device: { os: { platform: os.platform(), release: os.release(), arch: os.arch() }, versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }, webgpu: device, gpu: { devices: gpu.gpuDevice, renderer: gpu.auxAttributes?.glRenderer } }, scriptCount: fixture.scriptCount, binding: fixture.binding, manifestDigest: fixture.manifestDigest, rounds, cancelled, retry, cleanup, captureStopped, events };
  await writeFile(path.join(output, `${fixture.kind}.json`), JSON.stringify(report, null, 2) + '\n');
  clearTimeout(deadline); window.destroy(); console.log(`[m14-g08-review] ${fixture.kind} passed`); app.exit(0);
}).catch(error => { clearTimeout(deadline); console.error(`[m14-g08-review] ${stage}: ${error.stack ?? error}`); window?.destroy(); app.exit(1); });
