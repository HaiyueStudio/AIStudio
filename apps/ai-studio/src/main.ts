import { ProjectAgentHistory, sha256 } from '@haiyue/ai-studio-operation-log';
import { renderCanvasTexture } from './canvas-texture-renderer.js';
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineEditorAppDescriptor } from '@haiyue/editor-app-kit';
import { asStableId, defineStudioPlugin, type JsonObject, type JsonValue, type StudioPluginDefinition } from '@haiyue/ai-studio-contracts';
import {
  createProjectWorkspacePlugin,
  createSceneAuthoringPlugins,
  projectWorkspaceServiceToken,
  sceneAuthoringToken,
  sceneSelectionToken,
} from '@haiyue/ai-studio-editor-plugins';
import { createHarnessStudioRoot } from '@haiyue/ai-studio-harness-bridge';
import { agentRuntimeServiceToken } from '@haiyue/ai-studio-agent-runtime';
import { gameAuthoringToolServiceToken } from '@haiyue/ai-studio-game-authoring-tools';
import { createEditorFoundationProviderPlugin } from '@haiyue/ai-studio-kernel';
import { createOperationLogPlugin, operationLogServiceToken } from '@haiyue/ai-studio-operation-log';
import { createScriptPreviewPlugin, scriptPreviewServiceToken } from '@haiyue/ai-studio-script-preview';
import { createStudioWorkspaceLayoutPlugin, studioWorkspaceLayoutToken } from '@haiyue/ai-studio-shell';
import {
  STUDIO_CONVERSATION_CHANGED_CHANNEL,
  STUDIO_IPC_CANCEL_CHANNEL,
  STUDIO_IPC_CHANNEL,
  StudioIpcRouter,
} from './ipc.js';
import { AgentPreviewBroker } from './agent-preview-broker.js';
import { ProjectBehaviorController, ProjectConversationController, ProjectEditorController, StudioSessionOrchestrator } from '@haiyue/ai-studio-agent-orchestration';
import { createWorkspaceEditorPorts } from './editor-adapters.js';
import { createWorkspaceBehaviorPorts } from './behavior-adapters.js';
import { RecoveryClaimStore } from './session-orchestrator/index.js';
import { createWorkspaceRecoveryAuthority } from './session-orchestrator/workspace-recovery.js';
import { DeepSeekCredentialStore } from './deepseek-credential-store.js';
import { createPocAgentGameAuthoringPlugins, POC_COMMON_PLUGIN_IDS, selectPocEditorProfile } from './profiles/agent-game-authoring.js';
import { installStdioErrorGuards } from './stdio-safety.js';
import { StudioKnowledgeSourceLoader } from './knowledge-source-loader.js';

const descriptor = defineEditorAppDescriptor({
  schemaVersion: 1,
  id: 'haiyue-ai-studio',
  version: '0.0.0',
  productName: 'HaiYue AIStudio',
  appId: 'studio.haiyue.ai',
  artifactName: 'haiyue-ai-studio',
  storageNamespace: 'haiyue-ai-studio-poc',
  supportTier: 'experimental',
  entries: ['main.js', 'preload.cjs', 'renderer.js', 'preview-runtime.js', 'chunks/chunk.js', 'index.html', 'styles.css', 'preview.html', 'preview.css'],
  staticFiles: ['index.html', 'styles.css', 'resources.css', 'advanced-authoring.css', 'preview.html', 'preview.css'],
  workers: [],
  distDirectory: 'dist',
  outputDirectory: 'release',
  electronRendererDirectory: 'dist',
  budget: { maxRawBytes: 2_000_000, maxGzipBytes: 700_000 },
  pwa: { enabled: false, shortName: 'AIStudio', description: 'AI-native game studio POC', themeColor: '#10151d', backgroundColor: '#10151d' },
  electron: { enabled: true, width: 1440, height: 900, minWidth: 1024, minHeight: 700, backgroundColor: '#10151d' },
});

const smoke = process.env.HAIYUE_ELECTRON_SMOKE === '1';
const openDevTools = process.env.HAIYUE_OPEN_DEVTOOLS === '1';
installStdioErrorGuards([process.stdout, process.stderr], (cause) => { void traceBoot(`stdio:failed:${errorMessage(cause)}`); });
const previewScheme = 'haiyue-preview';
const previewAssets = new Map<string, string>([
  ['/preview.html', 'preview.html'],
  ['/preview.css', 'preview.css'],
  ['/preview-runtime.js', 'preview-runtime.js'],
]);
protocol.registerSchemesAsPrivileged([{
  scheme: previewScheme,
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true },
}]);
const configuredUserData = process.env.HAIYUE_ELECTRON_USER_DATA?.trim();
app.setPath('userData', configuredUserData || path.join(app.getPath('appData'), descriptor.productName));
const root = createHarnessStudioRoot();
const agentPreview = new AgentPreviewBroker();
let projectBehavior: ProjectBehaviorController | null = null;
let mainWindow: BrowserWindow | null = null;
let activeRouter: StudioIpcRouter | null = null;
let shuttingDown = false;
let smokeDeadline: ReturnType<typeof setTimeout> | null = null;
const agentProfile = selectPocEditorProfile(process.env.HAIYUE_AGENT_PROFILE);
const pocPluginIds = POC_COMMON_PLUGIN_IDS;

function createElectronIpcPlugin(): StudioPluginDefinition<JsonObject> {
  return defineStudioPlugin({
    manifest: {
      schemaVersion: 1,
      id: asStableId('studio.electron-ipc.plugin'),
      version: '0.0.0',
      apiVersion: '1.0',
      required: [
        { id: asStableId('studio.project-workspace'), version: '1.0.0' },
        { id: asStableId('studio.operation-log'), version: '1.0.0' },
        { id: asStableId('studio.workspace-layout'), version: '1.0.0' },
        { id: asStableId('studio.scene-authoring'), version: '1.0.0' },
        { id: asStableId('studio.scene-selection'), version: '1.0.0' },
        { id: asStableId('studio.script-preview'), version: '1.0.0' },
        { id: asStableId('studio.game-authoring-tools'), version: '1.0.0' },
        { id: asStableId('studio.agent-runtime'), version: '1.0.0' },
      ],
      optional: [], provides: [], contributions: [], activationPolicy: 'required',
    },
    validateConfig(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) throw new TypeError('Electron IPC config must be empty.');
      return Object.freeze({});
    },
    async activate(context) {
      const workspace = context.services.get(projectWorkspaceServiceToken);
      const operationLog = context.services.get(operationLogServiceToken).log;
      const layout = context.services.get(studioWorkspaceLayoutToken);
      const scene = context.services.get(sceneAuthoringToken);
      const selection = context.services.get(sceneSelectionToken);
      const scripts = context.services.get(scriptPreviewServiceToken);
      const agentRuntime = context.services.get(agentRuntimeServiceToken);
      const gameTools = context.services.get(gameAuthoringToolServiceToken);
      const knowledgeSources = new StudioKnowledgeSourceLoader(agentRuntime.knowledge, workspace);
      await knowledgeSources.initialize().catch(async (cause) => {
        await operationLog.append({ kind: 'knowledge/initialization-degraded', severity: 'warning', source: asStableId('studio.electron'), correlation: {}, payload: { message: errorMessage(cause), fallback: 'exact-context' } }).catch(() => undefined);
      });
      const historyDirectory = (binding: Readonly<{ projectId: string | null; storageKey: string | null }>) => binding.storageKey
        ? path.join(binding.storageKey, '.aistudio', 'agent')
        : path.join(app.getPath('userData'), 'project-agent-history', sha256(binding.projectId ?? 'workspace-empty').slice(0, 32));
      const conversation = new ProjectConversationController({
        resolveProject: () => {
          const snapshot = workspace.snapshot();
          return { projectId: snapshot.document?.projectId ?? null, documentId: snapshot.document?.documentId ?? null, storageKey: snapshot.projectRoot };
        },
        async openHistory(binding) {
          const history = await ProjectAgentHistory.open({ projectId: binding.projectId ?? asStableId('project:workspace-empty'), directory: historyDirectory(binding), source: operationLog, storage: binding.storageKey ? 'project' : 'unsaved' });
          return { log: history.log, query: input => history.query(input), detail: id => history.detail(id), flush: () => history.flush(), dispose: () => history.dispose(), relocate: next => history.relocate(historyDirectory(next)) };
        },
        hostOptions: (binding, scopedLog) => ({
          runtime: agentRuntime,
          tools: gameTools,
          operationLog: scopedLog,
          sessionRecovery: new StudioSessionOrchestrator(createWorkspaceRecoveryAuthority(workspace), scopedLog, new RecoveryClaimStore(path.join(app.getPath('userData'), 'operation-log', 'recovery-claims'))),
          isProjectOpen: () => workspace.snapshot().document !== null,
          projectContext: () => {
            const project = workspace.snapshot().document;
            if (!project || project.projectId !== binding.projectId || project.documentId !== binding.documentId) return null;
            return Object.freeze({
              projectId: project.projectId, documentId: project.documentId, revision: project.revision,
              manifest: Object.freeze({
                schemaVersion: 1, project: Object.freeze({ id: project.projectId, documentId: project.documentId, name: project.name, revision: project.revision, savedRevision: project.savedRevision, dirty: project.dirty, counts: project.counts, registryDigest: project.registryDigest }),
              }) as unknown as JsonObject,
              exact: Object.freeze({
                query: ({ revision, request }: { revision: number; request: JsonObject }) => workspace.queryScene({ ...request, revision } as never) as unknown as JsonValue,
                diff: ({ fromRevision, toRevision, request }: { fromRevision: number; toRevision: number; request: JsonObject }) => workspace.diffScene({ ...request, fromRevision, toRevision } as never) as unknown as JsonValue,
              }),
            });
          },
          prepareKnowledge: (project, signal) => knowledgeSources.refresh(project, signal),
          async openLoginHandoff(_backendId, handoff) {
            if (handoff.url) {
              const url = new URL(handoff.url);
              if (url.protocol !== 'https:') throw new Error('Backend login handoff URL must use HTTPS.');
              await shell.openExternal(url.href);
            }
            if (handoff.kind === 'device-code' && handoff.userCode) {
              const options: Electron.MessageBoxOptions = {
                type: 'info', title: 'Sign in to Codex', message: 'Enter this one-time code in the browser:', detail: handoff.userCode,
              };
              if (mainWindow) await dialog.showMessageBox(mainWindow, options); else await dialog.showMessageBox(options);
            }
          },
        }),
      });
      context.effects.own('conversation.dispose', () => conversation.dispose());
      await conversation.initialize();
      const behaviorPorts = createWorkspaceBehaviorPorts(workspace, operationLog);
      const behavior = new ProjectBehaviorController(behaviorPorts);
      projectBehavior = behavior;
      context.effects.own('behavior.dispose', async () => { if (projectBehavior === behavior) projectBehavior = null; await behavior.dispose(); });
      const editor = new ProjectEditorController(createWorkspaceEditorPorts({ workspace, selection, behavior: behaviorPorts, tools: gameTools,
        playId: () => behavior.currentPlayId(),
        async approve(preparation, _approval, signal) {
          const options: Electron.MessageBoxOptions = { type: 'question', title: '确认项目修改', message: preparation.preview.title,
            detail: `${preparation.preview.summary}\n${preparation.preview.target}\n修订 ${preparation.baseRevision}\n\n${preparation.preview.diff}`,
            buttons: ['取消', '允许此次修改'], defaultId: 0, cancelId: 0, noLink: true, signal };
          const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
          return result.response === 1 ? 'allow-once' : 'reject';
        },
      }));
      context.effects.own('editor.dispose', () => editor.dispose());
      const projectHistoryChanges = workspace.subscribe(() => { editor.syncProject(); behavior.syncProject(); void conversation.syncProject().catch(cause => {
        void operationLog.append({ kind: 'project/history-failed', severity: 'error', source: asStableId('studio.electron'), payload: { message: errorMessage(cause) } }).catch(() => undefined);
      }); });
      context.effects.own('project-history-subscription.dispose', () => projectHistoryChanges.dispose());
      let conversationNotification: ReturnType<typeof setTimeout> | null = null;
      const notifyRenderer = (): void => {
        if (conversationNotification !== null) return;
        conversationNotification = setTimeout(() => {
          conversationNotification = null;
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(STUDIO_CONVERSATION_CHANGED_CHANNEL);
        }, 50);
      };
      const conversationChanges = conversation.subscribe(notifyRenderer);
      const previewChanges = agentPreview.subscribePending(notifyRenderer);
      const router = new StudioIpcRouter({
        workspace,
        scene,
        selection,
        scripts,
        operationLog,
        conversation,
        behavior,
        editor,
        agentPreview,
        bugBundleRoot: path.join(app.getPath('userData'), 'bug-bundles'),
        versions: Object.freeze({ app: descriptor.version, schema: 'm06-g10-v1', upstream: Object.freeze({
          deepseekHarness: 'dsh-v0.1.0-rc.7@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
          profile: agentProfile.id,
        }) }),
        smoke,
        async selectProjectRoot(purpose) {
          if (smoke) {
            const root = path.join(app.getPath('userData'), 'smoke-project');
            await mkdir(root, { recursive: true });
            return root;
          }
          const options: Electron.OpenDialogOptions = {
            title: purpose === 'save' ? 'Save HaiYue project to folder' : 'Open HaiYue project',
            properties: ['openDirectory', 'createDirectory'],
          };
          const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, options)
            : await dialog.showOpenDialog(options);
          return result.canceled ? null : result.filePaths[0] ?? null;
        },
      });
      await operationLog.append({
        kind: 'app/started', severity: 'info', source: asStableId('studio.electron'),
        correlation: {}, payload: { appId: descriptor.id, version: descriptor.version },
      });
      await operationLog.append({
        kind: 'profile/activation-observed', severity: 'info', source: asStableId('studio.electron'),
        correlation: {}, payload: { profileId: agentProfile.id, backend: agentProfile.backend, auth: agentProfile.auth, plugins: pocPluginIds },
      });
      for (const pluginId of pocPluginIds) {
        await operationLog.append({
          kind: 'plugin/activation-observed', severity: 'info', source: asStableId('studio.electron'),
          correlation: { pluginId }, payload: { profileId: agentProfile.id },
        });
      }
      activeRouter = router;
      layout.setLoggingState(operationLog.status().canPersist, operationLog.status().diagnostics.at(-1)?.message);
      const handle = (_event: Electron.IpcMainInvokeEvent, value: unknown) => router.handle(value);
      const cancel = (_event: Electron.IpcMainEvent, requestId: unknown) => router.cancel(requestId);
      ipcMain.handle(STUDIO_IPC_CHANNEL, handle);
      ipcMain.on(STUDIO_IPC_CANCEL_CHANNEL, cancel);
      context.effects.own('electron-ipc.dispose', async () => {
        conversationChanges.dispose();
        previewChanges.dispose();
        if (conversationNotification !== null) { clearTimeout(conversationNotification); conversationNotification = null; }
        await operationLog.append({
          kind: 'app/stopping', severity: 'info', source: asStableId('studio.electron'),
          correlation: {}, payload: { activeRequests: router.activeCount },
        }).catch(() => {});
        router.dispose();
        await conversation.dispose();
        agentPreview.dispose();
        if (activeRouter === router) activeRouter = null;
        ipcMain.removeHandler(STUDIO_IPC_CHANNEL);
        ipcMain.removeListener(STUDIO_IPC_CANCEL_CHANNEL, cancel);
      });
    },
  });
}

async function boot(): Promise<void> {
  await traceBoot('boot:start');
  const userDataRoot = app.getPath('userData');
  const deepSeekCredentials = new DeepSeekCredentialStore(userDataRoot, safeStorage);
  await deepSeekCredentials.importFromEnvironment(process.env);
  await traceBoot('boot:credentials-ready');
  const plugins: StudioPluginDefinition<any>[] = [
    createEditorFoundationProviderPlugin(),
    createOperationLogPlugin(),
    createProjectWorkspacePlugin(),
    createStudioWorkspaceLayoutPlugin(),
    ...createSceneAuthoringPlugins(),
    createScriptPreviewPlugin(),
    ...createPocAgentGameAuthoringPlugins({
      backend: agentProfile.backend,
      preview: agentPreview,
      textureRenderer: { render: renderCanvasTexture },
      behaviorSource: signal => { if (!projectBehavior) throw new Error('behavior.project-unavailable'); return projectBehavior.source(signal); },
      resolveDeepSeekApiKey: () => deepSeekCredentials.resolve(),
      clearDeepSeekApiKey: () => deepSeekCredentials.clear(),
    }),
    createElectronIpcPlugin(),
  ];
  await traceBoot('boot:activate-start');
  await root.activate({
    schemaVersion: 1,
    id: asStableId(`profile:${agentProfile.id}`),
    bundles: [{
      id: asStableId('bundle:ai-studio-core'),
      rows: plugins.map((plugin, index) => ({
        id: asStableId(`row:ai-studio:${index}`),
        pluginId: plugin.manifest.id,
        enabled: true,
        config: pluginConfig(plugin.manifest.id, userDataRoot),
      })),
    }],
    patches: [],
  }, plugins);
  await traceBoot('boot:activate-ready');
  createWindow();
  await traceBoot('boot:window-created');
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: descriptor.electron.width,
    height: descriptor.electron.height,
    minWidth: descriptor.electron.minWidth,
    minHeight: descriptor.electron.minHeight,
    backgroundColor: descriptor.electron.backgroundColor,
    title: descriptor.productName,
    show: !smoke,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: true,
      partition: 'persist:haiyue-ai-studio',
    },
  });
  mainWindow = window;
  installApplicationMenu();
  window.webContents.session.protocol.handle(previewScheme, async (request) => {
    const url = new URL(request.url);
    const asset = url.hostname === 'app'
      ? previewAssets.get(url.pathname) ?? (/^\/chunks\/[a-z0-9-]+\.js$/iu.test(url.pathname) ? url.pathname.slice(1) : undefined)
      : undefined;
    if (!asset) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const bytes = await readFile(path.join(import.meta.dirname, asset));
    const contentType = asset.endsWith('.html') ? 'text/html; charset=utf-8'
      : asset.endsWith('.css') ? 'text/css; charset=utf-8'
        : 'text/javascript; charset=utf-8';
    return new Response(new Uint8Array(bytes), { status: 200, headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    } });
  });
  const entry = path.join(import.meta.dirname, 'index.html');
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = pathToFileURL(entry).href;
    if (url !== allowed) event.preventDefault();
  });
  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) activeRouter?.cancelPending();
  });
  window.webContents.on('render-process-gone', () => activeRouter?.cancelPending());
  if (smoke) window.webContents.on('console-message', (details) => {
    console.log(`[ai-studio-renderer:${details.level}] ${details.message}`);
    const stage = /^\[behavior-smoke-evidence\] (structure|source|component|adapter|trace)$/u.exec(details.message)?.[1];
    if (stage) void (async () => {
      const directory = process.env.HAIYUE_ELECTRON_BEHAVIOR_EVIDENCE;
      if (directory) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, `product-${stage}.png`), (await window.webContents.capturePage()).toPNG()); }
      await window.webContents.executeJavaScript(`document.body.dataset.behaviorEvidence='${stage}:captured'`);
    })().catch(cause => finishSmoke(1, errorMessage(cause)));
  });
  window.once('closed', () => { activeRouter?.cancelPending(); if (mainWindow === window) mainWindow = null; });
  if (openDevTools && !smoke) window.webContents.once('did-finish-load', () => window.webContents.openDevTools({ mode: 'detach' }));
  if (smoke) {
    // Each load runs the complete product flow, including source navigation and
    // runtime evidence. The reload must receive its own bounded workflow window.
    const armSmokeDeadline = (): void => {
      if (smokeDeadline) clearTimeout(smokeDeadline);
      smokeDeadline = setTimeout(async () => {
        try {
          const state = await window.webContents.executeJavaScript(`({status:document.body.dataset.status,stage:document.body.dataset.smokeStage,message:document.querySelector('#status')?.textContent,visibility:document.visibilityState,modal:document.querySelector('#workspace-advanced')?.open,play:document.querySelector('#play-page')?.getBoundingClientRect().toJSON()})`);
          finishSmoke(1, `workflow deadline exceeded: ${JSON.stringify(state)}`);
        } catch (cause) { finishSmoke(1, `workflow deadline inspection failed: ${errorMessage(cause)}`); }
      }, 120_000);
    };
    armSmokeDeadline();
    let smokeLoads = 0;
    window.webContents.once('did-fail-load', (_event, code, description) => finishSmoke(1, `renderer load failed ${code}: ${description}`));
    window.webContents.on('did-finish-load', async () => {
      try {
        const result = await window.webContents.executeJavaScript(`new Promise((resolve) => { const check = () => { if (document.body.dataset.status === 'loading') return setTimeout(check, 10); const split = document.querySelector('hy-split'); const bar = split?.shadowRoot?.querySelector('[role="separator"]'); const before = Number(split?.getAttribute('ratio')); bar?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); const after = Number(split?.getAttribute('ratio')); const rect = (id) => { const value = document.querySelector(id)?.getBoundingClientRect(); return value && {left:value.left,top:value.top,right:value.right,bottom:value.bottom,width:value.width,height:value.height}; }; const hierarchy = rect('#hierarchy-panel'); const inspector = rect('#inspector-panel'); const viewport = rect('#viewport-panel'); const assets = rect('#assets-panel'); const chat = rect('#chat-panel'); const logic = rect('#intent-workspace'); const splitGeometry = document.body.dataset.workspaceMode === 'intent' && logic && viewport && chat && logic.width > 150 && viewport.height > 300 && logic.right <= viewport.left && viewport.right <= chat.left && Math.abs(viewport.height - logic.height) < 2 && document.querySelector('#workspace-existing-resources')?.contains(document.querySelector('#assets-panel')) && document.querySelector('#workspace-manual-inspect')?.contains(document.querySelector('#left-sidebar-split')) && !!document.querySelector('#workspace-advanced-button'); resolve({status:document.body.dataset.status,node:typeof process,api:typeof window.haiyueStudio,message:document.querySelector('#status')?.textContent,webgpu:document.body.dataset.webgpu,workflow:document.body.dataset.workflow,deviceRecovery:document.body.dataset.deviceRecovery,scriptWorkflow:document.body.dataset.scriptWorkflow,agentUi:document.body.dataset.agentUi,agentBackend:document.body.dataset.agentBackend,agentBackendState:document.body.dataset.agentBackendState,agentSync:document.body.dataset.agentSync,splitLayout:document.body.dataset.splitLayout,splitCount:document.querySelectorAll('hy-split').length,tabCount:document.querySelectorAll('hy-tabs').length,language:document.body.dataset.language,theme:document.body.dataset.theme,settings:Boolean(document.querySelector('#settings-button')),scriptHidden:document.querySelector('#script-panel')?.hidden,splitKeyboard:after > before,splitGeometry,rects:{hierarchy,inspector,viewport,assets,chat}}); }; check(); })`);
        if (result.status !== 'ready' || result.node !== 'undefined' || result.api !== 'object' || result.webgpu !== 'ready'
          || result.workflow !== 'create-pick-transform-undo-redo-save-reopen' || result.deviceRecovery !== 'ready'
          || result.scriptWorkflow !== 'proposal-commit-approve-standalone-play-pause-resume-device-hot-reload-fault-stop-isolated' || result.agentUi !== 'ready'
          || result.agentBackend !== 'backend:codex-app-server' || !['ready', 'auth-required', 'error'].includes(result.agentBackendState)
          || result.agentSync !== 'push-single-flight' || result.splitLayout !== 'ready' || result.splitCount !== 4 || result.tabCount !== 3
          || !['zh-CN', 'en'].includes(result.language) || !['light', 'dark'].includes(result.theme)
          || result.settings !== true || result.scriptHidden !== true
          || result.splitKeyboard !== true || result.splitGeometry !== true) throw new Error(JSON.stringify(result));
        smokeLoads += 1;
        if (smokeLoads === 1) { armSmokeDeadline(); window.webContents.reload(); }
        else {
          const candidate = process.env.HAIYUE_ELECTRON_PIXEL_CANDIDATE;
          if (candidate) {
            await mkdir(path.dirname(candidate), { recursive: true });
            await writeFile(candidate, (await window.webContents.capturePage()).toPNG());
          }
          finishSmoke(0, 'renderer-ready webgpu-script-agent-ui agent-sync-push-single-flight resizable-split-layout structured-logs pixel-candidate reload-safe secure-preload-only');
        }
      } catch (cause) { finishSmoke(1, errorMessage(cause)); }
    });
  }
  void window.loadFile(entry);
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'close' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'toggleDevTools', accelerator: 'F12' },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));
}

function finishSmoke(code: number, message: string): void {
  if (smokeDeadline) { clearTimeout(smokeDeadline); smokeDeadline = null; }
  console.log(`[ai-studio-smoke] ${message}`);
  void shutdown().finally(() => app.exit(code));
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  activeRouter?.cancelPending();
  await root.dispose();
}

app.on('window-all-closed', () => { void shutdown().finally(() => app.quit()); });
app.on('before-quit', () => { void shutdown(); });
void app.whenReady().then(boot).catch(async (cause) => { await traceBoot(`boot:failed:${errorMessage(cause)}`); finishSmoke(1, errorMessage(cause)); });

function errorMessage(value: unknown): string { return value instanceof Error ? value.stack ?? value.message : String(value); }
async function traceBoot(stage: string): Promise<void> {
  const destination = process.env.HAIYUE_BOOT_TRACE?.trim();
  if (!destination) return;
  await writeFile(destination, `${new Date().toISOString()} ${stage.replaceAll(/\r?\n/gu, ' ')}\n`, { flag: 'a' }).catch(() => undefined);
}

function pluginConfig(pluginId: string, userDataRoot: string): JsonObject {
  if (pluginId === 'studio.operation-log.plugin') {
    return Object.freeze({ rootDirectory: path.join(userDataRoot, 'operation-log'), appVersion: descriptor.version });
  }
  if (pluginId === 'studio.project-workspace.plugin') return Object.freeze({ userDataRoot });
  return Object.freeze({});
}
