import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import electron from 'electron';

test('production preview controls distinguish Agent ownership and restore manual input', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-preview-owner-ui-'));
  // Use production rendering functions and markup; omit application boot and GPU creation.
  const source = (await readFile(new URL('../src/renderer.ts', import.meta.url), 'utf8')).split('void boot().catch(')[0];
  const hook = `
    const fixtureTask = { taskId: 'task:test', status: 'running', phase: 'playing', backendId: 'backend:test', sessionId: 'session:test', turnId: 'turn:test', acceptance: [{ id: 'acceptance:test', label: '拖拽后实体旋转', assertion: 'evidence state signal effects.entityChanged equals true', status: 'pending' }] };
    window.previewUiFixture = async (mode) => {
      playing = true;
      if (mode === 'agent') { agentPreviewOwnership.update('project:test', [fixtureTask]); agentPreviewOwnership.claim('project:test'); }
      else agentPreviewOwnership.release();
      if (mode === 'agent') previewTestActivities.push({ id: 'command:test', label: '模拟拖拽', expected: '提交拖拽输入事件', status: 'running', tick: 12 });
      showPlayPage();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const notice = element('play-agent-notice');
      return { progress: !element('play-agent-progress').hidden, progressText: element('play-agent-progress').textContent, owner: element('play-page').dataset.owner, notice: !notice.hidden, text: notice.textContent, exit: element('play-exit').textContent, pauseDisabled: element('play-pause').disabled, resizeDisabled: element('play-device-preset').disabled, input: getComputedStyle(element('play-device-screen')).pointerEvents, stageHeight: element('play-stage').getBoundingClientRect().height, toolbarBottom: element('play-page').querySelector('.play-toolbar').getBoundingClientRect().bottom, stageTop: element('play-stage').getBoundingClientRect().top };
    };
    window.previewTableFixture = async () => {
      await window.previewUiFixture('agent');
      const original = fixtureTask.acceptance;
      fixtureTask.acceptance = [
        { id: 'case:pending', label: '拖拽旋转方块', assertion: 'evidence state signal effects.entityChanged equals true', status: 'pending' },
        { id: 'case:pass', label: '运行无错误', assertion: 'evidence runtime-errors signal count equals 0', status: 'pass' },
        { id: 'case:fail', label: '保持相机位置', assertion: 'evidence state signal effects.cameraChanged equals false', status: 'fail', diagnostic: '相机位置发生了变化' },
        { id: 'case:blocked', label: '外观检查', assertion: 'evidence screenshot', status: 'blocked', diagnostic: '等待画面证据' },
      ];
      previewTestActivities.length = 0;
      previewTestActivities.push({ id: 'op:running', label: '模拟拖拽', expected: '提交指定拖拽输入', status: 'running' }, { id: 'op:done', label: '读取状态', expected: '返回当前运行状态', status: 'completed', tick: 12 });
      renderPreviewTestProgress();
      const table = element('play-agent-progress-table'), first = table.tBodies[0].rows[0];
      renderPreviewTestProgress(); const retained = table.tBodies[0].rows[0] === first;
      const rows = [...table.tBodies[0].rows].map(row => [...row.cells].map(cell => cell.textContent));
      const headers = [...table.tHead.rows[0].cells].map(cell => cell.textContent);
      fixtureTask.acceptance = original;
      return { rows, headers, retained, columns: [...table.tBodies[0].rows].every(row => row.cells.length === 3) };
    };
    window.previewApprovalFixture = async (mode, failRefresh = false) => {
      await window.previewUiFixture(mode);
      const waitingTask = { ...fixtureTask, status: 'waiting-user' };
      agentPreviewOwnership.update('project:test', [waitingTask]);
      const calls = []; let disposed = 0; let restored = 0;
      // Replace GPU creation and IPC transport only; exercise production poll/stop/page cleanup.
      WebGpuViewportRuntime.prototype.initialize = async () => { restored++; };
      previewFrame = { previewId: 'preview:approval', async dispose() { disposed++; return 3; } };
      window.haiyueStudio = { async invoke(request) {
        calls.push(request);
        if (failRefresh && request.channel === 'conversation/replay') throw Error('Fixture refresh failure');
        return { ok: true, payload: request.channel === 'conversation/replay' ? { revision: conversationRevision }
          : request.channel === 'preview/agent-command' ? { pending: false, command: null } : {} };
      }, cancel() {} };
      let refreshError = null;
      try { await pollAgent(); } catch (cause) { refreshError = cause.message; }
      if (!failRefresh) await pollAgent(); // repeated pushes cannot dispose/report twice
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { display: getComputedStyle(element('play-page')).display, editorDisplay: getComputedStyle(element('app')).display, playing, page: document.body.dataset.page, hidden: element('play-page').hidden,
        owned: agentPreviewOwnership.active, taskStatus: waitingTask.status, disposed, restored, refreshError,
        reports: calls.filter(call => call.channel === 'preview/report').map(call => call.payload),
        cancelledTask: calls.some(call => call.channel === 'conversation/intent') };
    };
    window.previewExitFixture = async (mode, outcome) => {
      await window.previewUiFixture(mode === 'manual' ? 'manual' : 'agent');
      if (mode === 'waiting') agentPreviewOwnership.update('project:test', [{ ...fixtureTask, status: 'waiting-user' }]);
      if (mode === 'missing-coordinates') agentPreviewOwnership.update('project:test', [{ ...fixtureTask, sessionId: null, turnId: null }]);
      updatePlayControls();
      const calls = []; let disposed = 0; let resolveCancel;
      WebGpuViewportRuntime.prototype.initialize = async () => {};
      previewFrame = { previewId: 'preview:manual-exit', async dispose() { disposed++; return 2; } };
      window.haiyueStudio = { async invoke(request) {
        calls.push(request);
        if (request.channel === 'conversation/intent') {
          if (outcome === 'delayed') return new Promise(resolve => { resolveCancel = () => resolve({ ok: true, payload: {} }); });
          return { ok: false, payload: { diagnostic: { message: 'Active turn coordinates changed.' } } };
        }
        return { ok: true, payload: {} };
      }, cancel() {} };
      const exitEnabled = !element('play-exit').disabled;
      element('play-exit').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const beforeCancel = { playing, page: document.body.dataset.page, display: getComputedStyle(element('play-page')).display, disposed };
      resolveCancel?.();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { exitEnabled, beforeCancel, disposed, status: element('status').textContent,
        cancels: calls.filter(call => call.channel === 'conversation/intent').map(call => call.payload.intent),
        reports: calls.filter(call => call.channel === 'preview/report').map(call => call.payload) };
    };
    window.previewRunConsentFixture = async (reusable) => {
      const originalPrepare = prepareProjectRun, originalStart = startPreview;
      const dialog = element('run-dialog'), originalShow = dialog.showModal;
      const calls = []; let starts = 0, dialogs = 0;
      playing = false; element('run-project').disabled = false;
      prepareProjectRun = async () => { previewDisclosure = { id: 'plan:reused', approvalReusable: reusable }; return true; };
      startPreview = async () => { starts++; playing = true; };
      dialog.showModal = () => { dialogs++; };
      window.haiyueStudio = { async invoke(request) { calls.push(request); return { ok:true, payload: request.channel === 'preview/authorize' ? {id:'grant:reused'} : {} }; }, cancel() {} };
      try { await toggleProjectRun(); return { starts, dialogs, reuse: calls.find(call=>call.channel==='preview/authorize')?.payload.reuse ?? false }; }
      finally { prepareProjectRun = originalPrepare; startPreview = originalStart; dialog.showModal = originalShow; playing = false; }
    };
    window.scriptPanelFixture = () => {
      const originalEditor = scriptEditor, originalScripts = scripts;
      let text = null;
      scriptEditor = { load(_id, value) { text = value; }, setReadOnly() {} };
      const selected = { id: 'entity:panel-test' };
      try {
        loadedScriptIdentity = ''; scripts = { ...scripts, resources: [] };
        renderScriptPanel(selected);
        const empty = { text, hint: element('script-diagnostics').textContent };
        scripts = { ...scripts, resources: [{ id: 'script:panel-test', entityId: selected.id, textRevision: 1, text: 'actual bound behavior' }] };
        renderScriptPanel(selected);
        return { empty, bound: text };
      } finally { scriptEditor = originalEditor; scripts = originalScripts; loadedScriptIdentity = ''; }
    };
    setupPlayPageControls();
  `;
  await build({ stdin: { contents: source + hook, sourcefile: 'renderer-fixture.ts', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), loader: 'ts' }, outfile: path.join(root, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', target: 'chrome142' });
  const html = await readFile(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../renderer/styles.css', import.meta.url), 'utf8');
  await writeFile(path.join(root, 'index.html'), html.replace('./renderer.js', './fixture.js').replace('<script src="./startup-guard.js"></script>', '').replace('</head>', `<style>${css}</style></head>`));
  const env = { ...process.env, HAIYUE_PREVIEW_UI_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fileURLToPath(new URL('./fixtures/agent-preview-ui-main.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => child.kill(), 45_000);
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  const { agent, manual, handoff, manualHandoff, refreshFailure, exits, approvedRun, newRun, scriptPanel, table } = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'));
  assert.deepEqual(table.headers, ['测试用例', '期望效果', '状态']);
  assert.equal(table.retained, true); assert.equal(table.columns, true); assert.equal(table.narrow, true);
  assert.deepEqual(table.rows.map(row => row[2]), ['待验证', '通过', '未通过', '待验证', '进行中', '通过']);
  assert.match(table.rows[1][1], /count 等于 0/); assert.match(table.rows[2][1], /相机位置发生了变化/);
  assert.match(table.rows[3][1], /等待画面证据/);
  assert.equal(scriptPanel.empty.text, '');
  assert.match(scriptPanel.empty.hint, /尚未绑定脚本.*属性面板/);
  assert.equal(scriptPanel.bound, 'actual bound behavior');
  assert.deepEqual(approvedRun, { starts: 1, dialogs: 0, reuse: true });
  assert.deepEqual(newRun, { starts: 0, dialogs: 1, reuse: false });
  assert.equal(agent.owner, 'agent'); assert.equal(agent.notice, true); assert.match(agent.text, /Agent.*自动返回/);
  assert.equal(agent.exit, '停止任务并退出'); assert.equal(agent.pauseDisabled, true); assert.equal(agent.resizeDisabled, true); assert.equal(agent.input, 'none'); assert.ok(agent.stageHeight > 300); assert.ok(agent.stageTop > agent.toolbarBottom);
  assert.equal(agent.progress, true); assert.match(agent.progressText, /模拟拖拽/); assert.match(agent.progressText, /拖拽后实体旋转/); assert.match(agent.progressText, /tick 12/);
  assert.equal(manual.progress, false);
  assert.equal(manual.owner, 'user'); assert.equal(manual.notice, false); assert.equal(manual.exit, '退出运行'); assert.equal(manual.pauseDisabled, false); assert.equal(manual.resizeDisabled, false); assert.equal(manual.input, 'auto'); assert.equal(manual.stageTop, manual.toolbarBottom);
  for (const result of [handoff, refreshFailure]) {
    assert.equal(result.playing, false); assert.equal(result.page, 'authoring'); assert.equal(result.hidden, true);
    assert.equal(result.display, 'none'); assert.notEqual(result.editorDisplay, 'none');
    assert.equal(result.owned, false); assert.equal(result.disposed, 1); assert.equal(result.restored, 1);
    assert.equal(result.taskStatus, 'waiting-user'); assert.equal(result.cancelledTask, false);
    assert.deepEqual(result.reports.map(report => [report.event, report.previewId]), [['stopped', 'preview:approval']]);
  }
  assert.match(refreshFailure.refreshError, /refresh failure/);
  assert.equal(manualHandoff.playing, true); assert.equal(manualHandoff.page, 'play'); assert.equal(manualHandoff.hidden, false);
  assert.notEqual(manualHandoff.display, 'none'); assert.equal(manualHandoff.editorDisplay, 'none');
  assert.equal(manualHandoff.disposed, 0); assert.deepEqual(manualHandoff.reports, []);
  for (const result of Object.values(exits)) {
    assert.equal(result.exitEnabled, true); assert.equal(result.beforeCancel.playing, false);
    assert.equal(result.beforeCancel.page, 'authoring'); assert.equal(result.beforeCancel.display, 'none');
    assert.equal(result.beforeCancel.disposed, 1); assert.equal(result.disposed, 1);
    assert.deepEqual(result.reports.map(report => report.previewId), ['preview:manual-exit']);
  }
  for (const name of ['stale', 'delayed']) assert.deepEqual(exits[name].cancels.map(intent => intent.type), ['conversation/cancel']);
  for (const name of ['waiting', 'manual', 'missing']) assert.deepEqual(exits[name].cancels, []);
  assert.match(exits.stale.status, /预览已退出.*未能确认任务停止/);
  assert.match(exits.missing.status, /预览已退出.*未能确认任务停止/);
  console.log(`[agent-preview-ui] evidence: ${root}`);
});
