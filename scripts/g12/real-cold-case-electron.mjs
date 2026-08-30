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
import { EvidenceCollector, compileG12ReplayProgram, contentDigest, evaluateCase, executeG12ReplayProgram, loadEvaluationAssets } from '../../evals/src/index.mjs';
import { BrowserWindowPreviewControl } from '../../apps/ai-studio/test/fixtures/g12-browser-window-preview-control.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1')), '..', '..');
const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--') && value.includes('=')).map((value) => { const index = value.indexOf('='); return [value.slice(2, index), value.slice(index + 1)]; }));
const backendKind = required(args.backend, ['harness', 'codex'], 'backend');
const genre = required(args.genre, ['snake', 'match-3', 'falling-blocks', 'jigsaw', 'platformer', 'racing', 'shooter'], 'genre');
const evidenceClass = required(args['evidence-class'] ?? 'formal', ['formal', 'preflight'], 'evidence-class');
const outputRoot = path.resolve(args.output ?? path.join(root, 'evals', 'evidence', 'g12', 'runs'));
assertContained(outputRoot, path.join(root, 'evals', 'evidence', 'g12'));
if (process.env.HAIYUE_G12_ALLOW_REAL !== '1') throw new Error('G12 real runner requires HAIYUE_G12_ALLOW_REAL=1.');
const deepSeekSecret = backendKind === 'harness' ? process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET : null;
delete process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET;
if (backendKind === 'harness' && !deepSeekSecret) throw new Error('DeepSeek credential is unavailable.');

const revisions = revisionSet();
if (evidenceClass === 'formal') for (const [name, value] of Object.entries(revisions)) if (!value.clean) throw new Error(`g12.formal-revision-dirty:${name}`);
const runId = `g12-${backendKind}-${genre}-${randomUUID()}`;
const caseRoot = path.join(outputRoot, revisions.aistudio.revision.slice(0, 12), backendKind, genre, runId);
const projectRoot = path.join(caseRoot, 'project');
const userDataRoot = path.join(caseRoot, 'runtime');
await mkdir(projectRoot, { recursive: true }); await mkdir(userDataRoot, { recursive: true });
app.setPath('userData', path.join(userDataRoot, 'electron'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'g12host', privileges: { standard: true, secure: true, corsEnabled: true } },
  { scheme: 'haiyue-preview', privileges: { standard: true, secure: true, corsEnabled: true } },
]);

app.whenReady().then(run).then(() => app.exit(0)).catch(async (cause) => {
  await atomicJson(path.join(caseRoot, 'failure.json'), { schemaVersion: 1, runId, backend: backendKind, genre, evidenceClass, revisions, code: typeof cause?.code === 'string' ? cause.code : 'g12.real-case-failed', message: cause instanceof Error ? cause.message : String(cause), stack: cause instanceof Error ? cause.stack : null }).catch(() => undefined);
  console.error(`[g12-real-case] ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`); app.exit(1);
});

async function run() {
  const assets = await loadEvaluationAssets();
  const testCase = assets.suite.cases.find((entry) => entry.genre === genre);
  const oracleCase = assets.oracle.cases.find((entry) => entry.caseId === testCase.id);
  const fixture = await createFixture(projectRoot, userDataRoot);
  let window; let backend; let coordinator; let turns;
  try {
    window = await createPreviewWindow();
    const preview = new BrowserWindowPreviewControl(window); await preview.ready();
    fixture.runtime = new GameAuthoringToolRuntime({ workspace: fixture.workspace, scene: fixture.scene, scripts: fixture.scriptPort, diagnostics: fixture.operationLog.diagnosticsService(), operationLog: fixture.operationLog, preview });
    backend = await createBackend();
    const registry = new AgentBackendRegistry(); registry.register(backend);
    const context = new PromptContextRuntime(fixture.operationLog); await context.initialize();
    turns = new AgentTurnRuntime(registry, fixture.operationLog, context);
    const accounting = new TaskAccountingRegistry(turns.usage);
    const taskId = asStableId(`task:g12-${backendKind}-${genre}-${randomUUID()}`);
    const account = accounting.open({ taskId, budget: taskBudget(testCase), pricingCatalog: M12_DEFAULT_PRICING_CATALOG }); account.beginTurn();
    const catalog = await backend.modelCatalog(); const model = chooseModel(catalog.models);
    const reasoningEffort = model.reasoningEfforts.includes(args.reasoning) ? args.reasoning : model.reasoningEfforts.includes('low') ? 'low' : model.defaultReasoningEffort;
    const config = { schemaVersion: 2, backendId: backend.descriptor.id, model: model.id, reasoningEffort, outputTokenLimit: Math.min(32_768, model.maxOutputTokens), taskBudgetId: testCase.id.replace('game-eval:', 'budget:g12-'), promptProfile: { id: 'prompt:g12-general-game-authoring', version: '2.0.0', digest: contentDigest({ profile: 'g12-general-game-authoring', version: 2 }) }, requestedCapabilities: ['agent.model-config', 'agent.usage', 'agent.cache', 'agent.context'] };
    coordinator = new AgentGameAuthoringCoordinator(fixture.runtime, { async request() { return 'allow-once'; } }, turns);
    const prompt = `${testCase.request}\n\n约束：\n${testCase.agentVisibleConstraints.map((value) => `- ${value}`).join('\n')}\n- 使用通用 api.scene.observe(id, value) 持续发布权威 gameplay 状态、累计事件和可选 normalized interactionTargets，供 Play 检查；不要猜测隐藏验收条件。\n- 完成后必须自行运行 Play，检查结构化状态和截图；若发现运行错误需修复后再结束。`;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error('G12 cold-create case exceeded fifteen minutes.')), 15 * 60_000);
    let summary;
    try { summary = await coordinator.run(backend, { taskId, config, prompt }, undefined, controller.signal); } finally { clearTimeout(timer); }
    if (summary.turnId) account.bindTurn(summary.turnId, { provider: backendKind === 'harness' ? 'deepseek' : 'openai', model: model.id, billingMode: backendKind === 'harness' ? 'api' : 'subscription' });
    for (const result of summary.results) account.commitTool(result.callId);
    const accountingSnapshot = account.reconcile();
    await fixture.workspace.save();

    const plan = await fixture.authorization.prepare();
    if (plan.diagnostics.some((entry) => entry.severity === 'error')) throw new Error(`g12.preview-validation-errors:${plan.diagnostics.length}`);
    const scene = fixture.scene.snapshot(); const started = await preview.start(scene, plan); const baseline = await preview.inspect();
    const replayProgram = compileG12ReplayProgram(testCase.inputReplay, { baseTick: baseline.tick });
    const replay = await executeG12ReplayProgram(preview, replayProgram, { capture: true, maxTriggerWaitTicks: 3_600 });
    const stopped = await preview.stop();
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
  } finally {
    coordinator?.dispose(); fixture.runtime?.dispose(); if (turns) await turns.dispose().catch(() => undefined); else if (backend) await backend.dispose().catch(() => undefined); if (window && !window.isDestroyed()) window.destroy(); await disposeFixture(fixture);
  }
}

async function createPreviewWindow() {
  const window = new BrowserWindow({ width: 420, height: 880, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  const session = window.webContents.session; const host = path.join(root, 'apps', 'ai-studio', 'test', 'fixtures', 'g12-preview-host.html'); const previewRoot = path.join(root, 'apps', 'ai-studio', 'dist');
  session.protocol.handle('g12host', async () => new Response(new Uint8Array(await readFile(host)), { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  session.protocol.handle('haiyue-preview', async (request) => { const candidate = path.resolve(previewRoot, new URL(request.url).pathname.replace(/^\//u, '')); assertContained(candidate, previewRoot); const bytes = await readFile(candidate); return new Response(new Uint8Array(bytes), { headers: { 'content-type': candidate.endsWith('.html') ? 'text/html; charset=utf-8' : candidate.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' } }); });
  await window.loadURL('g12host://app/host.html'); return window;
}

async function createBackend() { return backendKind === 'harness' ? new HarnessApiKeyBackend({ transport: await createPinnedHarnessAgentTransport({ resolveApiKey: async () => deepSeekSecret }), clearApiKey: async () => {} }) : new CodexAppServerBackend(); }
async function createFixture(projectRoot, userDataRoot) { const operationLog = await OperationLog.open({ rootDirectory: path.join(userDataRoot, 'log'), appVersion: 'g12-real-cold-case' }); const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(userDataRoot) }; const workspace = new ProjectWorkspace(resources); await workspace.newProject(projectRoot, `G12 ${backendKind} ${genre}`); const scene = new ProjectSceneAuthoringService(workspace, operationLog); const validator = new ScriptValidationWorker(); const projectScripts = new ProjectScriptService(workspace, validator, operationLog); const authorization = new PreviewAuthorizationService(projectScripts, validator, operationLog); const scriptPort = { snapshot: () => projectScripts.snapshot(), proposeEdit: (input) => projectScripts.proposeEdit(input), commitProposal: (proposalId, commandId, signal) => projectScripts.commitProposal(proposalId, commandId, signal), prepare: (input) => authorization.prepare(input), decide: (planId, approved, ttl) => authorization.decide(planId, approved, ttl), consume: (grantId) => authorization.consume(grantId) }; return { operationLog, resources, workspace, scene, validator, projectScripts, authorization, scriptPort, runtime: null }; }
async function disposeFixture(value) { value.authorization.dispose(); value.scene.dispose(); value.projectScripts.dispose(); await value.validator.dispose(); await value.workspace.dispose(); value.resources.tasks.dispose(); await value.resources.documents.dispose(); value.resources.history.dispose(); value.resources.projectSession.dispose(); await value.operationLog.close(); }
function taskBudget(testCase) { const shared = { inputTokens: 2_000_000, outputTokens: 250_000, estimatedCostMicros: 50_000_000, wallTimeMs: 900_000, turns: 8, toolCalls: 120, repairIterations: 3, observationBytes: 16_777_216 }; return { schemaVersion: 2, id: testCase.id.replace('game-eval:', 'budget:g12-'), enforcement: 'hard', limits: shared }; }
function chooseModel(models) { const requested = args.model && models.find((entry) => entry.id === args.model); const priced = models.find((entry) => M12_DEFAULT_PRICING_CATALOG.entries.some((price) => price.model === entry.id)); return requested ?? models.find((entry) => entry.isDefault) ?? priced ?? models[0]; }
function gameplaySignals(observation) { const output = {}; for (const record of observation.value.gameplay ?? []) flatten(record.value, '', output); return output; }
function flatten(value, prefix, output) { if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') { if (prefix && /^[a-z][a-zA-Z0-9.-]{2,127}$/u.test(prefix)) output[prefix] = value; return; } if (!value || typeof value !== 'object' || Array.isArray(value)) return; for (const [key, entry] of Object.entries(value)) flatten(entry, prefix ? `${prefix}.${key}` : key, output); }
function revisionSet() { const repositories = { aistudio: root, engine: path.resolve(root, '..', 'Engine'), milestones: path.resolve(root, '..', 'milestones') }; return Object.fromEntries(Object.entries(repositories).map(([name, directory]) => [name, { revision: git(directory, ['rev-parse', 'HEAD']), clean: git(directory, ['status', '--porcelain']) === '' }])); }
function git(directory, values) { const result = spawnSync('git', ['-C', directory, ...values], { encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
function sha256(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
async function atomicJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, file); }
function required(value, allowed, name) { if (!allowed.includes(value)) throw new Error(`--${name} must be ${allowed.join(' or ')}.`); return value; }
function assertContained(candidate, parent) { const resolved = path.resolve(candidate), rootPath = path.resolve(parent); if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) throw new Error(`Path escapes ${rootPath}: ${resolved}`); }
