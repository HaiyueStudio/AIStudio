import { app, BrowserWindow, protocol } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { CodexAppServerBackend, HarnessApiKeyBackend } from '@haiyue/ai-studio-agent-backends';
import { AgentBackendRegistry, AgentTurnRuntime, M12_DEFAULT_PRICING_CATALOG, PromptContextRuntime, TaskAccountingRegistry } from '@haiyue/ai-studio-agent-runtime';
import { ProjectSceneAuthoringService, ProjectWorkspace, RecentProjectStore } from '@haiyue/ai-studio-editor-plugins';
import { createPinnedHarnessAgentTransport } from '@haiyue/ai-studio-harness-bridge/agent';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { PreviewAuthorizationService, ProjectScriptService, ScriptValidationWorker } from '@haiyue/ai-studio-script-preview';
import { AgentGameAuthoringCoordinator, GameAuthoringToolRuntime } from '@haiyue/ai-studio-game-authoring-tools';
import { EvidenceCollector, compileG12ReplayProgram, contentDigest, evaluateCase, executeG12ReplayProgram, inspectG12GameplayContract, loadEvaluationAssets } from '../../evals/src/index.mjs';
import { BrowserWindowPreviewControl } from '../../apps/ai-studio/test/fixtures/g12-browser-window-preview-control.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1')), '..', '..');
const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--') && value.includes('=')).map((value) => { const index = value.indexOf('='); return [value.slice(2, index), value.slice(index + 1)]; }));
const backendKind = required(args.backend, ['harness', 'codex'], 'backend');
const genre = required(args.genre, ['snake', 'match-3', 'falling-blocks', 'jigsaw', 'platformer', 'racing', 'shooter'], 'genre');
const evidenceClass = required(args['evidence-class'] ?? 'formal', ['formal', 'preflight'], 'evidence-class');
const faultInjection = args['fault-injection'] ? required(args['fault-injection'], ['preview-window-close', 'run-error-after-ready'], 'fault-injection') : null;
if (faultInjection && evidenceClass !== 'preflight') throw new Error('--fault-injection is restricted to preflight evidence.');
const caseWallTimeMs = args['case-wall-time-ms'] ? positiveInteger(args['case-wall-time-ms'], 'case-wall-time-ms') : 15 * 60_000;
const G12_AUTHORING_TOOL_IDS = Object.freeze([
  'project.snapshot', 'engine.capabilities.describe', 'component.describe', 'component.get', 'camera.get', 'scene.list-entities', 'entity.get', 'script.get', 'diagnostics.query',
  'camera.set', 'entity.create', 'entity.rename', 'transform.set', 'material.set', 'component.add', 'component.set', 'component.remove', 'script.propose', 'script.apply',
  'preview.validate', 'play.start', 'play.stop', 'play.step', 'play.input', 'play.inspect', 'play.capture',
]);
const minimumTakeoverWindowMs = 2 * 60_000;
if (args['case-wall-time-ms'] && evidenceClass !== 'preflight') throw new Error('--case-wall-time-ms is restricted to preflight evidence.');
const outputRoot = path.resolve(args.output ?? path.join(root, 'evals', 'evidence', 'g12', 'runs'));
assertContained(outputRoot, path.join(root, 'evals', 'evidence', 'g12'));
if (process.env.HAIYUE_G12_ALLOW_REAL !== '1') throw new Error('G12 real runner requires HAIYUE_G12_ALLOW_REAL=1.');
const deepSeekSecret = backendKind === 'harness' ? process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET : null;
delete process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET;
if (backendKind === 'harness' && !deepSeekSecret) throw new Error('DeepSeek credential is unavailable.');

const revisions = revisionSet();
if (evidenceClass === 'formal') for (const [name, value] of Object.entries(revisions)) if (!value.clean) throw new Error(`g12.formal-revision-dirty:${name}`);
const runId = args['run-id'] ? runIdentifier(args['run-id']) : `g12-${backendKind}-${genre}-${randomUUID()}`;
const caseRoot = path.join(outputRoot, revisions.aistudio.revision.slice(0, 12), backendKind, genre, runId);
const projectRoot = path.join(caseRoot, 'project');
const userDataRoot = path.join(caseRoot, 'runtime');
await mkdir(projectRoot, { recursive: true }); await mkdir(userDataRoot, { recursive: true });
await atomicJson(path.join(caseRoot, 'case-start.json'), { schemaVersion: 1, runId, backend: backendKind, genre, evidenceClass, revisions, startedAt: new Date().toISOString() });
app.setPath('userData', path.join(userDataRoot, 'electron'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'g12host', privileges: { standard: true, secure: true, corsEnabled: true } },
  { scheme: 'haiyue-preview', privileges: { standard: true, secure: true, corsEnabled: true } },
]);

let settled = false; let finalizing = false; let cleanupInProgress = false; let partialWritten = false; let partialWriter = null;
const keepAlive = setInterval(() => {}, 1_000);
app.on('before-quit', (event) => { if (settled || finalizing) return; event.preventDefault(); if (!cleanupInProgress) void failAndExit(errorWithCode('g12.electron-premature-quit', 'Electron requested quit before the case emitted a terminal record.')); });
process.once('SIGTERM', () => { void failAndExit(errorWithCode('g12.case-parent-timeout', 'The matrix parent terminated this case after its wall-time budget.')); });
process.once('SIGINT', () => { void failAndExit(errorWithCode('g12.case-interrupted', 'The case was interrupted before completion.')); });
app.whenReady().then(run).then(() => { settled = true; clearInterval(keepAlive); app.exit(0); }).catch(failAndExit);

async function failAndExit(cause) {
  if (finalizing || settled) return;
  finalizing = true;
  const code = typeof cause?.code === 'string' ? cause.code : 'g12.real-case-failed';
  await preserveFailure(cause);
  await atomicJson(path.join(caseRoot, 'failure.json'), { schemaVersion: 1, runId, backend: backendKind, genre, evidenceClass, revisions, code, message: cause instanceof Error ? cause.message : String(cause), stack: cause instanceof Error ? cause.stack : null, completedAt: new Date().toISOString() }).catch(() => undefined);
  console.error(`[g12-real-case] ${JSON.stringify({ runId, backend: backendKind, genre, terminal: 'failed', evaluation: null, errorCode: code, caseRoot })}`);
  settled = true; clearInterval(keepAlive); app.exit(1);
}

async function run() {
  const assets = await loadEvaluationAssets();
  const testCase = assets.suite.cases.find((entry) => entry.genre === genre);
  const oracleCase = assets.oracle.cases.find((entry) => entry.caseId === testCase.id);
  const fixture = await createFixture(projectRoot, userDataRoot);
  let windowGuard; let backend; let coordinator; let turns; let preview; let account; let taskId; let model; let config; let summary;
  partialWriter = (cause) => preservePartialEvidence({ cause, fixture, preview, windowGuard, turns, account, taskId, backend, model, config, summary, testCase, oracleCase, assets });
  try {
    windowGuard = await createPreviewWindow();
    preview = new BrowserWindowPreviewControl(windowGuard.window); await windowGuard.race(preview.ready());
    if (faultInjection === 'preview-window-close') { windowGuard.window.destroy(); await windowGuard.race(new Promise((resolve) => setTimeout(resolve, 1_000))); }
    if (faultInjection === 'run-error-after-ready') throw errorWithCode('g12.injected-run-failure', 'Injected preflight failure after preview readiness.');
    fixture.runtime = new GameAuthoringToolRuntime({ workspace: fixture.workspace, scene: fixture.scene, scripts: fixture.scriptPort, diagnostics: fixture.operationLog.diagnosticsService(), operationLog: fixture.operationLog, preview });
    backend = await createBackend();
    const registry = new AgentBackendRegistry(); registry.register(backend);
    const context = new PromptContextRuntime(fixture.operationLog); await context.initialize();
    turns = new AgentTurnRuntime(registry, fixture.operationLog, context);
    const accounting = new TaskAccountingRegistry(turns.usage);
    taskId = asStableId(`task:g12-${backendKind}-${genre}-${randomUUID()}`);
    const budget = taskBudget(testCase);
    account = accounting.open({ taskId, budget, pricingCatalog: M12_DEFAULT_PRICING_CATALOG }); account.beginTurn();
    const catalog = await backend.modelCatalog(); model = chooseModel(catalog.models);
    const reasoningEffort = model.reasoningEfforts.includes(args.reasoning) ? args.reasoning : model.reasoningEfforts.includes('low') ? 'low' : model.defaultReasoningEffort;
    config = { schemaVersion: 2, backendId: backend.descriptor.id, model: model.id, reasoningEffort, outputTokenLimit: Math.min(32_768, model.maxOutputTokens), taskBudgetId: testCase.id.replace('game-eval:', 'budget:g12-'), promptProfile: { id: 'prompt:g12-general-game-authoring', version: '2.0.0', digest: contentDigest({ profile: 'g12-general-game-authoring', version: 2 }) }, requestedCapabilities: ['agent.model-config', 'agent.usage', 'agent.cache', 'agent.context'] };
    coordinator = new AgentGameAuthoringCoordinator(fixture.runtime, { async request() { return 'allow-once'; } }, turns, {
      questionTakeover: { async answer(event) { return defaultQuestionAnswer(event); } },
      maxToolRequests: 80,
      maxRepeatedToolRequests: 3,
      maxNoProgressToolRequests: 24,
      maxModelToolResultBytes: 12 * 1024,
      modelToolIds: G12_AUTHORING_TOOL_IDS,
    });
    const prompt = `${testCase.request}\n\n约束：\n${testCase.agentVisibleConstraints.map((value) => `- ${value}`).join('\n')}\n- 使用通用 api.scene.observe(id, value) 持续发布权威 gameplay 状态、累计事件和可选 normalized interactionTargets，供 Play 检查；不要猜测隐藏验收条件。\n- 完成后必须自行运行 Play，检查结构化状态和截图；若发现运行错误需修复后再结束。`;
    const controller = new AbortController(); const wallTimeError = errorWithCode('g12.case-wall-time-exceeded', 'G12 cold-create case exceeded its wall-time budget.'); const caseDeadlineMs = Date.now() + caseWallTimeMs; const timer = setTimeout(() => { controller.abort(wallTimeError); void failAndExit(wallTimeError); }, caseWallTimeMs);
    const boundTurnIds = new Set();
    const liveTurnUsage = new Map();
    const observeEvent = (event) => {
      if (!boundTurnIds.has(event.turnId)) {
        boundTurnIds.add(event.turnId);
        account.bindTurn(event.turnId, billingContext(model.id));
      }
      if (event.kind === 'tool-request' && typeof event.payload.toolCallId === 'string') {
        const decision = account.commitTool(asStableId(event.payload.toolCallId));
        if (!decision.allowed) controller.abort(errorWithCode('budget.hard-stop', 'Agent exceeded the formal tool-call budget.'));
      }
      if (event.kind === 'usage') {
        reconcileLiveUsage(liveTurnUsage, event);
        const totals = aggregateLiveUsage(liveTurnUsage);
        if (totals.inputTokens > budget.limits.inputTokens || totals.outputTokens > budget.limits.outputTokens) controller.abort(errorWithCode('budget.hard-stop', 'Agent exceeded the formal token budget.'));
      }
    };
    const summaries = [];
    try {
      const initial = await windowGuard.race(coordinator.run(backend, { taskId, config, prompt }, observeEvent, controller.signal));
      summaries.push(initial); summary = mergeTurnSummaries(summaries); commitToolResults(account, initial.results);
      let current = initial;
      let takeoverAttempts = 0;
      while (isRecoverableSummary(current) && takeoverAttempts < 2) {
        if (caseDeadlineMs - Date.now() < minimumTakeoverWindowMs) break;
        takeoverAttempts += 1;
        account.repair(); account.beginTurn();
        const takeoverPrompt = 'Studio 检测到上一回合发生可重试的传输或流中断。请从当前已保存的项目状态继续原任务；先读取 project.snapshot，保留已有产物，并完成尚未提交和验证的工作。';
        current = await windowGuard.race(coordinator.run(backend, { taskId, config, prompt: takeoverPrompt, ...(current.sessionId ? { sessionId: current.sessionId } : {}) }, observeEvent, controller.signal));
        summaries.push(current); summary = mergeTurnSummaries(summaries); commitToolResults(account, current.results);
      }
      if (current.terminal === 'completed' && enabledScriptCount(fixture.projectScripts.snapshot()) === 0 && caseDeadlineMs - Date.now() >= minimumTakeoverWindowMs) {
        account.repair(); account.beginTurn();
        const repairPrompt = 'Studio 自动检查发现当前项目仍没有已提交且启用的脚本。请继续原任务，使用通用 Studio 工具创建并提交至少一个脚本（script.propose 后执行 script.apply），随后运行 preview.validate；不要只描述方案，也不要结束于未提交状态。';
        const repair = await windowGuard.race(coordinator.run(backend, { taskId, config, prompt: repairPrompt, ...(current.sessionId ? { sessionId: current.sessionId } : {}) }, observeEvent, controller.signal));
        summaries.push(repair); summary = mergeTurnSummaries(summaries); commitToolResults(account, repair.results);
        current = repair;
      }
      let gameplayContract = inspectG12GameplayContract(fixture.projectScripts.snapshot());
      if (current.terminal === 'completed' && !gameplayContract.valid && caseDeadlineMs - Date.now() >= minimumTakeoverWindowMs) {
        account.repair(); account.beginTurn();
        const telemetryPrompt = `Studio 的通用 gameplay telemetry 检查未通过（${gameplayContract.diagnostics.join(', ')}）。请保留现有游戏功能并修复已提交脚本：每个固定步持续通过 api.scene.observe 发布权威 status/state，并用稳定的 lower-kebab-case events 或 triggers 数组发布所有实际发生的交互接受/拒绝、结算、碰撞、得分和终局转换。事件必须来自游戏状态转换，不可从 HUD 文本猜测。修复后重新提交脚本并运行 Play 自检。`;
        const repair = await windowGuard.race(coordinator.run(backend, { taskId, config, prompt: telemetryPrompt, ...(current.sessionId ? { sessionId: current.sessionId } : {}) }, observeEvent, controller.signal));
        summaries.push(repair); summary = mergeTurnSummaries(summaries); commitToolResults(account, repair.results); current = repair;
        gameplayContract = inspectG12GameplayContract(fixture.projectScripts.snapshot());
      }
      summary = mergeTurnSummaries(summaries);
      if (!gameplayContract.valid) throw errorWithCode('g12.gameplay-contract-missing', `Generated scripts do not satisfy the generic gameplay telemetry contract: ${gameplayContract.diagnostics.join(', ')}.`);
    } finally { clearTimeout(timer); }
    if (summary.terminal !== 'completed') {
      const convergence = summary.diagnostics.find((entry) => entry.code === 'agent.tool-loop-detected' || entry.code === 'agent.tool-progress-stalled' || entry.code === 'agent.tool-call-budget-exceeded');
      throw errorWithCode(convergence?.code ?? 'g12.agent-turn-not-completed', convergence?.message ?? `Agent turn ended with ${summary.terminal}.`);
    }
    if (enabledScriptCount(fixture.projectScripts.snapshot()) === 0) throw errorWithCode('g12.script-not-created', 'Agent completed both the initial and bounded repair turns without committing an enabled script.');
    await fixture.workspace.save();

    let attempt;
    for (let repairAttempt = 0; repairAttempt < 2; repairAttempt += 1) {
      try { attempt = await executePreviewReplay({ fixture, preview, windowGuard, testCase }); break; }
      catch (cause) {
        const repairable = cause?.code === 'g12.replay-runtime-error' || cause?.code === 'g12.replay-trigger-timeout';
        if (!repairable || repairAttempt > 0 || caseDeadlineMs - Date.now() < minimumTakeoverWindowMs) throw cause;
        const runtimeErrors = safeValue(() => preview.snapshot().errors, []).slice(0, 8).map((entry) => ({ code: entry.code, line: entry.line, column: entry.column, message: entry.message }));
        await preview.stop().catch(() => undefined);
        account.repair(); account.beginTurn();
        const repairPrompt = cause?.code === 'g12.replay-runtime-error'
          ? `Studio 的实际固定步 Play 检测到生成脚本运行错误：${JSON.stringify(runtimeErrors)}。请读取已提交脚本和 diagnostics，修复根因，重新提交并运行 Play 验证。不要删除现有 gameplay telemetry。`
          : 'Studio 的黑盒固定步 Play 检测到某个实际发生的权威状态转换没有通过通用 gameplay telemetry 发布。请检查所有交互接受/拒绝、动作结算、碰撞/恢复、计分和终局转换，在转换发生的 tick 将稳定 lower-kebab-case 名称加入 events/triggers，并重新提交和运行 Play。隐藏验收名称不可用，请从游戏规则和实际状态机推导。';
        const repair = await windowGuard.race(coordinator.run(backend, { taskId, config, prompt: repairPrompt, ...(summary.sessionId ? { sessionId: summary.sessionId } : {}) }, observeEvent, controller.signal));
        summaries.push(repair); summary = mergeTurnSummaries(summaries); commitToolResults(account, repair.results);
        if (repair.terminal !== 'completed') throw errorWithCode('g12.runtime-repair-not-completed', `Runtime repair turn ended with ${repair.terminal}.`);
        const contract = inspectG12GameplayContract(fixture.projectScripts.snapshot());
        if (!contract.valid) throw errorWithCode('g12.gameplay-contract-missing', `Runtime repair removed required gameplay telemetry: ${contract.diagnostics.join(', ')}.`);
      }
    }
    if (!attempt) throw errorWithCode('g12.replay-attempt-missing', 'Preview replay did not produce a terminal attempt.');
    const { scene, started, replay, stopped } = attempt;
    await fixture.workspace.save();
    const accountingSnapshot = account.reconcile();
    const png = Buffer.from(replay.capture.base64, 'base64'); const pngDigest = sha256(png); await writeFile(path.join(caseRoot, 'screenshot.png'), png);
    const signals = gameplaySignals(replay.finalObservation);
    const projectDigest = contentDigest({ scene, scripts: fixture.projectScripts.snapshot() });
    const collector = new EvidenceCollector({ runId, caseId: testCase.id, projectDigest, seed: assets.suite.sharedEnvironment.seed, viewport: assets.suite.sharedEnvironment.viewport, maxObservationBytes: assets.suite.sharedBudgets.maxObservationBytes });
    collector.collectAll([
      { type: 'state', tick: replay.finalTick, signals }, { type: 'event-trace', tick: replay.finalTick, signals },
      { type: 'input-replay', tick: replay.finalTick, signals: { ...signals, 'replay.deterministic': true } },
      { type: 'screenshot', tick: replay.finalTick, signals: { 'visual.pngCaptured': true }, media: { mediaType: 'image/png', digest: pngDigest, width: replay.capture.viewport.width, height: replay.capture.viewport.height, semanticAnalyzerVersion: 'none-fail-closed' } },
      { type: 'performance', tick: replay.finalTick, signals: { ...signals, 'simulation.finite': Number.isFinite(replay.finalTick) } },
      { type: 'lifecycle', tick: replay.finalTick, signals: { ...signals, 'residue.count': stopped.disposableCount } },
      { type: 'log', tick: replay.finalTick, signals: { 'runtime.unhandledErrors': replay.finalObservation.value.runtimeErrorCount ?? 0 } },
    ]);
    const evidenceManifest = collector.manifest(); const evaluation = evaluateCase({ testCase, oracleCase, evidenceManifest });
    const usageRecords = turns.usage.snapshots().filter((entry) => entry.taskId === taskId).map((entry) => entry.record);
    const report = { schemaVersion: 1, evidenceClass, runId, taskId, backend: { kind: backendKind, instanceId: backend.descriptor.id, protocolVersion: backend.descriptor.protocolVersion }, projectId: fixture.workspace.snapshot().document.projectId, conversationId: summary.sessionId, genre, caseId: testCase.id, revisions, model: { id: model.id, reasoningEffort, configDigest: contentDigest(config) }, prompt: { digest: contentDigest(prompt), profile: config.promptProfile }, terminal: summary.terminal, toolResults: summary.results.map((entry) => ({ callId: entry.callId, toolId: entry.toolId, status: entry.status, beforeRevision: entry.beforeRevision, afterRevision: entry.afterRevision })), diagnostics: summary.diagnostics, accounting: accountingSnapshot, usageRecords, costRecords: account.costRecords(), cache: accountingSnapshot.usage.contextCache ?? null, preview: { started, stopped, replayProgramVersion: replay.replayProgramVersion, semanticDriverIds: replay.semanticDriverIds, finalTick: replay.finalTick, stateDigest: contentDigest(replay.finalObservation), screenshotDigest: pngDigest }, evidenceManifest, evaluation };
    await atomicJson(path.join(caseRoot, 'task-report.json'), report);
    await atomicJson(path.join(caseRoot, 'checkpoint.json'), { schemaVersion: 1, runId, backend: backendKind, genre, status: evaluation.status === 'pass' && summary.terminal === 'completed' ? 'pass' : 'failed-acceptance', reportDigest: contentDigest(report), reportPath: path.relative(root, path.join(caseRoot, 'task-report.json')).replaceAll('\\', '/') });
    console.log(`[g12-real-case] ${JSON.stringify({ runId, backend: backendKind, genre, terminal: summary.terminal, evaluation: evaluation.status, passed: evaluation.passed, required: evaluation.passed + evaluation.failed, caseRoot })}`);
  } catch (cause) {
    await preserveFailure(cause);
    throw cause;
  } finally {
    cleanupInProgress = true;
    coordinator?.dispose(); fixture.runtime?.dispose(); if (turns) await turns.dispose().catch(() => undefined); else if (backend) await backend.dispose().catch(() => undefined); windowGuard?.close(); await disposeFixture(fixture);
  }
}

async function executePreviewReplay({ fixture, preview, windowGuard, testCase }) {
  if (preview.snapshot().state !== 'stopped') await windowGuard.race(preview.stop());
  const plan = await fixture.authorization.prepare();
  if (plan.diagnostics.some((entry) => entry.severity === 'error')) throw errorWithCode('g12.preview-validation-errors', `Preview validation returned ${plan.diagnostics.length} diagnostic(s).`);
  const scene = fixture.scene.snapshot();
  const started = await windowGuard.race(preview.start(scene, plan));
  const baseline = await windowGuard.race(preview.inspect());
  const replayProgram = compileG12ReplayProgram(testCase.inputReplay, { baseTick: baseline.tick });
  const replay = await windowGuard.race(executeG12ReplayProgram(preview, replayProgram, { capture: true, maxTriggerWaitTicks: 3_600 }));
  const stopped = await windowGuard.race(preview.stop());
  return { scene, started, replay, stopped };
}

async function preserveFailure(cause) {
  if (partialWritten) return;
  partialWritten = true;
  if (partialWriter) { try { await partialWriter(cause); return; } catch { /* Fall through to the minimal crash-safe record. */ } }
  const code = typeof cause?.code === 'string' ? cause.code : 'g12.real-case-failed';
  const partial = { schemaVersion: 1, evidenceClass, runId, backend: backendKind, genre, revisions, terminal: 'failed', error: { code, message: cause instanceof Error ? cause.message : String(cause) }, accounting: null, usageRecords: [], costRecords: [], cache: null, preservedProject: null, preview: null, evaluator: { status: 'not-run', reason: code }, completedAt: new Date().toISOString() };
  await atomicJson(path.join(caseRoot, 'partial-evidence.json'), partial).catch(() => undefined);
  await atomicJson(path.join(caseRoot, 'checkpoint.json'), { schemaVersion: 1, runId, backend: backendKind, genre, status: 'failed-infrastructure', errorCode: code, partialEvidenceDigest: contentDigest(partial), partialEvidencePath: path.relative(root, path.join(caseRoot, 'partial-evidence.json')).replaceAll('\\', '/') }).catch(() => undefined);
}

async function createPreviewWindow() {
  const window = new BrowserWindow({ width: 420, height: 880, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  let intentionalClose = false; let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; }); failure.catch(() => undefined);
  window.once('closed', () => { if (!intentionalClose) rejectFailure(errorWithCode('g12.preview-window-closed', 'The hidden preview window closed before case completion.')); });
  window.webContents.once('render-process-gone', (_event, details) => rejectFailure(errorWithCode('g12.preview-renderer-gone', `The hidden preview renderer exited: ${details.reason}.`)));
  const session = window.webContents.session; const host = path.join(root, 'apps', 'ai-studio', 'test', 'fixtures', 'g12-preview-host.html'); const previewRoot = path.join(root, 'apps', 'ai-studio', 'dist');
  session.protocol.handle('g12host', async () => new Response(new Uint8Array(await readFile(host)), { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  session.protocol.handle('haiyue-preview', async (request) => { const candidate = path.resolve(previewRoot, new URL(request.url).pathname.replace(/^\//u, '')); assertContained(candidate, previewRoot); const bytes = await readFile(candidate); return new Response(new Uint8Array(bytes), { headers: { 'content-type': candidate.endsWith('.html') ? 'text/html; charset=utf-8' : candidate.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' } }); });
  await window.loadURL('g12host://app/host.html');
  return { window, race: (operation) => Promise.race([operation, failure]), close() { intentionalClose = true; if (!window.isDestroyed()) window.destroy(); } };
}

async function preservePartialEvidence({ cause, fixture, preview, windowGuard, turns, account, taskId, backend, model, config, summary, testCase, oracleCase, assets }) {
  const code = typeof cause?.code === 'string' ? cause.code : 'g12.real-case-failed';
  await fixture.workspace.save().catch(() => undefined);
  const usageRecords = taskId && turns ? turns.usage.snapshots().filter((entry) => entry.taskId === taskId).map((entry) => entry.record) : [];
  if (account && model) for (const record of usageRecords) safeValue(() => account.bindTurn(asStableId(record.turnId), billingContext(model.id)), undefined);
  const accounting = account ? safeValue(() => account.reconcile(), null) : null;
  const costRecords = account ? safeValue(() => account.costRecords(), []) : [];
  const scene = safeValue(() => fixture.scene.snapshot(), null);
  const scripts = safeValue(() => fixture.projectScripts.snapshot(), null);
  const previewSnapshot = preview ? safeValue(() => preview.snapshot(), null) : null;
  let observation = null; let screenshot = null;
  if (preview && ['running', 'playing', 'paused', 'faulted'].includes(previewSnapshot?.state)) {
    observation = await preview.inspect().catch(() => null);
    const capture = await preview.capture().catch(() => null);
    if (capture?.base64) {
      const png = Buffer.from(capture.base64, 'base64');
      await writeFile(path.join(caseRoot, 'partial-screenshot.png'), png).catch(() => undefined);
      screenshot = { digest: sha256(png), width: capture.viewport?.width ?? 1, height: capture.viewport?.height ?? 1, path: 'partial-screenshot.png', captureKind: 'gameplay-partial' };
    }
  }
  if (!screenshot) {
    let png = null; let width = 1; let height = 1; let captureKind = 'placeholder-fail-closed';
    if (windowGuard?.window && !windowGuard.window.isDestroyed()) {
      const image = await windowGuard.window.webContents.capturePage().catch(() => null);
      if (image && !image.isEmpty()) { png = image.toPNG(); ({ width, height } = image.getSize()); captureKind = 'preview-host-forensic'; }
    }
    png ??= Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await writeFile(path.join(caseRoot, 'partial-screenshot.png'), png).catch(() => undefined);
    screenshot = { digest: sha256(png), width, height, path: 'partial-screenshot.png', captureKind };
  }
  const tick = Number.isSafeInteger(observation?.tick) && observation.tick >= 0 ? observation.tick : 0;
  const stateSignals = { ...(observation ? gameplaySignals(observation) : {}), 'failure.present': true };
  const projectDigest = contentDigest({ scene, scripts });
  const collector = new EvidenceCollector({ runId, caseId: testCase.id, projectDigest, seed: assets.suite.sharedEnvironment.seed, viewport: assets.suite.sharedEnvironment.viewport, maxObservationBytes: assets.suite.sharedBudgets.maxObservationBytes });
  collector.collectAll([
    { type: 'state', tick, signals: stateSignals },
    { type: 'screenshot', tick, signals: { 'visual.pngCaptured': false, 'failure.forensicCapture': true }, media: { mediaType: 'image/png', digest: screenshot.digest, width: screenshot.width, height: screenshot.height, semanticAnalyzerVersion: `failure-${screenshot.captureKind}` } },
    { type: 'log', tick, signals: { 'runtime.unhandledErrors': previewSnapshot?.errors?.length ?? 0, 'failure.present': true } },
    { type: 'lifecycle', tick, signals: { 'residue.count': previewSnapshot?.disposableCount ?? 0, 'failure.present': true } },
  ]);
  const evidenceManifest = collector.manifest();
  const evaluation = evaluateCase({ testCase, oracleCase, evidenceManifest });
  const partial = {
    schemaVersion: 1, evidenceClass, runId, backend: backendKind, genre, caseId: testCase?.id ?? null, revisions,
    terminal: 'failed', error: { code, message: cause instanceof Error ? cause.message : String(cause) },
    taskId: taskId ?? null, backendDescriptor: backend ? { kind: backendKind, instanceId: backend.descriptor.id, protocolVersion: backend.descriptor.protocolVersion } : null,
    model: model ? { id: model.id, reasoningEffort: config?.reasoningEffort ?? null, configDigest: config ? contentDigest(config) : null } : null,
    conversationId: summary?.sessionId ?? null, toolResults: summary?.results?.map((entry) => ({ callId: entry.callId, toolId: entry.toolId, status: entry.status, beforeRevision: entry.beforeRevision, afterRevision: entry.afterRevision })) ?? [],
    diagnostics: summary?.diagnostics ?? [],
    accounting, usageRecords, costRecords, cache: accounting?.usage?.contextCache ?? null,
    preservedProject: { saved: true, projectId: safeValue(() => fixture.workspace.snapshot().document.projectId, null), sceneDigest: scene ? contentDigest(scene) : null, scriptSetDigest: scripts ? contentDigest(scripts) : null, scriptCount: enabledScriptCount(scripts) },
    preview: { snapshot: previewSnapshot, observationDigest: observation ? contentDigest(observation) : null, screenshot },
    evidenceManifest, evaluator: evaluation, completedAt: new Date().toISOString(),
  };
  const partialPath = path.join(caseRoot, 'partial-evidence.json');
  await atomicJson(partialPath, partial);
  await atomicJson(path.join(caseRoot, 'checkpoint.json'), { schemaVersion: 1, runId, backend: backendKind, genre, status: 'failed-infrastructure', errorCode: code, partialEvidenceDigest: contentDigest(partial), partialEvidencePath: path.relative(root, partialPath).replaceAll('\\', '/') });
}

async function createBackend() { return backendKind === 'harness' ? new HarnessApiKeyBackend({ transport: await createPinnedHarnessAgentTransport({ resolveApiKey: async () => deepSeekSecret }), clearApiKey: async () => {} }) : new CodexAppServerBackend(); }
async function createFixture(projectRoot, userDataRoot) { const operationLog = await OperationLog.open({ rootDirectory: path.join(userDataRoot, 'log'), appVersion: 'g12-real-cold-case' }); const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(userDataRoot) }; const workspace = new ProjectWorkspace(resources); await workspace.newProject(projectRoot, `G12 ${backendKind} ${genre}`); const scene = new ProjectSceneAuthoringService(workspace, operationLog); const validator = new ScriptValidationWorker(); const projectScripts = new ProjectScriptService(workspace, validator, operationLog); const authorization = new PreviewAuthorizationService(projectScripts, validator, operationLog); const scriptPort = { snapshot: () => projectScripts.snapshot(), proposeEdit: (input) => projectScripts.proposeEdit(input), commitProposal: (proposalId, commandId, signal) => projectScripts.commitProposal(proposalId, commandId, signal), prepare: (input) => authorization.prepare(input), decide: (planId, approved, ttl) => authorization.decide(planId, approved, ttl), consume: (grantId) => authorization.consume(grantId) }; return { operationLog, resources, workspace, scene, validator, projectScripts, authorization, scriptPort, runtime: null }; }
async function disposeFixture(value) { value.authorization.dispose(); value.scene.dispose(); value.projectScripts.dispose(); await value.validator.dispose(); await value.workspace.dispose(); value.resources.tasks.dispose(); await value.resources.documents.dispose(); value.resources.history.dispose(); value.resources.projectSession.dispose(); await value.operationLog.close(); }
function taskBudget(testCase) { const shared = { inputTokens: 1_000_000, outputTokens: 120_000, estimatedCostMicros: 25_000_000, wallTimeMs: 900_000, turns: 8, toolCalls: 80, repairIterations: 4, observationBytes: 16_777_216 }; return { schemaVersion: 2, id: testCase.id.replace('game-eval:', 'budget:g12-'), enforcement: 'hard', limits: shared }; }
function chooseModel(models) { const requested = args.model && models.find((entry) => entry.id === args.model); const priced = models.find((entry) => M12_DEFAULT_PRICING_CATALOG.entries.some((price) => price.model === entry.id)); return requested ?? models.find((entry) => entry.isDefault) ?? priced ?? models[0]; }
function gameplaySignals(observation) { const output = {}; for (const record of observation.value.gameplay ?? []) flatten(record.value, '', output); return output; }
function flatten(value, prefix, output) { if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') { if (prefix && /^[a-z][a-zA-Z0-9.-]{2,127}$/u.test(prefix)) output[prefix] = value; return; } if (!value || typeof value !== 'object' || Array.isArray(value)) return; for (const [key, entry] of Object.entries(value)) flatten(entry, prefix ? `${prefix}.${key}` : key, output); }
function billingContext(modelId) { return { provider: backendKind === 'harness' ? 'deepseek' : 'openai', model: modelId, billingMode: backendKind === 'harness' ? 'api' : 'subscription' }; }
function commitToolResults(account, results) { for (const result of results) account.commitTool(result.callId); }
function reconcileLiveUsage(store, event) { const previous = store.get(event.turnId) ?? { inputTokens: 0, outputTokens: 0 }; const mode = event.payload.mode === 'cumulative' ? 'cumulative' : 'delta'; const inputTokens = nonNegativeInteger(event.payload.inputTokens); const outputTokens = nonNegativeInteger(event.payload.outputTokens); store.set(event.turnId, { inputTokens: mode === 'cumulative' ? inputTokens : previous.inputTokens + inputTokens, outputTokens: mode === 'cumulative' ? outputTokens : previous.outputTokens + outputTokens }); }
function aggregateLiveUsage(store) { return [...store.values()].reduce((sum, entry) => ({ inputTokens: sum.inputTokens + entry.inputTokens, outputTokens: sum.outputTokens + entry.outputTokens }), { inputTokens: 0, outputTokens: 0 }); }
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function enabledScriptCount(snapshot) { const resources = Array.isArray(snapshot) ? snapshot : snapshot?.resources ?? snapshot?.scripts ?? []; return resources.filter((entry) => entry?.enabled !== false).length; }
function mergeTurnSummaries(summaries) { const last = summaries.at(-1); return Object.freeze({ backendId: last.backendId, sessionId: last.sessionId ?? summaries.findLast((entry) => entry.sessionId)?.sessionId ?? null, turnId: last.turnId, terminal: last.terminal, results: Object.freeze(summaries.flatMap((entry) => entry.results)), diagnostics: Object.freeze(summaries.flatMap((entry) => entry.diagnostics)) }); }
function isRecoverableSummary(summary) { return summary.terminal === 'interrupted' && summary.diagnostics.some((entry) => entry.code === 'TRANSPORT' || entry.code === 'agent.stream-without-terminal' || entry.code === 'agent.rate-limited'); }
function defaultQuestionAnswer(event) {
  const questions = Array.isArray(event.payload.questions) ? event.payload.questions : [];
  const answer = {};
  for (const question of questions) {
    if (!question || typeof question !== 'object' || typeof question.id !== 'string' || !question.id) continue;
    const first = Array.isArray(question.options) ? question.options[0] : null;
    const selected = first && typeof first === 'object'
      ? typeof first.value === 'string' ? first.value : typeof first.label === 'string' ? first.label : null
      : typeof first === 'string' ? first : null;
    answer[question.id] = { answers: [selected ?? '请采用安全、通用且可验证的默认方案继续执行当前任务。'] };
  }
  return answer;
}
function revisionSet() { const repositories = { aistudio: root, engine: path.resolve(root, '..', 'Engine'), milestones: path.resolve(root, '..', 'milestones') }; return Object.fromEntries(Object.entries(repositories).map(([name, directory]) => [name, { revision: git(directory, ['rev-parse', 'HEAD']), clean: git(directory, ['status', '--porcelain']) === '' }])); }
function git(directory, values) { const result = spawnSync('git', ['-C', directory, ...values], { encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
function sha256(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
async function atomicJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, file); }
function required(value, allowed, name) { if (!allowed.includes(value)) throw new Error(`--${name} must be ${allowed.join(' or ')}.`); return value; }
function positiveInteger(value, name) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`--${name} must be a positive integer.`); return result; }
function runIdentifier(value) { if (!/^g12-(?:harness|codex)-(?:snake|match-3|falling-blocks|jigsaw|platformer|racing|shooter)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error('--run-id is invalid.'); return value; }
function errorWithCode(code, message) { const error = new Error(message); error.code = code; return error; }
function safeValue(read, fallback) { try { return read(); } catch { return fallback; } }
function assertContained(candidate, parent) { const resolved = path.resolve(candidate), rootPath = path.resolve(parent); if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) throw new Error(`Path escapes ${rootPath}: ${resolved}`); }
