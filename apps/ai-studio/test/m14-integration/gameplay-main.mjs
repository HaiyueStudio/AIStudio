import assert from 'node:assert/strict';
import { app, BrowserWindow, protocol } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { GameplaySignalTracker } from '../../../../evals/src/index.mjs';

app.setPath('userData', process.env.HAIYUE_G09_USER_DATA);
protocol.registerSchemesAsPrivileged(['g09review','haiyue-preview'].map(scheme => ({ scheme, privileges: { standard: true, secure: true, corsEnabled: true } })));
let window, fixture; const output = process.env.HAIYUE_G09_OUTPUT;
app.whenReady().then(async () => {
  fixture = JSON.parse(await readFile(process.env.HAIYUE_G09_INPUT, 'utf8'));
  const root = fileURLToPath(new URL('../../dist/', import.meta.url));
  window = new BrowserWindow({ width: 700, height: 600, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', e => e.preventDefault());
  window.webContents.session.protocol.handle('g09review', async () => new Response(new Uint8Array(await readFile(new URL('../m14-g08-adapter-review/preview-host.html', import.meta.url))), { headers: { 'content-type': 'text/html' } }));
  window.webContents.session.protocol.handle('haiyue-preview', async request => {
    const url = new URL(request.url), target = path.resolve(root, url.pathname.slice(1));
    if (url.hostname !== 'app' || !target.startsWith(root) || !/\.(html|css|js|wasm)$/u.test(target)) return new Response('Forbidden', { status: 403 });
    return new Response(new Uint8Array(await readFile(target)), { headers: { 'content-type': target.endsWith('.html') ? 'text/html' : target.endsWith('.css') ? 'text/css' : 'text/javascript', 'access-control-allow-origin': '*' } });
  });
  await window.loadURL('g09review://app/host.html'); window.showInactive();
  await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const end=Date.now()+15000;function poll(){if(document.body.dataset.ready==="true")resolve();else if(Date.now()>end)reject(Error("preview timeout"));else setTimeout(poll,20)}poll()})');
  const command = (kind, payload = {}) => window.webContents.executeJavaScript(`reviewCommand(${JSON.stringify(kind)},${JSON.stringify(payload)})`);
  const rounds = [];
  await assert.rejects(command('start', { ...fixture.runs[0], paused: 'yes' }), /schema validation/u);
  for (const [index, run] of fixture.runs.entries()) {
    const started = await command('start', { ...run, paused: true }); assert.equal(started.started.seed, run.plan.runtimeConfig.seed); assert.equal(started.started.tickRateHz, run.plan.runtimeConfig.tickRateHz);
    const startup = (await command('inspect')).value;
    assert.equal(startup.tick, 0, 'paused start cannot advance before replay control');
    assert.equal(startup.paused, true);
    if (startup.tick < fixture.baselineTick) await command('step', { count: fixture.baselineTick - startup.tick });
    const initial = (await command('inspect')).value; assert.equal(initial.tick, fixture.baselineTick);
    const observe = result => ({ playId: run.behavior.playId, documentRevision: run.plan.documentRevision, scriptDigests: run.behavior.programs.map(p => p.sourceDigest), tick: result.value.tick, frame: result.value.frame, viewport: { width: 640, height: 480 }, device: 'desktop', capturedAt: new Date().toISOString(), value: result.value });
    const control = { inspect: async () => observe(await command('inspect')),
      input: async event => observe(await command('input', event)),
      step: async count => { const state = await control.inspect(); assert.ok(state.tick + count <= initial.tick + 600, 'G09 fixed 600-tick budget'); return observe(await command('step', { count })); },
      capture: async () => command('capture') };
    const resolveControl = control => {
      for (const entity of run.scene.entities) for (const component of entity.components ?? []) if (component.type === 'haiyue.input.action-map' && component.enabled !== false)
        for (const action of component.value.actions ?? []) if (action.keys?.includes(control)) return action.name;
      return control;
    };
    const tracker = new GameplaySignalTracker(), inputs = [];
    tracker.observe(await control.inspect());
    for (const input of fixture.replay) {
      const event = input[1] === 'action' ? { tick: initial.tick + input[0], kind: 'action', action: resolveControl(input[2]), phase: input[3], source: 'synthetic' }
        : { tick: initial.tick + input[0], kind: 'pointer', x: input[2], y: input[3], phase: input[4], pointerId: 12, button: 0, source: 'synthetic' };
      inputs.push(event); tracker.observe(await control.input(event));
    }
    const endTick = initial.tick + Math.max(...fixture.replay.map(input => input[0]));
    while (tracker.latestTick < endTick) tracker.observe(await control.step(1));
    const replay = { inputs, observedSignals: tracker.signals(), observations: tracker.observations(), finalObservation: await control.inspect() };
    assert.equal(replay.finalObservation.value.runtimeErrorCount, 0);
    const capture = (await command('behavior-inspect')).capture;
    await writeFile(path.join(output, `${fixture.genre}-${index}-observed.json`), JSON.stringify({ replay, capture }, null, 2));
    const entered = new Set(capture.events.filter(e => e.kind === 'node-enter').map(e => e.nodeId));
    const flows = [];
    for (const signal of fixture.namedFlows) {
      assert.ok(replay.observedSignals.includes(signal), `missing frozen gameplay event: ${signal}`);
      const literal = [JSON.stringify(signal), `'${signal}'`];
      const node = fixture.manifest.nodes.filter(n => entered.has(n.id) && n.source.kind === 'script' && ['trigger','call','action'].includes(n.kind))
        .find(n => literal.some(text => fixture.script.source.slice(n.source.range.start, n.source.range.end).includes(text)));
      assert.ok(node && !flows.some(flow => flow.nodeId === node.id), `missing distinct executed site for ${signal}`);
      flows.push({ signal, nodeId: node.id, kind: node.kind, label: node.label, source: node.source });
    }
    // Some preserved games publish state without a named event for movement.
    // Require both the actual true input branch and its expected state change;
    // an input alone, or an unexecuted static node, cannot count as a flow.
    for (const expected of fixture.stateFlows) {
      const tick = initial.tick + expected.tick;
      const node = fixture.manifest.nodes.find(n => n.kind === 'condition' && n.source.kind === 'script'
        && fixture.script.source.slice(n.source.range.start, n.source.range.end) === expected.condition);
      assert.ok(node, `missing frozen condition: ${expected.condition}`);
      const event = capture.events.find(e => e.nodeId === node.id && e.kind === 'node-exit' && e.tick === tick && e.stateDiff?.truthy === true);
      assert.ok(event, `missing executed true branch: ${expected.condition}`);
      const stateAt = at => replay.observations.findLast(o => o.tick === at)?.value.gameplay.find(o => o.id === expected.observation)?.value;
      const valueAt = at => expected.path.reduce((value, key) => value?.[key], stateAt(at));
      assert.equal(valueAt(tick - 1), expected.before); assert.equal(valueAt(tick), expected.after);
      flows.push({ signal: expected.name, evidence: 'executed-input-branch-and-observed-state-change', nodeId: node.id, kind: node.kind, label: node.label, source: node.source, tick, stateChange: { path: expected.path, before: valueAt(tick - 1), after: valueAt(tick) } });
    }
    assert.ok(flows.length >= 2, `need two observed gameplay flows with executed source sites; found ${flows.length}, signals ${replay.observedSignals.join(', ')}, trace ${capture.events.length}`);
    await writeFile(path.join(output, `${fixture.genre}-${index}.png`), (await window.webContents.capturePage()).toPNG());
    const cleanup = await command('stop'); assert.equal(cleanup.disposableCount, 0);
    rounds.push({ started, replay, capture, flows, cleanup });
  }
  const gpu = await app.getGPUInfo('complete');
  assert.deepEqual(rounds[0].replay.observedSignals, rounds[1].replay.observedSignals, 'fixed seed/input preserves observed event identities');
  assert.deepEqual(rounds[0].replay.observations, rounds[1].replay.observations, 'fixed seed/input preserves all sampled gameplay state');
  await writeFile(path.join(output, `${fixture.genre}.json`), JSON.stringify({ schemaVersion: 1, genre: fixture.genre, scope: 'G09 fixed flow replay of isolated M12 copies; no M12 whole-game acceptance', provenance: fixture.provenance, migrations: fixture.migrations, replay: fixture.replay, device: { platform: os.platform(), release: os.release(), electron: process.versions.electron, chrome: process.versions.chrome, gpu: gpu.gpuDevice }, rounds }, null, 2));
  window.destroy(); app.exit(0);
}).catch(async error => { console.error(error); const runtime = window && !window.isDestroyed() ? await window.webContents.executeJavaScript('reviewEvidence()').catch(() => null) : null; if (fixture) await writeFile(path.join(output, `${fixture.genre}-failure.json`), JSON.stringify({ message: String(error), progress: error.replayProgress, runtime }, null, 2)); window?.destroy(); app.exit(1); });
