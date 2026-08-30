import { app, BrowserWindow, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindowPreviewControl } from './g12-browser-window-preview-control.mjs';
import { compileG12ReplayProgram, executeG12ReplayProgram } from '../../../../evals/src/index.mjs';

const previewRoot = path.resolve(process.env.HAIYUE_G12_PREVIEW_ROOT ?? '.');
const fixtureRoot = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1'));
if (process.env.HAIYUE_G12_USER_DATA) app.setPath('userData', process.env.HAIYUE_G12_USER_DATA);
protocol.registerSchemesAsPrivileged([
  { scheme: 'g12host', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
  { scheme: 'haiyue-preview', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
]);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 420, height: 880, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.session.protocol.handle('g12host', async () => new Response(new Uint8Array(await readFile(path.join(fixtureRoot, 'g12-preview-host.html'))), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  window.webContents.session.protocol.handle('haiyue-preview', async (request) => {
    const relative = new URL(request.url).pathname.replace(/^\//u, '');
    const candidate = path.resolve(previewRoot, relative);
    if (candidate !== previewRoot && !candidate.startsWith(`${previewRoot}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    const bytes = await readFile(candidate);
    const contentType = candidate.endsWith('.html') ? 'text/html; charset=utf-8' : candidate.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': contentType, 'access-control-allow-origin': '*' } });
  });
  await window.loadURL('g12host://app/host.html');
  const control = new BrowserWindowPreviewControl(window);
  await control.ready();
  const scene = { documentId: 'document:g12-preview', revision: 1, entities: [{ id: 'entity:g12-player', name: 'Player', kind: 'cube', parentId: null, order: 0, transform: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, appearance: { material: 'basic', color: [0.1, 0.8, 0.3, 1] } }] };
  const emittedText = "const transform = entity.getComponent('CartesianTransform3D');\nif (api.input.isPressed('move-right')) transform?.setPosition(1, 0, 0);\napi.scene.hudText('score', 'Score: 1');\napi.scene.observe('game', { status: 'playing', score: 1, events: api.input.wasPressed('move-right') ? ['moved'] : [] });";
  const plan = { id: 'preview-plan:g12', documentId: scene.documentId, documentRevision: scene.revision, selection: 'all-enabled', scriptSetDigest: `sha256:${'b'.repeat(64)}`, scripts: [{ scriptId: 'script:g12-player', entityId: 'entity:g12-player', order: 0, textRevision: 1, digest: `sha256:${'a'.repeat(64)}`, capabilities: ['read', 'scene', 'input'], diagnostics: [], emittedText }], capabilities: ['read', 'scene', 'input'], runtimeConfig: { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'haiyue-play' }, risk: 'trusted-project', diagnostics: [] };
  try {
    const started = await control.start(scene, plan);
    const baseline = await control.inspect();
    await control.input({ tick: baseline.tick + 1, kind: 'action', action: 'move-right', phase: 'down', source: 'synthetic' });
    const stepped = await control.step(1);
    const inspected = await control.inspect();
    const captured = await control.capture();
    const replayProgram = compileG12ReplayProgram({ driver: 'fixed', steps: [{ id: 'semantic-input', at: 'play-ready', action: 'scripted-aim-and-fire', parameters: { target: 'nearest-visible-enemy', shots: 1 } }] }, { baseTick: inspected.tick });
    const replay = await executeG12ReplayProgram(control, replayProgram, { capture: true, maxTriggerWaitTicks: 30 });
    const stopped = await control.stop();
    const result = { started: started.state, baselineTick: baseline.tick, tick: inspected.tick, advanced: inspected.tick === baseline.tick + 1, frame: inspected.frame, x: stepped.value.state.entities.find((entry) => entry.id === 'entity:g12-player')?.position?.[0], hud: inspected.value.hud?.length ?? 0, gameplay: inspected.value.gameplay?.find((entry) => entry.id === 'game')?.value?.score ?? null, semanticDrivers: replay.semanticDriverIds, replayPngBytes: replay.capture?.byteLength ?? 0, pngBytes: captured.byteLength, sameTick: captured.tick === inspected.tick, cleanup: stopped.disposableCount, stopped: stopped.state };
    if (result.started !== 'playing' || !result.advanced || result.x !== 1 || result.hud < 1 || result.gameplay !== 1 || result.semanticDrivers.join(',') !== 'scripted-aim-and-fire' || result.replayPngBytes < 8 || result.pngBytes < 8 || !result.sameTick || result.cleanup !== 0 || result.stopped !== 'stopped') throw new Error(JSON.stringify(result));
    console.log(`[g12-preview-control] ${JSON.stringify(result)}`);
    app.exit(0);
  } catch (cause) {
    console.error(`[g12-preview-control] ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`);
    app.exit(1);
  }
}).catch((cause) => { console.error(cause); app.exit(1); });
