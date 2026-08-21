import {
  BasicMaterial,
  CartesianTransform3D,
  createBox3D,
  Entity,
  HaiyueEngine,
  Mesh3D,
  type Scene,
} from '@haiyue/engine';
import { createInteractionRaycastResult, InteractionSystem } from '@haiyue/engine/systems';
import type { ScriptCapabilityName } from '@haiyue/engine/components';
import type { JsonObject, StableId } from '@haiyue/ai-studio-contracts';
import {
  ConversationProjector,
  presentChatPanel,
  renderChatPanel,
  type ConversationIntent,
  type ConversationReplaySnapshot,
  type LogQueryIntent,
  type SafeLogSummary,
} from '@haiyue/ai-studio-shell';
import type { StudioIpcMethod, StudioIpcRequest, StudioIpcResponse } from './ipc.js';
import { AgentPollScheduler } from './agent-poll-scheduler.js';
import {
  defineDialogComponents,
  defineSelectComponents,
  defineSplitComponents,
  defineTabsComponents,
  type GEDialog,
  type GESelect,
  type GESplit,
  type GESplitRatioChangeDetail,
  type GETabs,
} from '@haiyue/ui';

declare global {
  interface Window {
    readonly haiyueStudio: Readonly<{
      invoke(request: StudioIpcRequest): Promise<StudioIpcResponse>;
      cancel(requestId: string): void;
      onConversationChanged(listener: () => void): () => void;
    }>;
  }
}

interface Vec3Snapshot { readonly x: number; readonly y: number; readonly z: number; }
interface TransformSnapshot { readonly position: Vec3Snapshot; readonly rotationDegrees: Vec3Snapshot; readonly scale: Vec3Snapshot; }
interface SceneEntitySnapshot {
  readonly id: StableId; readonly name: string; readonly kind: 'empty' | 'cube';
  readonly parentId: StableId | null; readonly order: number; readonly transform: TransformSnapshot;
}
interface SceneSnapshot { readonly revision: number; readonly documentId: StableId; readonly entities: readonly SceneEntitySnapshot[]; }
interface ProjectSnapshot {
  readonly smoke?: boolean;
  readonly document: Readonly<{ revision: number; name: string }> | null;
  readonly history: Readonly<{ canUndo: boolean; canRedo: boolean }>;
  readonly logging: Readonly<{ health: string; canPersist: boolean; nextSequence: number; eventCount: number }>;
}
interface SelectionSnapshot { readonly activeEntityId: StableId | null; readonly source: string; }
interface ScriptResourceSnapshot { readonly id: StableId; readonly entityId: StableId; readonly text: string; readonly textRevision: number; readonly dirty: boolean; }
interface ScriptCatalogSnapshot { readonly documentRevision: number; readonly resources: readonly ScriptResourceSnapshot[]; }
interface ScriptProposal { readonly id: StableId; readonly diagnostics: readonly ScriptDiagnostic[]; readonly addedLines: number; readonly removedLines: number; }
interface ScriptDiagnostic { readonly code: string; readonly severity: 'error' | 'warning'; readonly line: number; readonly column: number; readonly message: string; }
interface PreviewDisclosure { readonly id: StableId; readonly scriptId: StableId; readonly entityId: StableId; readonly capabilities: readonly ScriptCapabilityName[]; readonly risk: 'trusted-project'; readonly diagnostics: readonly ScriptDiagnostic[]; }
interface PreviewGrant { readonly id: StableId; }
interface ConsumedPreviewPlan extends PreviewDisclosure { readonly emittedText: string; }
interface AgentPreviewCommandReadModel { readonly pending: boolean; readonly command?: Readonly<{ id: StableId; kind: 'start' | 'stop'; scene?: SceneSnapshot; plan?: ConsumedPreviewPlan }> }
interface LogViewerResult { readonly events: readonly SafeLogSummary[]; readonly nextCursor?: string; readonly status: Readonly<{ health: string; canPersist: boolean; eventCount?: number }> }

let requestSequence = 0;
let project: ProjectSnapshot | null = null;
let scene: SceneSnapshot | null = null;
let selection: SelectionSnapshot = { activeEntityId: null, source: 'system' };
let viewport: WebGpuViewportRuntime | null = null;
let previewFrame: SandboxedPreviewFrame | null = null;
let scripts: ScriptCatalogSnapshot = { documentRevision: 0, resources: [] };
let pendingScriptProposal: ScriptProposal | null = null;
let previewDisclosure: PreviewDisclosure | null = null;
let playing = false;
let loadedScriptIdentity = '';
const conversationProjector = new ConversationProjector();
let conversationRevision = -1;
const observedAgentToolResults = new Set<StableId>();
let agentPoll: AgentPollScheduler | null = null;
let disposeConversationChanged: (() => void) | null = null;
let handledPreviewCommand: StableId | null = null;
const DEMO_SCRIPT = document.body.dataset.shell === 'web'
  ? `const transform = entity.getComponent('CartesianTransform3D');\ntransform?.setPosition(0.4 + Math.sin(time / 500) * 0.8, 0.2, 0);`
  : `const transform = entity.getComponent('CartesianTransform3D') as unknown as { setPosition(x: number, y: number, z: number): unknown } | null;\ntransform?.setPosition(0.4 + Math.sin(time / 500) * 0.8, 0.2, 0);`;
const SPLIT_LAYOUT_STORAGE_PREFIX = 'haiyue.ai-studio.split.v2.';
const LANGUAGE_STORAGE_KEY = 'haiyue.ai-studio.language.v1';
const THEME_STORAGE_KEY = 'haiyue.ai-studio.theme.v1';
type StudioLanguage = 'zh-CN' | 'en';
type StudioTheme = 'ocean' | 'violet' | 'emerald' | 'amber';
let language: StudioLanguage = 'zh-CN';
let theme: StudioTheme = 'ocean';
let currentStatusKey: string | null = document.body.dataset.shell === 'web' ? 'startingWeb' : 'starting';

const UI_COPY: Readonly<Record<StudioLanguage, Readonly<Record<string, string>>>> = Object.freeze({
  'zh-CN': Object.freeze({
    newProject: '新建', openProject: '打开', saveProject: '保存', undo: '撤销', redo: '重做', settings: '设置',
    scene: '场景', createEmpty: '+ 空物体', createCube: '+ 立方体', inspector: '检查器', noSelection: '未选择物体',
    transformHistory: 'Transform 修改会通过历史记录提交。', position: '位置', rotation: '旋转', scale: '缩放', applyTransform: '应用 Transform',
    noRenderables: '没有可渲染物体', noRenderablesHint: '空物体仅用于逻辑。创建一个立方体即可显示几何体。', authoring: '编辑', assets: '资源库',
    cube: '立方体', builtinGeometry: '内置几何体', defaultMaterial: '默认材质', builtinMaterial: '内置材质', noTextures: '项目中暂无纹理', noModels: '项目中暂无模型',
    geometry: '几何体', materials: '材质', textures: '纹理', models: '模型', agent: 'AI 助手', logs: '日志', agentConversation: 'AI 助手对话',
    refresh: '刷新', exportLogs: '导出安全问题包', downloadLogs: '下载安全日志包', loading: '加载中…', starting: '正在启动 AIStudio…', startingWeb: '正在启动 AIStudio Web…',
    language: '语言', themeColor: '主题色', settingsSaved: '偏好会保存在当前设备中。', done: '完成', browserLocal: '浏览器本地',
    webCapability: 'Web 模式将项目和结构化日志保存在当前浏览器中。本地 Codex、API Key、任意目录和原生问题包需要 Electron 应用。',
    chinese: '简体中文', english: 'English', ocean: '海洋蓝', violet: '星云紫', emerald: '翡翠绿', amber: '琥珀橙',
    revision: '文档 r{document} · 场景 r{scene}', ready: '就绪', working: '处理中…', agentPending: '正在提交 AI 请求…', agentAccepted: 'AI 请求已接受', editorReady: 'AIStudio 场景编辑器已就绪',
    newestLogs: '{health} · 显示最新 {visible} / {total} 条安全摘要', logCount: '{health} · {visible} 条安全摘要', bugExported: '问题包已导出 · {digest}',
    connection: '连接', connected: '已连接', reconnecting: '正在重连', disconnected: '已断开', latest: '↓ 最新', send: '发送', cancelTurn: '取消本轮', reconnect: '重新连接', signOut: '退出登录',
    configureKey: '安全配置 API Key', signIn: '使用 ChatGPT 登录', messageAgent: '向游戏创作 AI 助手发送消息', readyToSend: '可以发送。', waitTurn: '请等待当前任务完成或取消任务。',
    allowOnce: '仅允许一次', allowAlways: '始终允许', reject: '拒绝', agentBackend: 'AI 后端', jumpLatest: '跳到最新 AI 消息', noProject: '未打开项目',
  }),
  en: Object.freeze({
    newProject: 'New', openProject: 'Open', saveProject: 'Save', undo: 'Undo', redo: 'Redo', settings: 'Settings',
    scene: 'Scene', createEmpty: '+ Empty', createCube: '+ Cube', inspector: 'Inspector', noSelection: 'No entity selected',
    transformHistory: 'Transform values are committed through History.', position: 'Position', rotation: 'Rotation', scale: 'Scale', applyTransform: 'Apply Transform',
    noRenderables: 'No renderable entities', noRenderablesHint: 'Empty entities are logic nodes. Create a Cube to render geometry.', authoring: 'Authoring', assets: 'Assets',
    cube: 'Cube', builtinGeometry: 'Built-in geometry', defaultMaterial: 'Default Material', builtinMaterial: 'Built-in material', noTextures: 'No textures in this project', noModels: 'No models in this project',
    geometry: 'Geometry', materials: 'Materials', textures: 'Textures', models: 'Models', agent: 'AI Agent', logs: 'Logs', agentConversation: 'Agent conversation',
    refresh: 'Refresh', exportLogs: 'Export safe bug bundle', downloadLogs: 'Download safe log bundle', loading: 'Loading…', starting: 'Starting AIStudio…', startingWeb: 'Starting AIStudio Web…',
    language: 'Language', themeColor: 'Theme color', settingsSaved: 'Preferences are stored on this device.', done: 'Done', browserLocal: 'Browser-local',
    webCapability: 'Web mode stores projects and structured logs in this browser. Local Codex, API keys, arbitrary folders, and native bug bundles require the Electron app.',
    chinese: '简体中文', english: 'English', ocean: 'Ocean Blue', violet: 'Nebula Violet', emerald: 'Emerald', amber: 'Amber',
    revision: 'Document r{document} · Scene r{scene}', ready: 'Ready', working: 'Working…', agentPending: 'Agent intent pending…', agentAccepted: 'Agent intent accepted', editorReady: 'AIStudio scene authoring ready',
    newestLogs: '{health} · newest {visible} of {total} safe summaries', logCount: '{health} · {visible} safe summaries', bugExported: 'Bug bundle exported · {digest}',
    connection: 'Connection', connected: 'connected', reconnecting: 'reconnecting', disconnected: 'disconnected', latest: '↓ Latest', send: 'Send', cancelTurn: 'Cancel turn', reconnect: 'Reconnect', signOut: 'Sign out',
    configureKey: 'Configure API key securely', signIn: 'Sign in with ChatGPT', messageAgent: 'Message the game authoring Agent', readyToSend: 'Ready to send.', waitTurn: 'Wait for the active turn or cancel it.',
    allowOnce: 'Allow once', allowAlways: 'Allow always', reject: 'Reject', agentBackend: 'Agent backend', jumpLatest: 'Jump to latest agent message', noProject: 'No project',
  }),
});

async function invoke<T extends JsonObject>(channel: StudioIpcMethod, payload: JsonObject = {}): Promise<T> {
  const sequence = ++requestSequence;
  const response = await window.haiyueStudio.invoke({
    schemaVersion: 1,
    id: `request:renderer:${sequence}` as StableId,
    correlationId: `correlation:renderer:${sequence}` as StableId,
    channel,
    payload,
  });
  if (!response.ok) {
    const diagnostic = response.payload.diagnostic as Readonly<{ message?: string; code?: string }> | undefined;
    throw new Error(diagnostic?.message ?? diagnostic?.code ?? `${channel} failed.`);
  }
  return response.payload as T;
}

class WebGpuViewportRuntime {
  private engine: HaiyueEngine | null = null;
  private engineScene: Scene | null = null;
  private interaction: InteractionSystem | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly stableByEngineId = new Map<number, StableId>();
  private readonly entitiesByStableId = new Map<StableId, Entity>();
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async initialize(): Promise<void> {
    const engine = new HaiyueEngine({
      canvas: this.canvas,
      renderProfile: 'batched',
      clearColor: { r: 0.035, g: 0.055, b: 0.085, a: 1 },
      recoverDeviceLost: true,
      diagnostics: { enabled: true },
    });
    this.engine = engine;
    engine.on('device-lost', (event: Readonly<{ detail: GPUDeviceLostInfo }>) => { void reportViewport('device-lost', event.detail.message, scene?.revision ?? 0); });
    engine.on('recovery-failed', (event: Readonly<{ detail: { error: Error } }>) => { void reportViewport('failed', event.detail.error.message, scene?.revision ?? 0); });
    await engine.init();
    if (this.disposed) { engine.destroy(); return; }
    const engineScene = engine.createScene({ name: 'AIStudio Authoring View', render3D: true });
    this.engineScene = engineScene;
    this.interaction = new InteractionSystem(engine, engineScene.cameraEntity, { continuousHover: false });
    engine.switchScene(engineScene);
    this.resizeObserver = new ResizeObserver(() => engine.resizeToDisplaySize(true));
    this.resizeObserver.observe(this.canvas);
    engine.resizeToDisplaySize(true);
    engine.run();
    await reportViewport('ready', 'WebGPU viewport initialized.', scene?.revision ?? 0);
  }

  apply(snapshot: SceneSnapshot, selectedEntityId: StableId | null): void {
    const engineScene = this.requireScene();
    engineScene.clear({ keepCamera: true });
    this.stableByEngineId.clear();
    this.entitiesByStableId.clear();
    const entities = new Map<StableId, Entity>();
    for (const item of snapshot.entities) {
      const entity = new Entity(item.name);
      entity.addComponent(new CartesianTransform3D({
        position: tuple(item.transform.position),
        rotation: tupleRadians(item.transform.rotationDegrees),
        scale: tuple(item.transform.scale),
      }));
      if (item.kind === 'cube') {
        const selected = item.id === selectedEntityId;
        entity.addComponent(new Mesh3D(createBox3D(), new BasicMaterial({
          color: selected ? [1, 0.66, 0.16, 1] : [0.16, 0.58, 1, 1],
        })));
      }
      entities.set(item.id, entity);
      this.entitiesByStableId.set(item.id, entity);
      this.stableByEngineId.set(entity.id, item.id);
    }
    for (const item of snapshot.entities) {
      const entity = entities.get(item.id)!;
      if (item.parentId) entities.get(item.parentId)?.addChild(entity);
      else engineScene.add(entity);
    }
    engineScene.update(performance.now(), 0);
    void reportViewport('rendered', selectedEntityId ?? 'Scene rendered.', snapshot.revision, selectedEntityId);
  }

  pick(clientX: number, clientY: number): StableId | null {
    const engineScene = this.requireScene();
    const interaction = this.interaction;
    if (!interaction) throw new Error('Viewport picking is not initialized.');
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('Viewport has no drawable area.');
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const result = createInteractionRaycastResult();
    engineScene.update(performance.now(), 0);
    return interaction.raycast(engineScene.world, ndcX, ndcY, result) && result.entity
      ? this.stableByEngineId.get(result.entity.id) ?? null
      : null;
  }

  canvasCenter(): Readonly<{ x: number; y: number }> {
    const rect = this.canvas.getBoundingClientRect();
    return Object.freeze({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }

  async exerciseDeviceLoss(): Promise<void> {
    const engine = this.engine;
    if (!engine || engine.state !== 'ready') throw new Error('Engine is not ready for device-loss recovery test.');
    const device = engine.device;
    const lost = device.lost;
    device.destroy();
    await lost;
    await Promise.resolve();
    await engine.waitForRecovery();
    if (engine.state !== 'ready') throw new Error(`Engine device recovery ended in ${engine.state}.`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.interaction?.destroy();
    this.interaction = null;
    this.stableByEngineId.clear();
    this.entitiesByStableId.clear();
    this.engine?.destroy();
    this.engine = null;
    this.engineScene = null;
  }

  private requireScene(): Scene {
    if (this.disposed || !this.engineScene) throw new Error('WebGPU viewport is not ready.');
    return this.engineScene;
  }
}

type PreviewRealmMessage = Readonly<Record<string, unknown> & { protocol: 'haiyue-preview/1'; type: string }>;

class SandboxedPreviewFrame {
  readonly previewId = `preview-realm:${requestSequence + 1}` as StableId;
  private readonly frame = document.createElement('iframe');
  private readonly ready = deferred<void>();
  private readonly started = deferred<void>();
  private readonly cleanup = deferred<void>();
  private position: Readonly<{ x: number; y: number; z: number }> | null = null;
  private disposableCount = 0;
  private runtimeErrors = 0;
  private disposed = false;

  constructor(private readonly entityId: StableId) {
    this.frame.id = 'preview-frame';
    this.frame.title = 'Isolated trusted-project game preview';
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.src = document.body.dataset.shell === 'web' ? './preview.html' : 'haiyue-preview://app/preview.html';
    window.addEventListener('message', this.onMessage);
    element('viewport-panel').append(this.frame);
  }

  async start(snapshot: SceneSnapshot, plan: ConsumedPreviewPlan): Promise<void> {
    await withTimeout(this.ready.promise, 10_000, 'Preview realm did not become ready.');
    this.post({ type: 'start', scene: snapshot, plan });
    await withTimeout(this.started.promise, 15_000, 'Preview realm did not start.');
  }

  hotReload(emittedText: string): void {
    if (this.disposed) throw new Error('Preview realm is disposed.');
    this.post({ type: 'hot-reload', emittedText });
  }

  latestPosition(): Readonly<{ x: number; y: number; z: number }> | null { return this.position; }
  targetEntityId(): StableId { return this.entityId; }
  ownedDisposableCount(): number { return this.disposableCount; }
  runtimeErrorCount(): number { return this.runtimeErrors; }

  async dispose(): Promise<number> {
    if (this.disposed) return 0;
    this.disposed = true;
    const ownedBeforeStop = this.disposableCount;
    this.post({ type: 'stop' });
    await withTimeout(this.cleanup.promise, 2_000, 'Preview cleanup acknowledgement timed out.').catch(() => undefined);
    window.removeEventListener('message', this.onMessage);
    this.frame.remove();
    return ownedBeforeStop;
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== this.frame.contentWindow || !isPreviewRealmMessage(event.data)) return;
    const message = event.data;
    if (message.type === 'ready') this.ready.resolve();
    else if (message.type === 'started') {
      this.disposableCount = finiteNumber(message.disposableCount, 0);
      this.started.resolve();
      void reportPreview('started', 'Isolated trusted-project realm started.', this.disposableCount, this.previewId, this.entityId);
    } else if (message.type === 'state' && isVec3(message.position)) {
      this.position = Object.freeze({ x: message.position.x, y: message.position.y, z: message.position.z });
      this.disposableCount = finiteNumber(message.disposableCount, this.disposableCount);
    } else if (message.type === 'hot-reloaded') {
      this.disposableCount = finiteNumber(message.disposableCount, this.disposableCount);
      void reportPreview('hot-reloaded', 'Runtime-only script replacement applied.', this.disposableCount, this.previewId, this.entityId);
    } else if (message.type === 'runtime-error') {
      this.runtimeErrors += 1;
      this.disposableCount = finiteNumber(message.disposableCount, this.disposableCount);
      const code = typeof message.code === 'string' ? message.code : 'preview-runtime-error';
      const detail = typeof message.message === 'string' ? message.message : 'Preview runtime failed.';
      element('script-diagnostics').textContent = `${code} ${finiteNumber(message.line, 1)}:${finiteNumber(message.column, 1)} ${detail}`;
      void reportPreview('runtime-error', detail, this.disposableCount, this.previewId, this.entityId);
      if (!this.started.settled) this.started.reject(new Error(detail));
    } else if (message.type === 'cleanup-complete') {
      this.disposableCount = finiteNumber(message.disposableCount, 0);
      this.cleanup.resolve();
      void reportPreview('cleanup-complete', 'Preview Engine/World/ScriptExecutionScope released.', this.disposableCount, this.previewId, this.entityId);
    }
  };

  private post(payload: Readonly<Record<string, unknown>>): void {
    this.frame.contentWindow?.postMessage({ protocol: 'haiyue-preview/1', ...payload }, '*');
  }
}

async function boot(): Promise<void> {
  setupUiPreferences();
  setupSplitLayout();
  setStatus('Starting typed editor services…');
  const status = await invoke<ProjectSnapshot & JsonObject>('app/status');
  project = status;
  if (!project.document && status.smoke) project = await invoke<ProjectSnapshot & JsonObject>('project/new', { name: 'G05 WebGPU smoke' });
  bindUi();
  await refreshConversation(true);
  await refreshLogs();
  agentPoll = new AgentPollScheduler({
    intervalMs: 2_000,
    poll: pollAgent,
    onError: (cause) => setStatus(errorMessage(cause)),
    schedule: (task, delayMs) => window.setTimeout(task, delayMs),
    cancel: (handle) => window.clearTimeout(handle as number),
  });
  disposeConversationChanged = window.haiyueStudio.onConversationChanged(() => agentPoll?.trigger());
  agentPoll.start();
  document.body.dataset.agentSync = 'push-single-flight';
  viewport = new WebGpuViewportRuntime(element<HTMLCanvasElement>('viewport'));
  try {
    await viewport.initialize();
    document.body.dataset.webgpu = 'ready';
    await refresh();
    if (status.smoke) await runSmokeWorkflow();
    document.body.dataset.status = 'ready';
    setStatus('AIStudio scene authoring ready');
  } catch (cause) {
    document.body.dataset.status = 'error';
    setStatus(errorMessage(cause));
    await reportViewport('failed', errorMessage(cause), scene?.revision ?? 0).catch(() => {});
    throw cause;
  }
}

function setupUiPreferences(): void {
  defineTabsComponents();
  defineDialogComponents();
  defineSelectComponents();
  language = readStoredLanguage();
  theme = readStoredTheme();
  applyTheme(theme);

  const languageSelect = element<GESelect>('language-select');
  const themeSelect = element<GESelect>('theme-select');
  languageSelect.addEventListener('value-change', (event) => {
    const next = (event as CustomEvent<{ value: string }>).detail.value;
    if (next !== 'zh-CN' && next !== 'en') return;
    language = next;
    writePreference(LANGUAGE_STORAGE_KEY, language);
    applyLocale();
    render();
    void refreshConversation(true);
  });
  themeSelect.addEventListener('value-change', (event) => {
    const next = (event as CustomEvent<{ value: string }>).detail.value;
    if (!isStudioTheme(next)) return;
    theme = next;
    writePreference(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
  });
  element<GEDialog>('settings-dialog').addEventListener('dialog-close', () => element<HTMLButtonElement>('settings-button').focus());
  applyLocale();
}

function applyLocale(): void {
  document.documentElement.lang = language;
  document.body.dataset.language = language;
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset.i18n ?? '');
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria ?? ''));
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle ?? '');

  const rightTabs = element<GETabs>('right-tabs');
  rightTabs.options = [{ label: t('agent'), value: 'agent' }, { label: t('logs'), value: 'logs' }];
  const resourceTabs = element<GETabs>('resource-tabs');
  resourceTabs.options = [
    { label: t('geometry'), value: 'geometry' }, { label: t('materials'), value: 'materials' },
    { label: t('textures'), value: 'textures' }, { label: t('models'), value: 'models' },
  ];
  const languageSelect = element<GESelect>('language-select');
  languageSelect.options = [{ label: t('chinese'), value: 'zh-CN' }, { label: t('english'), value: 'en' }];
  languageSelect.value = language;
  languageSelect.setAttribute('aria-label', t('language'));
  const themeSelect = element<GESelect>('theme-select');
  themeSelect.options = [
    { label: t('ocean'), value: 'ocean' }, { label: t('violet'), value: 'violet' },
    { label: t('emerald'), value: 'emerald' }, { label: t('amber'), value: 'amber' },
  ];
  themeSelect.value = theme;
  themeSelect.setAttribute('aria-label', t('themeColor'));
  element<GEDialog>('settings-dialog').heading = t('settings');
  if (currentStatusKey) element('status').textContent = t(currentStatusKey);
}

function applyTheme(value: StudioTheme): void {
  document.body.dataset.theme = value;
  document.documentElement.style.accentColor = 'var(--studio-accent)';
}

function t(key: string, values: Readonly<Record<string, string | number>> = {}): string {
  let value = UI_COPY[language][key] ?? UI_COPY.en[key] ?? key;
  for (const [name, replacement] of Object.entries(values)) value = value.replaceAll(`{${name}}`, String(replacement));
  return value;
}

function readStoredLanguage(): StudioLanguage {
  const value = readPreference(LANGUAGE_STORAGE_KEY);
  return value === 'en' ? 'en' : 'zh-CN';
}
function readStoredTheme(): StudioTheme { const value = readPreference(THEME_STORAGE_KEY); return isStudioTheme(value) ? value : 'ocean'; }
function isStudioTheme(value: string | null): value is StudioTheme { return value === 'ocean' || value === 'violet' || value === 'emerald' || value === 'amber'; }
function readPreference(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function writePreference(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Preferences are optional in restricted storage contexts. */ } }

function setupSplitLayout(): void {
  defineSplitComponents();
  const splits = [...document.querySelectorAll<GESplit>('ge-split[data-layout-key]')];
  if (splits.length !== 4) throw new Error(`Expected 4 editor split regions, found ${splits.length}.`);
  for (const split of splits) {
    const key = split.dataset.layoutKey;
    if (!key) continue;
    const savedRatio = readStoredSplitRatio(key);
    if (savedRatio !== null) split.ratio = savedRatio;
    split.addEventListener('ratio-change', (event) => {
      const detail = (event as CustomEvent<GESplitRatioChangeDetail>).detail;
      if (Number.isFinite(detail.ratio)) writeStoredSplitRatio(key, detail.ratio);
    });
  }
  document.body.dataset.splitLayout = 'ready';
}

function readStoredSplitRatio(key: string): number | null {
  try {
    const value = localStorage.getItem(`${SPLIT_LAYOUT_STORAGE_PREFIX}${key}`);
    if (value === null) return null;
    const ratio = Number(value);
    return Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : null;
  } catch { return null; }
}

function writeStoredSplitRatio(key: string, ratio: number): void {
  try { localStorage.setItem(`${SPLIT_LAYOUT_STORAGE_PREFIX}${key}`, String(ratio)); }
  catch { /* Layout persistence is optional when storage is unavailable. */ }
}

function bindUi(): void {
  element('new-project').addEventListener('click', () => void action(async () => {
    project = await invoke<ProjectSnapshot & JsonObject>('project/new', { name: 'HaiYue Game' });
    selection = { activeEntityId: null, source: 'system' };
    await refresh();
  }));
  element('open-project').addEventListener('click', () => void action(async () => { await invoke('project/open'); await refresh(); }));
  element('save-project').addEventListener('click', () => void action(async () => { await invoke('project/save'); await refresh(); }));
  element('undo').addEventListener('click', () => void action(async () => { await invoke('history/undo', { baseRevision: documentRevision() }); await refresh(); }));
  element('redo').addEventListener('click', () => void action(async () => { await invoke('history/redo', { baseRevision: documentRevision() }); await refresh(); }));
  element('create-empty').addEventListener('click', () => void createEntity('empty'));
  element('create-cube').addEventListener('click', () => void createEntity('cube'));
  element('apply-transform').addEventListener('click', () => void action(applyTransform));
  element('propose-script').addEventListener('click', () => void action(proposeScriptEdit));
  element('commit-script').addEventListener('click', () => void action(commitScriptEdit));
  element('prepare-preview').addEventListener('click', () => void action(preparePreview));
  element('approve-preview').addEventListener('click', () => void action(approveAndStartPreview));
  element('stop-preview').addEventListener('click', () => void action(stopPreview));
  element('viewport').addEventListener('click', (event) => void action(async () => {
    const pointer = event as MouseEvent;
    let entityId: StableId | null = null;
    try { entityId = viewport?.pick(pointer.clientX, pointer.clientY) ?? null; }
    catch (cause) { await reportViewport('picking-failed', errorMessage(cause), scene?.revision ?? 0); throw cause; }
    selection = await invoke<SelectionSnapshot & JsonObject>('scene/select', { entityId, source: 'viewport' });
    render();
  }));
  element('refresh-logs').addEventListener('click', () => void action(refreshLogs));
  element('export-logs').addEventListener('click', () => void action(exportBugBundle));
  element('settings-button').addEventListener('click', () => element<GEDialog>('settings-dialog').showModal());
  element('settings-done').addEventListener('click', () => element<GEDialog>('settings-dialog').close('action'));
  window.addEventListener('beforeunload', () => {
    agentPoll?.stop(); agentPoll = null;
    disposeConversationChanged?.(); disposeConversationChanged = null;
    viewport?.dispose(); void previewFrame?.dispose();
  }, { once: true });
}

async function pollAgent(): Promise<void> {
  const editorChanged = await refreshConversation(false);
  if (editorChanged) await refresh();
  await processAgentPreviewCommand();
}

async function refreshConversation(force: boolean): Promise<boolean> {
  const replay = await invoke<ConversationReplaySnapshot & JsonObject>('conversation/replay');
  if (!force && replay.revision === conversationRevision) return false;
  conversationRevision = replay.revision;
  const snapshot = conversationProjector.reset(replay);
  let editorChanged = false;
  for (const node of snapshot.nodes) {
    if (node.kind !== 'tool-result' || node.status !== 'completed') continue;
    if (!observedAgentToolResults.has(node.id)) editorChanged = true;
    observedAgentToolResults.add(node.id);
  }
  renderChatPanel(element('chat-content'), presentChatPanel(snapshot), (intent) => void dispatchConversation(intent));
  localizeChatUi(element('chat-content'));
  document.body.dataset.agentUi = 'ready';
  document.body.dataset.agentBackend = snapshot.backendId ?? 'none';
  document.body.dataset.agentBackendState = snapshot.backends.find((item) => item.id === snapshot.backendId)?.state ?? 'unavailable';
  return editorChanged;
}

async function dispatchConversation(intent: ConversationIntent): Promise<void> {
  try {
    setStatus('Agent intent pending…');
    await invoke('conversation/intent', { intent: intent as unknown as JsonObject });
    setStatus('Agent intent accepted');
  } catch (cause) { setStatus(errorMessage(cause)); }
  finally { agentPoll?.trigger(); }
}

const LOG_VIEW_LIMIT = 80;

function defaultLogQuery(nextSequence: number): LogQueryIntent {
  const afterSequence = nextSequence > LOG_VIEW_LIMIT ? nextSequence - LOG_VIEW_LIMIT - 1 : undefined;
  return Object.freeze({
    limit: LOG_VIEW_LIMIT,
    traverseCorrelation: false,
    ...(afterSequence === undefined ? {} : { afterSequence }),
  });
}

async function currentLogQuery(): Promise<LogQueryIntent> {
  const snapshot = await invoke<ProjectSnapshot & JsonObject>('project/snapshot');
  return defaultLogQuery(snapshot.logging.nextSequence);
}

async function refreshLogs(): Promise<void> {
  const result = await invoke<LogViewerResult & JsonObject>('logs/query', { query: await currentLogQuery() as unknown as JsonObject });
  const list = element('log-items');
  list.replaceChildren();
  for (const event of result.events) {
    const row = document.createElement('li');
    row.className = `log-row severity-${event.severity}`;
    row.textContent = `#${event.sequence} ${event.severity} ${event.kind} · ${event.source}`;
    row.title = `${event.timestamp} · ${event.payloadDigest}`;
    list.append(row);
  }
  const retained = result.status.eventCount;
  element('log-health').textContent = retained !== undefined && retained > result.events.length
    ? t('newestLogs', { health: result.status.health, visible: result.events.length, total: retained })
    : t('logCount', { health: result.status.health, visible: result.events.length });
}

async function exportBugBundle(): Promise<void> {
  const result = await invoke<JsonObject>('logs/export', { query: await currentLogQuery() as unknown as JsonObject });
  element('log-health').textContent = t('bugExported', { digest: String(result.contentDigest ?? '') });
}

async function processAgentPreviewCommand(): Promise<void> {
  const value = await invoke<AgentPreviewCommandReadModel & JsonObject>('preview/agent-command');
  const command = value.command;
  if (!value.pending || !command || command.id === handledPreviewCommand) return;
  handledPreviewCommand = command.id;
  try {
    if (command.kind === 'start') {
      if (!command.plan) throw new Error('Agent preview start command has no plan.');
      if (playing) await stopPreview();
      if (!command.scene) await refresh();
      await startPreview(command.plan, command.scene ?? scene);
    } else await stopPreview();
    await invoke('preview/agent-result', { commandId: command.id, ok: true, snapshot: previewSnapshot() });
  } catch (cause) {
    await invoke('preview/agent-result', { commandId: command.id, ok: false, message: errorMessage(cause) });
  }
}

function previewSnapshot(): JsonObject {
  const position = previewFrame?.latestPosition() ?? null;
  return Object.freeze({
    instanceId: playing ? previewFrame?.previewId ?? null : null,
    state: playing ? (previewFrame?.runtimeErrorCount() ? 'faulted' : 'playing') : 'stopped',
    entityId: playing ? previewFrame?.targetEntityId() ?? null : null,
    position,
    disposableCount: previewFrame?.ownedDisposableCount() ?? 0,
    errors: Object.freeze([]),
  });
}

async function createEntity(kind: 'empty' | 'cube'): Promise<void> {
  await action(async () => {
    scene = await invoke<SceneSnapshot & JsonObject>('scene/create', {
      commandId: `command:create-${kind}:${requestSequence + 1}`,
      baseRevision: documentRevision(),
      kind,
    });
    await refresh();
  });
}

async function applyTransform(): Promise<void> {
  const entityId = selection.activeEntityId;
  if (!entityId) throw new Error('Select an entity before editing Transform.');
  const value = (axis: string): number => Number(element<HTMLInputElement>(axis).value);
  scene = await invoke<SceneSnapshot & JsonObject>('scene/transform', {
    commandId: `command:transform:${requestSequence + 1}`,
    baseRevision: documentRevision(),
    entityId,
    transform: {
      position: { x: value('position-x'), y: value('position-y'), z: value('position-z') },
      rotationDegrees: { x: value('rotation-x'), y: value('rotation-y'), z: value('rotation-z') },
      scale: { x: value('scale-x'), y: value('scale-y'), z: value('scale-z') },
    },
  });
  await refresh();
}

async function refresh(): Promise<void> {
  project = await invoke<ProjectSnapshot & JsonObject>('project/snapshot');
  scene = await invoke<SceneSnapshot & JsonObject>('scene/snapshot');
  scripts = await invoke<ScriptCatalogSnapshot & JsonObject>('script/snapshot');
  if (selection.activeEntityId && !scene.entities.some((entity) => entity.id === selection.activeEntityId)) {
    selection = await invoke<SelectionSnapshot & JsonObject>('scene/select', { entityId: null, source: 'system' });
  }
  render();
}

function render(): void {
  const hierarchy = element('hierarchy-items');
  hierarchy.replaceChildren();
  for (const entity of scene?.entities ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    const depth = Math.min(6, hierarchyDepth(entity, scene!));
    button.className = `entity depth-${depth}${entity.id === selection.activeEntityId ? ' active' : ''}`;
    button.textContent = `${entity.kind === 'cube' ? '◇' : '○'} ${entity.name}`;
    button.dataset.entityId = entity.id;
    button.addEventListener('click', () => void action(async () => {
      selection = await invoke<SelectionSnapshot & JsonObject>('scene/select', { entityId: entity.id, source: 'hierarchy' });
      render();
    }));
    hierarchy.append(button);
  }
  const selected = scene?.entities.find((entity) => entity.id === selection.activeEntityId) ?? null;
  element('selection-label').textContent = selected ? selected.name : t('noSelection');
  setTransformInputs(selected?.transform ?? null);
  element<HTMLButtonElement>('apply-transform').disabled = !selected;
  element<HTMLButtonElement>('undo').disabled = !project?.history.canUndo;
  element<HTMLButtonElement>('redo').disabled = !project?.history.canRedo;
  element('project-name').textContent = project?.document?.name ?? t('noProject');
  element('revision').textContent = t('revision', { document: project?.document?.revision ?? 0, scene: scene?.revision ?? 0 });
  element('viewport-empty-state').hidden = (scene?.entities.some((entity) => entity.kind === 'cube') ?? false) || playing;
  renderScriptPanel(selected);
  if (scene && viewport && !playing) viewport.apply(scene, selection.activeEntityId);
}

function renderScriptPanel(selected: SceneEntitySnapshot | null): void {
  const script = selected ? scripts.resources.find((resource) => resource.entityId === selected.id) : undefined;
  const identity = `${selected?.id ?? ''}:${script?.textRevision ?? 0}`;
  if (identity !== loadedScriptIdentity) {
    loadedScriptIdentity = identity;
    element<HTMLTextAreaElement>('script-source').value = selected ? script?.text ?? DEMO_SCRIPT : '';
    pendingScriptProposal = null;
    previewDisclosure = null;
    element('script-diagnostics').textContent = selected ? 'Edit the script, then create a validated proposal.' : 'Select an entity to author a script.';
  }
  element<HTMLButtonElement>('propose-script').disabled = !selected || playing;
  element<HTMLButtonElement>('commit-script').disabled = !pendingScriptProposal || playing;
  element<HTMLButtonElement>('prepare-preview').disabled = !script || playing;
  element<HTMLButtonElement>('approve-preview').disabled = !previewDisclosure || playing;
  element<HTMLButtonElement>('stop-preview').disabled = !playing;
}

async function proposeScriptEdit(): Promise<void> {
  const entityId = selection.activeEntityId;
  if (!entityId) throw new Error('Select an entity before editing a script.');
  pendingScriptProposal = await invoke<ScriptProposal & JsonObject>('script/propose', {
    entityId, text: element<HTMLTextAreaElement>('script-source').value, baseRevision: documentRevision(), capabilities: ['read', 'input', 'debug'],
  });
  const diagnostics = pendingScriptProposal.diagnostics;
  element('script-diagnostics').textContent = diagnostics.length
    ? diagnostics.map((item) => `${item.code} ${item.line}:${item.column} ${item.message}`).join('\n')
    : `Proposal ready: +${pendingScriptProposal.addedLines} / -${pendingScriptProposal.removedLines} lines. Review and commit.`;
  renderScriptPanel(scene?.entities.find((entity) => entity.id === entityId) ?? null);
}

async function commitScriptEdit(): Promise<void> {
  if (!pendingScriptProposal) throw new Error('Create a script proposal first.');
  if (pendingScriptProposal.diagnostics.some((item) => item.severity === 'error')) throw new Error('Fix script diagnostics before commit.');
  await invoke('script/commit', { proposalId: pendingScriptProposal.id, commandId: `command:script:${requestSequence + 1}` });
  pendingScriptProposal = null;
  await refresh();
  element('script-diagnostics').textContent = 'Script committed through Document History.';
}

async function preparePreview(): Promise<void> {
  const entityId = selection.activeEntityId;
  const script = scripts.resources.find((resource) => resource.entityId === entityId);
  if (!script) throw new Error('Commit a valid script before Play.');
  if (!scene?.entities.some((entity) => entity.kind === 'cube')) {
    throw new Error('Preview scene has no renderable entities. Create at least one Cube before Play.');
  }
  previewDisclosure = await invoke<PreviewDisclosure & JsonObject>('preview/prepare', { scriptId: script.id, capabilities: ['read', 'input', 'debug'] });
  element('preview-disclosure').textContent = `Risk: ${previewDisclosure.risk}. Capabilities: ${previewDisclosure.capabilities.join(', ')}. Script r${script.textRevision}.`;
  renderScriptPanel(scene?.entities.find((entity) => entity.id === entityId) ?? null);
}

async function approveAndStartPreview(): Promise<void> {
  if (!previewDisclosure) throw new Error('Prepare a preview disclosure first.');
  const grant = await invoke<PreviewGrant & JsonObject>('preview/authorize', { planId: previewDisclosure.id, approved: true });
  const plan = await invoke<ConsumedPreviewPlan & JsonObject>('preview/consume', { grantId: grant.id });
  await startPreview(plan);
  previewDisclosure = null;
}

async function startPreview(plan: ConsumedPreviewPlan, sourceScene: SceneSnapshot | null = scene): Promise<void> {
  if (!sourceScene) throw new Error('No scene is available for preview.');
  if (!sourceScene.entities.some((entity) => entity.kind === 'cube')) {
    throw new Error('Preview scene has no renderable entities. Create at least one Cube before Play.');
  }
  viewport?.dispose();
  viewport = null;
  const frame = new SandboxedPreviewFrame(plan.entityId);
  previewFrame = frame;
  try { await frame.start(sourceScene, plan); }
  catch (cause) {
    await frame.dispose();
    if (previewFrame === frame) previewFrame = null;
    viewport = new WebGpuViewportRuntime(element<HTMLCanvasElement>('viewport'));
    await viewport.initialize();
    viewport.apply(sourceScene, selection.activeEntityId);
    throw cause;
  }
  playing = true;
  element('viewport-empty-state').hidden = true;
  document.body.dataset.preview = 'playing';
  element('preview-disclosure').textContent = `Playing isolated trusted-project preview with ${plan.capabilities.join(', ')}.`;
  renderScriptPanel(sourceScene.entities.find((entity) => entity.id === plan.entityId) ?? null);
}

async function stopPreview(): Promise<void> {
  if (!playing) return;
  document.body.dataset.smokeStage = 'preview-cleanup-requested';
  const old = previewFrame;
  const previewId = old?.previewId;
  const disposedSideEffects = await old?.dispose() ?? 0;
  document.body.dataset.smokeStage = 'preview-realm-disposed';
  previewFrame = null;
  await reportPreview('stopped', 'Preview stopped.', disposedSideEffects, previewId, selection.activeEntityId);
  playing = false;
  document.body.dataset.preview = 'stopped';
  viewport = new WebGpuViewportRuntime(element<HTMLCanvasElement>('viewport'));
  await viewport.initialize();
  document.body.dataset.smokeStage = 'authoring-viewport-restored';
  if (scene) viewport.apply(scene, selection.activeEntityId);
  element('viewport-empty-state').hidden = scene?.entities.some((entity) => entity.kind === 'cube') ?? false;
  element('preview-disclosure').textContent = 'Preview stopped; authoring Scene restored.';
  renderScriptPanel(scene?.entities.find((entity) => entity.id === selection.activeEntityId) ?? null);
}

async function runSmokeWorkflow(): Promise<void> {
  document.body.dataset.smokeStage = 'g05-start';
  if (!scene || !project) throw new Error('Smoke workflow has no project scene.');
  if (scene.entities.length === 0) {
    scene = await invoke<SceneSnapshot & JsonObject>('scene/create', {
      commandId: 'command:smoke-create-cube', baseRevision: documentRevision(), kind: 'cube', name: 'Smoke Cube',
    });
    await refresh();
  }
  document.body.dataset.smokeStage = 'cube-created';
  await nextFrames(3);
  const center = viewport!.canvasCenter();
  const picked = viewport!.pick(center.x, center.y);
  if (!picked) throw new Error('Real viewport picking did not hit the visible Cube.');
  document.body.dataset.smokeStage = 'cube-picked';
  selection = await invoke<SelectionSnapshot & JsonObject>('scene/select', { entityId: picked, source: 'viewport' });
  render();
  await refresh();
  scene = await invoke<SceneSnapshot & JsonObject>('scene/transform', {
    commandId: 'command:smoke-transform-cube', baseRevision: documentRevision(), entityId: picked,
    transform: { position: { x: 0.4, y: 0.2, z: 0 }, rotationDegrees: { x: 0, y: 30, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  });
  project = await invoke<ProjectSnapshot & JsonObject>('project/snapshot');
  await invoke('history/undo', { baseRevision: documentRevision() });
  project = await invoke<ProjectSnapshot & JsonObject>('project/snapshot');
  await invoke('history/redo', { baseRevision: documentRevision() });
  await invoke('project/save');
  await invoke('project/reopen');
  await refresh();
  if (!scene.entities.some((entity) => entity.id === picked && entity.transform.position.x === 0.4)) throw new Error('Saved scene did not survive reopen.');
  await viewport!.exerciseDeviceLoss();
  document.body.dataset.smokeStage = 'device-recovered';
  render();
  const scriptProposal = await invoke<ScriptProposal & JsonObject>('script/propose', {
    entityId: picked, text: DEMO_SCRIPT, baseRevision: documentRevision(), capabilities: ['read', 'input', 'debug'],
  });
  document.body.dataset.smokeStage = 'script-proposed';
  if (scriptProposal.diagnostics.some((item) => item.severity === 'error')) throw new Error(`Smoke script validation failed: ${JSON.stringify(scriptProposal.diagnostics)}`);
  await invoke('script/commit', { proposalId: scriptProposal.id, commandId: 'command:smoke-script-edit' });
  await refresh();
  const smokeScript = scripts.resources.find((resource) => resource.entityId === picked);
  if (!smokeScript) throw new Error('Smoke script did not commit.');
  const disclosure = await invoke<PreviewDisclosure & JsonObject>('preview/prepare', { scriptId: smokeScript.id, capabilities: ['read', 'input', 'debug'] });
  const grant = await invoke<PreviewGrant & JsonObject>('preview/authorize', { planId: disclosure.id, approved: true });
  const previewPlan = await invoke<ConsumedPreviewPlan & JsonObject>('preview/consume', { grantId: grant.id });
  await startPreview(previewPlan);
  document.body.dataset.smokeStage = 'preview-playing';
  let moved = false;
  for (let frame = 0; frame < 30 && !moved; frame += 1) {
    await nextFrames(1);
    const position = previewFrame!.latestPosition();
    moved = Boolean(position && Math.abs(position.x - 0.4) > 0.05);
  }
  if (!moved) throw new Error('Trusted preview script did not visibly move the Cube.');
  previewFrame!.hotReload(`if (!component.bound) { component.bound = true; api.debug.setInterval(() => {}, 1000); }`);
  await nextFrames(2);
  document.body.dataset.smokeStage = 'preview-hot-reloaded';
  if (previewFrame!.ownedDisposableCount() !== 1) throw new Error('Preview timer was not owned by ScriptExecutionScope.');
  previewFrame!.hotReload(`throw new Error('injected preview fault');`);
  await nextFrames(2);
  document.body.dataset.smokeStage = 'preview-fault-observed';
  if (previewFrame!.runtimeErrorCount() === 0 || previewFrame!.ownedDisposableCount() !== 0) throw new Error('Preview fault/cleanup evidence is missing.');
  await stopPreview();
  document.body.dataset.smokeStage = 'preview-stopped';
  if (scene.entities.find((entity) => entity.id === picked)?.transform.position.x !== 0.4) throw new Error('Preview mutation leaked into the edit document.');
  document.body.dataset.workflow = 'create-pick-transform-undo-redo-save-reopen';
  document.body.dataset.webgpu = 'ready';
  document.body.dataset.deviceRecovery = 'ready';
  document.body.dataset.scriptWorkflow = 'proposal-commit-approve-play-hot-reload-fault-stop-isolated';
  await nextFrames(2);
}

async function reportViewport(event: 'ready' | 'rendered' | 'device-lost' | 'failed' | 'picking-failed', message: string, sceneRevision: number, entityId?: StableId | null): Promise<void> {
  await invoke('viewport/report', entityId ? { event, message, sceneRevision, entityId } : { event, message, sceneRevision });
}

async function reportPreview(event: 'started' | 'stopped' | 'hot-reloaded' | 'runtime-error' | 'cleanup-complete', message: string, disposableCount: number, previewId?: StableId | null, entityId?: StableId | null): Promise<void> {
  await invoke('preview/report', {
    event, message, disposableCount,
    ...(previewId ? { previewId } : {}),
    ...(entityId ? { entityId } : {}),
  });
}

async function action(operation: () => Promise<void>): Promise<void> {
  try { setStatus('Working…'); await operation(); setStatus('Ready'); }
  catch (cause) { setStatus(errorMessage(cause)); }
}

function setTransformInputs(value: TransformSnapshot | null): void {
  const groups = [
    ['position', value?.position], ['rotation', value?.rotationDegrees], ['scale', value?.scale],
  ] as const;
  for (const [prefix, vector] of groups) for (const axis of ['x', 'y', 'z'] as const) {
    element<HTMLInputElement>(`${prefix}-${axis}`).value = String(vector?.[axis] ?? (prefix === 'scale' ? 1 : 0));
  }
}

function hierarchyDepth(entity: SceneEntitySnapshot, snapshot: SceneSnapshot): number {
  let depth = 0;
  let parentId = entity.parentId;
  const visited = new Set<StableId>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = snapshot.entities.find((candidate) => candidate.id === parentId)?.parentId ?? null;
  }
  return depth;
}

function documentRevision(): number {
  if (!project?.document) throw new Error('No project is open.');
  return project.document.revision;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing UI element #${id}.`);
  return value as T;
}

const STATUS_MESSAGE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'Starting typed editor services…': document.body.dataset.shell === 'web' ? 'startingWeb' : 'starting',
  'AIStudio scene authoring ready': 'editorReady',
  'Agent intent pending…': 'agentPending',
  'Agent intent accepted': 'agentAccepted',
  'Working…': 'working',
  Ready: 'ready',
});

function setStatus(message: string): void {
  currentStatusKey = STATUS_MESSAGE_KEYS[message] ?? null;
  element('status').textContent = currentStatusKey ? t(currentStatusKey) : message;
}

function localizeChatUi(root: HTMLElement): void {
  const connection = root.querySelector<HTMLElement>('.chat-connection');
  if (connection) {
    const state = connection.textContent?.split(':').at(-1)?.trim() ?? 'disconnected';
    connection.textContent = `${t('connection')}: ${t(state)}`;
  }
  const jump = root.querySelector<HTMLButtonElement>('.chat-jump-latest');
  if (jump) { jump.textContent = t('latest'); jump.setAttribute('aria-label', t('jumpLatest')); }
  const input = root.querySelector<HTMLTextAreaElement>('.chat-composer textarea');
  if (input) { input.setAttribute('aria-label', t('messageAgent')); input.placeholder = t('messageAgent'); }
  const backend = root.querySelector<HTMLSelectElement>('.chat-backend-controls select');
  if (backend) backend.setAttribute('aria-label', t('agentBackend'));
  const labels: Readonly<Record<string, string>> = Object.freeze({
    Send: 'send', 'Cancel turn': 'cancelTurn', Reconnect: 'reconnect', 'Sign out': 'signOut',
    'Configure API key securely': 'configureKey', 'Sign in with ChatGPT': 'signIn',
    'Allow once': 'allowOnce', 'Allow always': 'allowAlways', Reject: 'reject',
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
    const key = labels[button.textContent?.trim() ?? ''];
    if (key) button.textContent = t(key);
  }
  const composerStatus = root.querySelector<HTMLElement>('#chat-composer-status');
  if (composerStatus?.textContent === 'Ready to send.') composerStatus.textContent = t('readyToSend');
  else if (composerStatus?.textContent === 'Wait for the active turn or cancel it.') composerStatus.textContent = t('waitTurn');
}
function tuple(value: Vec3Snapshot): [number, number, number] { return [value.x, value.y, value.z]; }
function tupleRadians(value: Vec3Snapshot): [number, number, number] { const factor = Math.PI / 180; return [value.x * factor, value.y * factor, value.z * factor]; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (): void => { if (count-- <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

function isPreviewRealmMessage(value: unknown): value is PreviewRealmMessage {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).protocol === 'haiyue-preview/1'
    && typeof (value as Record<string, unknown>).type === 'string';
}

function isVec3(value: unknown): value is Readonly<{ x: number; y: number; z: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isFinite(record.x) && Number.isFinite(record.y) && Number.isFinite(record.z);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function deferred<T>(): Readonly<{
  promise: Promise<T>; resolve(value?: T): void; reject(cause: unknown): void; readonly settled: boolean;
}> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (cause?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return {
    promise,
    resolve(value?: T): void { if (!settled) { settled = true; resolvePromise(value as T); } },
    reject(cause: unknown): void { if (!settled) { settled = true; rejectPromise(cause); } },
    get settled(): boolean { return settled; },
  };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); }, (cause) => { window.clearTimeout(timer); reject(cause); });
  });
}

void boot();
