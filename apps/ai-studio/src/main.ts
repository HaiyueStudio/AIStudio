import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineEditorAppDescriptor } from '@haiyue/editor-app-kit';
import { asStableId, defineStudioPlugin, type JsonObject, type StudioPluginDefinition } from '@haiyue/ai-studio-contracts';
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
import { StudioConversationHost } from './conversation-host.js';
import { createPocAgentGameAuthoringPlugins, POC_COMMON_PLUGIN_IDS, selectPocEditorProfile } from './profiles/agent-game-authoring.js';

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
  staticFiles: ['index.html', 'styles.css', 'preview.html', 'preview.css'],
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
      const conversation = new StudioConversationHost({
        runtime: agentRuntime,
        tools: gameTools,
        operationLog,
        isProjectOpen: () => workspace.snapshot().document !== null,
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
      });
      await conversation.initialize();
      let conversationNotification: ReturnType<typeof setTimeout> | null = null;
      const conversationChanges = conversation.subscribe(() => {
        if (conversationNotification !== null) return;
        conversationNotification = setTimeout(() => {
          conversationNotification = null;
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(STUDIO_CONVERSATION_CHANGED_CHANNEL);
        }, 50);
      });
      const router = new StudioIpcRouter({
        workspace,
        scene,
        selection,
        scripts,
        operationLog,
        conversation,
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
  const userDataRoot = app.getPath('userData');
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
      resolveDeepSeekApiKey: async () => process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || null,
      clearDeepSeekApiKey: async () => { delete process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET; delete process.env.DEEPSEEK_API_KEY; },
    }),
    createElectronIpcPlugin(),
  ];
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
  createWindow();
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
  window.webContents.on('console-message', (details) => console.log(`[ai-studio-renderer:${details.level}] ${details.message}`));
  window.once('closed', () => { activeRouter?.cancelPending(); if (mainWindow === window) mainWindow = null; });
  if (openDevTools && !smoke) window.webContents.once('did-finish-load', () => window.webContents.openDevTools({ mode: 'detach' }));
  if (smoke) {
    smokeDeadline = setTimeout(async () => {
      try {
        const state = await window.webContents.executeJavaScript(`({status:document.body.dataset.status,stage:document.body.dataset.smokeStage,message:document.querySelector('#status')?.textContent})`);
        finishSmoke(1, `workflow deadline exceeded: ${JSON.stringify(state)}`);
      } catch (cause) { finishSmoke(1, `workflow deadline inspection failed: ${errorMessage(cause)}`); }
    }, 65_000);
    let smokeLoads = 0;
    window.webContents.once('did-fail-load', (_event, code, description) => finishSmoke(1, `renderer load failed ${code}: ${description}`));
    window.webContents.on('did-finish-load', async () => {
      try {
        const result = await window.webContents.executeJavaScript(`new Promise((resolve) => { const check = () => { if (document.body.dataset.status === 'loading') return setTimeout(check, 10); const split = document.querySelector('hy-split'); const bar = split?.shadowRoot?.querySelector('[role="separator"]'); const before = Number(split?.getAttribute('ratio')); bar?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); const after = Number(split?.getAttribute('ratio')); const rect = (id) => { const value = document.querySelector(id)?.getBoundingClientRect(); return value && {left:value.left,top:value.top,right:value.right,bottom:value.bottom,width:value.width,height:value.height}; }; const hierarchy = rect('#hierarchy-panel'); const inspector = rect('#inspector-panel'); const viewport = rect('#viewport-panel'); const assets = rect('#assets-panel'); const chat = rect('#chat-panel'); const splitGeometry = hierarchy && inspector && viewport && assets && chat && hierarchy.right <= viewport.left && inspector.right <= viewport.left && hierarchy.bottom <= inspector.top && viewport.bottom <= assets.top && viewport.right <= chat.left && assets.right <= chat.left; resolve({status:document.body.dataset.status,node:typeof process,api:typeof window.haiyueStudio,message:document.querySelector('#status')?.textContent,webgpu:document.body.dataset.webgpu,workflow:document.body.dataset.workflow,deviceRecovery:document.body.dataset.deviceRecovery,scriptWorkflow:document.body.dataset.scriptWorkflow,agentUi:document.body.dataset.agentUi,agentBackend:document.body.dataset.agentBackend,agentBackendState:document.body.dataset.agentBackendState,agentSync:document.body.dataset.agentSync,splitLayout:document.body.dataset.splitLayout,splitCount:document.querySelectorAll('hy-split').length,tabCount:document.querySelectorAll('hy-tabs').length,language:document.body.dataset.language,theme:document.body.dataset.theme,settings:Boolean(document.querySelector('#settings-button')),scriptHidden:document.querySelector('#script-panel')?.hidden,splitKeyboard:after > before,splitGeometry,rects:{hierarchy,inspector,viewport,assets,chat}}); }; check(); })`);
        if (result.status !== 'ready' || result.node !== 'undefined' || result.api !== 'object' || result.webgpu !== 'ready'
          || result.workflow !== 'create-pick-transform-undo-redo-save-reopen' || result.deviceRecovery !== 'ready'
          || result.scriptWorkflow !== 'proposal-commit-approve-play-hot-reload-fault-stop-isolated' || result.agentUi !== 'ready'
          || result.agentBackend !== 'backend:codex-app-server' || !['ready', 'auth-required', 'error'].includes(result.agentBackendState)
          || result.agentSync !== 'push-single-flight' || result.splitLayout !== 'ready' || result.splitCount !== 4 || result.tabCount !== 2
          || !['zh-CN', 'en'].includes(result.language) || !['light', 'dark'].includes(result.theme)
          || result.settings !== true || result.scriptHidden !== true
          || result.splitKeyboard !== true || result.splitGeometry !== true) throw new Error(JSON.stringify(result));
        smokeLoads += 1;
        if (smokeLoads === 1) window.webContents.reload();
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
void app.whenReady().then(boot).catch((cause) => finishSmoke(1, errorMessage(cause)));

function errorMessage(value: unknown): string { return value instanceof Error ? value.stack ?? value.message : String(value); }

function pluginConfig(pluginId: string, userDataRoot: string): JsonObject {
  if (pluginId === 'studio.operation-log.plugin') {
    return Object.freeze({ rootDirectory: path.join(userDataRoot, 'operation-log'), appVersion: descriptor.version });
  }
  if (pluginId === 'studio.project-workspace.plugin') return Object.freeze({ userDataRoot });
  return Object.freeze({});
}
