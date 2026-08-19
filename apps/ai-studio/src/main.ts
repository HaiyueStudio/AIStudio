import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineEditorAppDescriptor } from '@haiyue/editor-app-kit';
import { asStableId, defineStudioPlugin, type JsonObject, type StudioPluginDefinition } from '@haiyue/ai-studio-contracts';
import { createProjectWorkspacePlugin, projectWorkspaceServiceToken } from '@haiyue/ai-studio-editor-plugins';
import { createHarnessStudioRoot } from '@haiyue/ai-studio-harness-bridge';
import { createEditorFoundationProviderPlugin } from '@haiyue/ai-studio-kernel';
import { createOperationLogPlugin, operationLogServiceToken } from '@haiyue/ai-studio-operation-log';
import { createStudioWorkspaceLayoutPlugin, studioWorkspaceLayoutToken } from '@haiyue/ai-studio-shell';
import {
  STUDIO_IPC_CANCEL_CHANNEL,
  STUDIO_IPC_CHANNEL,
  StudioIpcRouter,
} from './ipc.js';

const descriptor = defineEditorAppDescriptor({
  schemaVersion: 1,
  id: 'haiyue-ai-studio',
  version: '0.0.0',
  productName: 'HaiYue AIStudio',
  appId: 'studio.haiyue.ai',
  artifactName: 'haiyue-ai-studio',
  storageNamespace: 'haiyue-ai-studio-poc',
  supportTier: 'experimental',
  entries: ['main.js', 'preload.cjs', 'renderer.js', 'index.html'],
  staticFiles: ['index.html'],
  workers: [],
  distDirectory: 'dist',
  outputDirectory: 'release',
  electronRendererDirectory: 'dist',
  budget: { maxRawBytes: 2_000_000, maxGzipBytes: 700_000 },
  pwa: { enabled: false, shortName: 'AIStudio', description: 'AI-native game studio POC', themeColor: '#10151d', backgroundColor: '#10151d' },
  electron: { enabled: true, width: 1440, height: 900, minWidth: 1024, minHeight: 700, backgroundColor: '#10151d' },
});

const smoke = process.env.HAIYUE_ELECTRON_SMOKE === '1';
if (process.env.HAIYUE_ELECTRON_USER_DATA) app.setPath('userData', process.env.HAIYUE_ELECTRON_USER_DATA);
const root = createHarnessStudioRoot();
let mainWindow: BrowserWindow | null = null;
let activeRouter: StudioIpcRouter | null = null;
let shuttingDown = false;
const pocPluginIds = Object.freeze([
  asStableId('studio.editor-foundations'),
  asStableId('studio.operation-log.plugin'),
  asStableId('studio.project-workspace.plugin'),
  asStableId('studio.workspace-layout.plugin'),
  asStableId('studio.electron-ipc.plugin'),
]);

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
      const router = new StudioIpcRouter({
        workspace,
        operationLog,
        async selectProjectRoot(purpose) {
          const options: Electron.OpenDialogOptions = {
            title: purpose === 'new' ? 'Select folder for new HaiYue project' : 'Open HaiYue project',
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
        correlation: {}, payload: { profileId: 'profile:ai-studio-poc', plugins: pocPluginIds },
      });
      for (const pluginId of pocPluginIds) {
        await operationLog.append({
          kind: 'plugin/activation-observed', severity: 'info', source: asStableId('studio.electron'),
          correlation: { pluginId }, payload: { profileId: 'profile:ai-studio-poc' },
        });
      }
      activeRouter = router;
      layout.setLoggingState(operationLog.status().canPersist, operationLog.status().diagnostics.at(-1)?.message);
      const handle = (_event: Electron.IpcMainInvokeEvent, value: unknown) => router.handle(value);
      const cancel = (_event: Electron.IpcMainEvent, requestId: unknown) => router.cancel(requestId);
      ipcMain.handle(STUDIO_IPC_CHANNEL, handle);
      ipcMain.on(STUDIO_IPC_CANCEL_CHANNEL, cancel);
      context.effects.own('electron-ipc.dispose', async () => {
        await operationLog.append({
          kind: 'app/stopping', severity: 'info', source: asStableId('studio.electron'),
          correlation: {}, payload: { activeRequests: router.activeCount },
        }).catch(() => {});
        router.dispose();
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
    createElectronIpcPlugin(),
  ];
  await root.activate({
    schemaVersion: 1,
    id: asStableId('profile:ai-studio-poc'),
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
      partition: 'persist:haiyue-ai-studio',
    },
  });
  mainWindow = window;
  const entry = path.join(import.meta.dirname, 'index.html');
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = pathToFileURL(entry).href;
    if (url !== allowed) event.preventDefault();
  });
  window.webContents.on('did-start-navigation', () => activeRouter?.cancelPending());
  window.webContents.on('render-process-gone', () => activeRouter?.cancelPending());
  window.once('closed', () => { activeRouter?.cancelPending(); if (mainWindow === window) mainWindow = null; });
  if (smoke) {
    let smokeLoads = 0;
    window.webContents.once('did-fail-load', (_event, code, description) => finishSmoke(1, `renderer load failed ${code}: ${description}`));
    window.webContents.on('did-finish-load', async () => {
      try {
        const result = await window.webContents.executeJavaScript(`new Promise((resolve) => { const check = () => document.body.dataset.status === 'loading' ? setTimeout(check, 10) : resolve({status:document.body.dataset.status,node:typeof process,api:typeof window.haiyueStudio}); check(); })`);
        if (result.status !== 'ready' || result.node !== 'undefined' || result.api !== 'object') throw new Error(JSON.stringify(result));
        smokeLoads += 1;
        if (smokeLoads === 1) window.webContents.reload();
        else finishSmoke(0, 'renderer-ready reload-safe secure-preload-only');
      } catch (cause) { finishSmoke(1, errorMessage(cause)); }
    });
  }
  void window.loadFile(entry);
}

function finishSmoke(code: number, message: string): void {
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
