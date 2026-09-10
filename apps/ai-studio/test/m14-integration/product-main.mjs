import { app, BrowserWindow, dialog } from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const directory = process.env.HAIYUE_M14_PRODUCT_DIRECTORY, phase = process.env.HAIYUE_M14_PRODUCT_PHASE;
assert.ok(directory && ['author', 'restart', 'large'].includes(phase));
let window, finishing = false, sequence = 0, nextDecision = 1;
const approvals = [], checks = [];
// Only OS dialogs are driven by explicit fixture choices. The production root,
// IPC, project orchestration, policy/approval store, public panels and tools run unchanged.
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(directory, phase === 'large' ? 'large-project' : 'project')] });
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1); assert.equal(options.title, '确认项目修改');
  assert.ok(options.detail.includes('修订 ')); approvals.push({ title: options.message, detail: options.detail, decision: nextDecision === 1 ? 'allow-once' : 'reject' });
  const response = nextDecision; nextDecision = 1; return { response, checkboxChecked: false };
};
const evaluate = code => window.webContents.executeJavaScript(code, true);
const call = async (channel, payload = {}) => {
  const response = await evaluate(`window.haiyueStudio.invoke(${JSON.stringify({ schemaVersion: 1, id: `request:driver-${++sequence}`, correlationId: 'correlation:g09-window', channel, payload })})`);
  assert.equal(response.ok, true, JSON.stringify(response)); return response.payload;
};
const waitFor = async (read, label) => { console.log(`[m14-product:${phase}] ${label}`); const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await read()) return; await new Promise(r => setTimeout(r, 40)); } throw Error('Timed out: ' + label + '\n' + JSON.stringify(await evaluate('({dataset:{...document.body.dataset},status:document.querySelector("#status")?.textContent,advanced:document.querySelector("[data-advanced=error]")?.textContent,resources:document.querySelector("[data-resource=status]")?.textContent})'))); };
const ready = () => waitFor(() => evaluate('document.body.dataset.status === "ready"'), 'product ready');
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const selectWorkspaceTab = value => evaluate(`document.querySelector('#workspace-tabs').shadowRoot.querySelector('[data-value="${value}"]').click()`);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
const screenshot = async name => writeFile(path.join(directory, name), (await window.webContents.capturePage()).toPNG());
const data = () => call('editor/advanced');
const resourceLayout = async () => {
  await settle();
  const value = await evaluate(`(() => {
    const panel = document.querySelector('.resource-explorer'), bounds = panel.getBoundingClientRect();
    const controls = [...panel.querySelectorAll('.resource-filters input, .resource-filters select, .resource-filters button')].map(el => el.getBoundingClientRect());
    return { viewportWidth: innerWidth, panelWidth: panel.clientWidth, scrollWidth: panel.scrollWidth,
      controlsVisible: controls.every(r => r.width > 0 && r.left >= bounds.left - 1 && r.right <= bounds.right + 1) };
  })()`);
  assert.ok(value.panelWidth > 0 && value.scrollWidth <= value.panelWidth + 1, `Resource panel overflows its container: ${JSON.stringify(value)}`);
  assert.equal(value.controlsVisible, true, 'Resource filter controls must remain inside the panel.');
  return value;
};

app.on('browser-window-created', (_event, created) => {
  if (window) return; window = created;
  window.webContents.on('console-message', details => { if (details.level === 'error') console.error(`[renderer] ${details.message}`); });
  window.webContents.once('did-finish-load', () => void run().catch(error => finish(1, error)));
});
await import('../../dist/main.js');

async function run() {
  await ready(); window.showInactive();
  if (phase === 'large') return large();
  if (phase === 'restart') {
    const expected = JSON.parse(await readFile(path.join(directory, 'author.json'), 'utf8'));
    await click('#open-project'); await waitFor(async () => (await data()).document?.entities.some(e => e.id === expected.entityId), 'saved project opened');
    const assets = await call('scene/snapshot'); assert.equal(assets.assets[0].id, expected.assetId);
    const state = await data(); assert.equal(state.document.entities.find(e => e.id === expected.entityId).name, 'Integrated geometry');
    const history = await call('conversation/history', { projectId: (await call('project/snapshot')).document.projectId, limit: 100 });
    assert.equal(history.storage, 'project'); assert.equal(history.projectId, (await call('project/snapshot')).document.projectId);
    assert.equal(history.records.length, 0, 'manual authoring does not fabricate Agent execution records');
    await selectWorkspaceTab('resources'); await screenshot('resources-restarted.png');
    await writeFile(path.join(directory, 'restart.json'), JSON.stringify({ schemaVersion: 1, assetId: expected.assetId, entityId: expected.entityId, projectRecords: history.records.length }, null, 2));
    return finish(0);
  }
  await selectWorkspaceTab('resources');
  await waitFor(() => evaluate('document.querySelector("#studio-resource-panel [data-resource-entry]") !== null'), 'resource catalog');
  const desktopLayout = await resourceLayout();
  assert.ok(desktopLayout.viewportWidth > 650 && desktopLayout.panelWidth < 650, 'Exercise a narrow pane in a wide window.');
  // Respect the production desktop minimum; the isolated resource fixture
  // separately exercises a real 375 px host without that window constraint.
  const windowSize = window.getSize(), minimumSize = window.getMinimumSize();
  window.setSize(minimumSize[0], Math.max(768, minimumSize[1]));
  const narrowLayout = await resourceLayout();
  assert.ok(narrowLayout.viewportWidth < desktopLayout.viewportWidth);
  await screenshot('resources-narrow.png');
  window.setSize(...windowSize); await resourceLayout();
  checks.push('resource panel fits its container at desktop and narrow widths');
  await evaluate(`(()=>{const p=document.querySelector('#studio-resource-panel');p.querySelector('[data-resource=kind]').value='template';p.querySelector('[data-resource=category]').value='Geometry';p.querySelector('form').requestSubmit();})()`);
  await waitFor(() => evaluate('document.querySelector(".resource-explorer").getAttribute("aria-busy")==="false" && document.querySelector("[data-resource=kind]").value==="template"'), 'geometry catalog');
  await click('#studio-resource-panel [data-resource-entry]');
  await click('[data-resource-action="template.create"]');
  await waitFor(async () => (await data()).document.entities.length === 1, 'resource creates geometry');
  await waitFor(() => evaluate('document.querySelector(".resource-explorer").getAttribute("aria-busy")==="false"'), 'resource action settled');
  const entityId = (await data()).document.entities[0].id;
  checks.push('resource template creates through production IPC and original tool');
  await click('#workspace-advanced-button');
  await waitFor(() => evaluate('document.querySelector(".advanced-authoring-panel") !== null'), 'public lazy advanced panel');
  await click(`[data-entity="${entityId}"]`);
  await waitFor(async () => (await data()).selection.active?.id === entityId, 'public selection');
  await waitFor(() => evaluate('document.querySelector("[data-advanced-form=rename] input").value.length>0 && !document.querySelector("[data-advanced=rename]").disabled'), 'rename ready');
  const historyBefore = (await data()).history.entries.length;
  await evaluate(`(()=>{const f=document.querySelector('[data-advanced-form=rename]');f.elements.name.value='Integrated geometry';f.requestSubmit();})()`);
  await waitFor(async () => (await data()).document.entities[0].name === 'Integrated geometry', 'rename approved');
  await waitFor(() => evaluate('!document.querySelector("[data-advanced=undo]").disabled'), 'history ready');
  assert.equal((await data()).history.entries.length, historyBefore + 1);
  await click('[data-advanced=undo]'); await waitFor(async () => (await data()).document.entities[0].name !== 'Integrated geometry', 'public undo');
  await waitFor(() => evaluate('!document.querySelector("[data-advanced=redo]").disabled'), 'redo ready'); await click('[data-advanced=redo]');
  await waitFor(async () => (await data()).document.entities[0].name === 'Integrated geometry', 'public redo');
  checks.push('public rename exact approval and shared undo/redo');
  await waitFor(() => evaluate('!document.querySelector("[data-advanced=rename]").disabled'), 'reject ready');
  nextDecision = 0;
  await evaluate(`(()=>{const f=document.querySelector('[data-advanced-form=rename]');f.elements.name.value='Rejected change';f.requestSubmit();})()`);
  await waitFor(() => evaluate('document.querySelector("[data-advanced=status]").textContent.includes("Operation failed")'), 'rejection visible');
  assert.equal((await data()).document.entities[0].name, 'Integrated geometry'); checks.push('explicit rejection leaves document unchanged');
  const beforeDrag = await data();
  await waitFor(() => evaluate('document.querySelector("[data-axis=x]")?.getBoundingClientRect().width>0 && !document.querySelector("[data-axis=x]").disabled'), 'projected Gizmo');
  // Native pointer injection requires input focus; showInactive only presents the test window.
  window.focus(); await waitFor(() => window.isFocused(), 'native pointer focus'); await settle();
  const point = await evaluate(`(()=>{const r=document.querySelector('[data-axis=x]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  assert.equal(await evaluate(`document.elementFromPoint(${point.x},${point.y})?.closest('[data-axis]')?.getAttribute('data-axis')`), 'x', 'native drag starts on the visible Gizmo handle');
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); await settle();
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 35, y: point.y, button: 'left' }); await settle();
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + 35, y: point.y, button: 'left', clickCount: 1 });
  await waitFor(async () => (await data()).history.entries.length === beforeDrag.history.entries.length + 1, 'one native gesture history transaction');
  await waitFor(() => evaluate('!document.querySelector("[data-advanced=rename]").disabled && !document.querySelector("[data-advanced=status]").textContent.includes("Working")'), 'Gizmo UI settled');
  checks.push('native pointer Gizmo commits once through transform.batch');
  await screenshot('advanced-desktop.png');
  window.webContents.debugger.attach('1.3'); await window.webContents.debugger.sendCommand('Accessibility.enable');
  const accessibility = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree'); window.webContents.debugger.detach();
  assert.ok(accessibility.nodes.some(n => n.role?.value === 'tree')); assert.ok(accessibility.nodes.some(n => n.name?.value === 'Advanced authoring'));
  await writeFile(path.join(directory, 'accessibility.json'), JSON.stringify(accessibility, null, 2)); checks.push('real accessibility tree');
  await click('#workspace-advanced-close'); await click('#save-project');
  await waitFor(async () => Boolean((await call('project/snapshot')).projectRoot), 'saved project path');
  // Save also refreshes the project-bound panels. A path alone does not mean
  // that refresh has finished; opening a dialog during rebinding cancels it.
  await waitFor(() => evaluate('!document.querySelector("#save-project").disabled && document.querySelector("#status").textContent === "项目已保存"'), 'save UI settled');
  await selectWorkspaceTab('resources');
  await waitFor(() => evaluate('!document.querySelector("[data-resource=import]").disabled'), 'import available'); await click('[data-resource=import]');
  await evaluate(`(()=>{const f=document.querySelector('.studio-resource-import form');for(const[k,v]of Object.entries({projectPath:'assets/sky.png',provenance:'G09 generated local test image',decodedBytes:'256',width:'2',height:'1'}))f.elements.namedItem(k).value=v;f.requestSubmit();})()`);
  await waitFor(async () => (await call('scene/snapshot')).assets.length === 1 && await evaluate('!document.querySelector(".studio-resource-import")'), 'import committed');
  const assets = await call('scene/snapshot'), assetId = assets.assets[0].id; assert.ok(assetId);
  await click('#save-project'); await waitFor(async () => !(await call('project/snapshot')).document.dirty, 'asset save');
  await waitFor(() => evaluate('!document.querySelector("#save-project").disabled && document.querySelector("#status").textContent === "项目已保存" && document.querySelector(".resource-explorer").getAttribute("aria-busy") === "false"'), 'saved resource UI settled');
  checks.push('controlled import UI retains asset identity');
  await resourceLayout();
  await screenshot('resources-desktop.png');
  const report = { schemaVersion: 1, productionEntry: 'apps/ai-studio/dist/main.js', platformDecisionDriver: 'explicit test decisions; real tool approvals', entityId, assetId, approvals, checks, resourceLayout: { desktop: desktopLayout, narrow: narrowLayout }, versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.version }, screenshots: ['advanced-desktop.png', 'resources-desktop.png', 'resources-narrow.png'] };
  await writeFile(path.join(directory, 'author.json'), JSON.stringify(report, null, 2)); return finish(0);
}
async function large() {
  const budget = JSON.parse(await readFile(new URL('./performance-budget.json', import.meta.url), 'utf8'));
  const machine = { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length };
  assert.deepEqual(machine, budget.machine);
  const timings = {}, measure = async (name, limit, operation) => { const start = performance.now(); await operation(); timings[name] = performance.now() - start; assert.ok(timings[name] <= limit, `${name}: ${timings[name]} > ${limit} ms`); };
  await measure('open', budget.maxOpenMs, async () => { await click('#open-project'); await waitFor(async () => (await data()).document?.entities.length === budget.entities, 'large project opened'); });
  assert.equal((await call('project/snapshot')).document.counts.scripts, budget.scripts);
  await selectWorkspaceTab('resources');
  await waitFor(() => evaluate('document.querySelector("[data-resource-entry]") !== null'), 'large resource panel');
  await measure('advancedMount', budget.maxInteractionMs, async () => { await click('#workspace-advanced-button'); await waitFor(() => evaluate('document.querySelectorAll("[data-entity]").length>0'), 'large hierarchy mounted'); });
  assert.ok(await evaluate('document.querySelectorAll("[data-entity]").length') <= budget.maxVisibleTreeRows);
  await measure('filterAndSelect', budget.maxInteractionMs, async () => {
    await evaluate(`(()=>{const input=document.querySelector('[data-advanced=search]');input.value='Resource entity 999';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('[data-entity="entity:resource-999"]'); await waitFor(async () => (await data()).selection.active?.id === 'entity:resource-999', 'last entity selected');
  });
  assert.equal(await evaluate('document.querySelector("#workspace-manual-inspect").scrollWidth <= document.querySelector("#workspace-manual-inspect").clientWidth'), true);
  await screenshot('large-desktop.png');
  window.setSize(1024, 768); await settle();
  assert.equal(await evaluate('document.querySelector("#workspace-manual-inspect").scrollWidth <= document.querySelector("#workspace-manual-inspect").clientWidth'), true);
  await screenshot('large-narrow.png');
  window.webContents.debugger.attach('1.3');
  const heap = async () => { await window.webContents.debugger.sendCommand('HeapProfiler.collectGarbage'); return (await window.webContents.debugger.sendCommand('Runtime.getHeapUsage')).usedSize; };
  const initialHeapBytes = await heap();
  for (let i = 0; i < 5; i++) {
    await click('#workspace-advanced-close'); if (i % 2 === 0) await settle();
    await click('#workspace-advanced-button');
    await waitFor(() => evaluate('document.querySelector("#workspace-advanced").getAttribute("aria-busy")==="false" && document.querySelectorAll(".advanced-authoring-panel").length===1 && document.querySelectorAll(".advanced-transform-gizmo").length===1'), 'single mounted owner after reopen');
    assert.equal(await evaluate('document.querySelector("[data-advanced=error]")?.textContent ?? ""'), '', 'rapid reopen completes without stale cancellation');
  }
  const finalHeapBytes = await heap(); window.webContents.debugger.detach();
  assert.ok(finalHeapBytes <= budget.maxRendererHeapBytes); assert.ok(finalHeapBytes - initialHeapBytes <= budget.maxRendererHeapGrowthBytesAfterFiveMounts);
  const metrics = app.getAppMetrics().filter(m => m.type === 'Tab'); assert.ok(metrics.length); for (const metric of metrics) assert.ok(metric.memory.workingSetSize <= budget.maxRendererWorkingSetKiB);
  await click('#workspace-advanced-close');
  // Closing cancels the previous advanced request asynchronously. Observe its completion before querying.
  await waitFor(() => evaluate('document.querySelector("#workspace-advanced").getAttribute("aria-busy") === "false"'), 'advanced close settled');
  let page; await measure('resourceQuery', budget.maxResourceQueryMs, async () => { page = await call('editor/resources', { kind: 'instance', limit: 50 }); });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= budget.maxResourceProjectionBytes);
  const gpu = await app.getGPUInfo('complete');
  await writeFile(path.join(directory, 'large.json'), JSON.stringify({ schemaVersion: 1, machine, budget, timings, initialHeapBytes, finalHeapBytes, metrics, gpu: gpu.gpuDevice, entityCount: budget.entities, scriptCount: budget.scripts }, null, 2));
  return finish(0);
}
async function finish(code, error) {
  if (finishing) return; finishing = true;
  try { await writeFile(path.join(directory, `${phase}-renderer-state.json`), JSON.stringify({ dom: await evaluate('document.documentElement.outerHTML'), projection: await data() }, null, 2)); }
  catch (captureError) { code = 1; error ??= captureError; }
  if (error) { console.error(error); await writeFile(path.join(directory, `${phase}-failure.json`), JSON.stringify({ phase, error: String(error), checks, approvals }, null, 2)); await screenshot(`${phase}-failure.png`).catch(() => undefined); }
  console.log(`[m14-product] ${phase} ${code === 0 ? 'passed' : 'failed'}`);
  process.exitCode = code;
  app.once('will-quit', () => app.exit(code));
  window.close();
}
