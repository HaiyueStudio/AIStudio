import { app, BrowserWindow, protocol } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindowPreviewControl } from '../../../apps/ai-studio/test/fixtures/g12-browser-window-preview-control.mjs';

const previewRoot = path.resolve(process.env.HAIYUE_G08_PREVIEW_ROOT ?? '.');
const fixtureRoot = path.resolve(import.meta.dirname, '../../../apps/ai-studio/test');
if (process.env.HAIYUE_G08_USER_DATA) app.setPath('userData', process.env.HAIYUE_G08_USER_DATA);
protocol.registerSchemesAsPrivileged([
  { scheme: 'g08host', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
  { scheme: 'haiyue-preview', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true } },
]);

const component = (id, type, value) => ({ id, type, version: '1.0.0', enabled: true, value });

app.whenReady().then(async () => {
  let stage = 'create-window';
  const watchdog = setTimeout(() => { console.error(`[g08-declarative-play] watchdog expired during ${stage}`); app.exit(1); }, 45_000);
  const window = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.session.protocol.handle('g08host', async () => new Response(new Uint8Array(await readFile(path.join(fixtureRoot, 'fixtures', 'g12-preview-host.html'))), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  window.webContents.session.protocol.handle('haiyue-preview', async (request) => {
    const relative = new URL(request.url).pathname.replace(/^\//u, '');
    const candidate = path.resolve(previewRoot, relative);
    if (candidate !== previewRoot && !candidate.startsWith(`${previewRoot}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    const bytes = await readFile(candidate);
    const contentType = candidate.endsWith('.html') ? 'text/html; charset=utf-8' : candidate.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': contentType, 'access-control-allow-origin': '*' } });
  });
  stage = 'load-host'; await window.loadURL('g08host://app/host.html');
  const control = new BrowserWindowPreviewControl(window);
  stage = 'wait-host-ready'; await control.ready();
  await window.webContents.executeJavaScript(`window.addEventListener('message', event => { if (event.data?.protocol === 'haiyue-preview/1' && event.data?.type === 'runtime-error') document.body.dataset.g08RuntimeError = JSON.stringify(event.data); })`);
  const scene = {
    documentId: 'document:g08-declarative', revision: 17,
    entities: [{
      id: 'entity:g08-game', name: 'Declarative Game', kind: 'cube', parentId: null, order: 0,
      transform: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      appearance: { material: 'basic', color: [0.15, 0.65, 0.95, 1] },
      components: [
        component('component:g08-state', 'haiyue.gameplay.state', { observationId: 'game', state: 'playing', score: 2, health: 3, maxHealth: 3, checkpoint: 'start', counters: [{ id: 'lines', value: 0 }], flags: [], events: [] }),
        component('component:g08-rules', 'haiyue.gameplay.rules', { rules: [{ id: 'hard-drop', once: true, when: { source: 'input-pressed', value: 'HardDrop', entityAId: '', entityBId: '', phase: 'enter' }, actions: [
          { kind: 'add-score', targetObservationId: 'game', key: '', numberValue: 10, textValue: '', booleanValue: false },
          { kind: 'emit-event', targetObservationId: 'game', key: 'hard-dropped', numberValue: 0, textValue: 'piece-1', booleanValue: false },
        ] }] }),
        component('component:g08-hud', 'haiyue.ui.hud', { items: [
          { id: 'declarative-score', kind: 'text', text: 'Score {score}', assetId: '', action: '', position: 'top-left', offsetX: 0, offsetY: 0, color: '#fff', backgroundColor: '#0008', fontSize: 22, width: 180, height: 44, visible: true },
          { id: 'declarative-drop', kind: 'button', text: 'Drop', assetId: '', action: 'HardDrop', position: 'bottom-center', offsetX: 0, offsetY: 0, color: '#fff', backgroundColor: '#135', fontSize: 18, width: 120, height: 44, visible: true },
        ] }),
        component('component:g08-listener', 'haiyue.audio.listener', { active: true, spatial: true, masterGain: 0.75, dopplerFactor: 1, speedOfSound: 343.3 }),
      ],
    }],
  };
  // Three instances with shared rounded geometry and independently colored face parts.
  const original = scene.entities[0];
  original.kind = 'rounded-box'; original.appearance = { material:'pbr', color:[.025,.025,.025,1] };
  original.components.push(component('component:fixture-body-geometry','haiyue.render.geometry',{kind:'rounded-box',radius:.1,segments:4}));
  const colors = [[1,.04,.02,1],[1,.55,.02,1],[1,1,.02,1],[1,1,1,1],[.02,.2,1,1],[.02,.8,.1,1]];
  const faces = [[0,0,.51,0,0],[0,0,-.51,0,180],[.51,0,0,0,90],[-.51,0,0,0,-90],[0,.51,0,-90,0],[0,-.51,0,90,0]];
  for (let n=0;n<3;n++) {
    const rootId = n ? `entity:fixture-body-${n}` : original.id;
    if (n) scene.entities.push({...original,id:rootId,name:`Composite ${n+1}`,components:[component(`component:fixture-body-${n}`,'haiyue.render.geometry',{kind:'rounded-box',radius:.1,segments:4})],transform:{...original.transform,position:{x:n===1?-1.3:1.3,y:0,z:0}}});
    for (let i=0;i<6;i++) {
      const [x,y,z,rx,ry] = faces[i];
      scene.entities.push({id:`entity:fixture-face-${n}-${i}`,name:`Face ${i}`,kind:'rounded-box',parentId:rootId,order:i,appearance:{material:'pbr',color:colors[i]},transform:{position:{x,y,z},rotationDegrees:{x:rx,y:ry,z:0},scale:{x:.82,y:.82,z:.025}},components:[component(`component:fixture-face-${n}-${i}`,'haiyue.render.geometry',{kind:'rounded-box',radius:.14,segments:4})]});
    }
  }
  scene.entities.push({id:'entity:fixture-light',name:'Ambient',kind:'ambient-light',parentId:null,order:50,transform:original.transform,light:{color:[1,1,1],intensity:1},components:[]});
  scene.entities.push({id:'entity:fixture-key',name:'Key',kind:'directional-light',parentId:null,order:51,transform:original.transform,light:{color:[1,1,1],intensity:2,direction:[-.5,-1,-.5],castShadow:false},components:[]});
  const emittedText = "api.scene.observe('script-state', { status: 'playing', events: [] });";
  const plan = { id: 'preview-plan:g08-declarative', documentId: scene.documentId, documentRevision: scene.revision, selection: 'all-enabled', scriptSetDigest: `sha256:${'b'.repeat(64)}`, scripts: [{ scriptId: 'script:g08-game', entityId: 'entity:g08-game', order: 0, textRevision: 1, digest: `sha256:${'a'.repeat(64)}`, capabilities: ['read', 'scene'], diagnostics: [], emittedText }], capabilities: ['read', 'scene'], runtimeConfig: { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'haiyue-play' }, risk: 'trusted-project', diagnostics: [] };
  try {
    stage = 'start-preview'; const startAbort = new AbortController(); const startTimer = setTimeout(() => startAbort.abort(new Error('G08 preview start response timeout')), 20_000);
    let started;
    try { started = await control.start(scene, plan, startAbort.signal); }
    catch (cause) { const runtimeError = await window.webContents.executeJavaScript('document.body.dataset.g08RuntimeError ?? null'); throw new Error(`${cause instanceof Error ? cause.message : String(cause)}${runtimeError ? `; runtime=${runtimeError}` : ''}`); }
    finally { clearTimeout(startTimer); }
    stage = 'inspect-baseline';
    const baseline = await control.inspect();
    const baselineGame = baseline.value.gameplay?.find((entry) => entry.id === 'game')?.value;
    const baselineHud = baseline.value.hud?.find((entry) => entry.id === 'declarative-score')?.text;
    stage = 'inject-input'; await control.input({ tick: baseline.tick + 1, kind: 'action', action: 'HardDrop', phase: 'down', source: 'synthetic' });
    stage = 'step-preview'; await control.step(1);
    stage = 'inspect-result';
    const inspected = await control.inspect();
    const game = inspected.value.gameplay?.find((entry) => entry.id === 'game')?.value;
    const rules = inspected.value.gameplay?.find((entry) => entry.id === 'rules')?.value;
    const listener = inspected.value.gameplay?.find((entry) => entry.id === 'audio-listener')?.value;
    const hud = inspected.value.hud?.find((entry) => entry.id === 'declarative-score')?.text;
    const button = inspected.value.hud?.find((entry) => entry.id === 'declarative-drop');
    stage = 'capture'; const captured = await control.capture();
    await writeFile(path.join(import.meta.dirname, 'preview.png'), Buffer.from(captured.base64, 'base64'));
    stage = 'stop'; const stopped = await control.stop();
    stage = 'reject-invalid-start'; const rejectedAt = Date.now(); let invalidStartMessage = '';
    try { await control.start(scene, { ...plan, runtimeConfig: { ...plan.runtimeConfig, seed: 'mismatched-seed' } }); }
    catch (cause) { invalidStartMessage = cause instanceof Error ? cause.message : String(cause); }
    const invalidStartLatencyMs = Date.now() - rejectedAt;
    const result = { revision: inspected.documentRevision, started: started.state, baselineScore: baselineGame?.score ?? null, baselineHud, score: game?.score ?? null, firedRules: rules?.firedRules ?? [], emitted: game?.events?.some((entry) => entry.id === 'hard-dropped') ?? false, listenerGain: listener?.masterGain ?? null, hud, buttonKind: button?.kind ?? null, pngBytes: captured.byteLength, sameTick: captured.tick === inspected.tick, cleanup: stopped.disposableCount, stopped: stopped.state, invalidStartRejected: /settings no longer match/u.test(invalidStartMessage), invalidStartLatencyMs };
    if (result.revision !== 17 || result.started !== 'playing' || result.baselineScore !== 2 || result.baselineHud !== 'Score 2' || result.score !== 12 || result.firedRules.join(',') !== 'hard-drop' || !result.emitted || result.listenerGain !== 0.75 || result.hud !== 'Score 12' || result.buttonKind !== 'button' || result.pngBytes < 8 || !result.sameTick || result.cleanup !== 0 || result.stopped !== 'stopped' || !result.invalidStartRejected || result.invalidStartLatencyMs > 5_000) throw new Error(JSON.stringify(result));
    clearTimeout(watchdog); console.log(`[g08-declarative-play] ${JSON.stringify(result)}`);
    app.exit(0);
  } catch (cause) {
    clearTimeout(watchdog); console.error(`[g08-declarative-play] ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`);
    app.exit(1);
  }
}).catch((cause) => { console.error(cause); app.exit(1); });
