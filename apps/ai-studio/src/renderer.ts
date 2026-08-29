import {
  CartesianTransform3D,
  Entity,
  HaiyueEngine,
  OrbitControl,
  SphericalTransform3D,
  type Scene,
} from '@haiyue/engine';
import { MeshHelper } from '@haiyue/engine/experimental';
import { createInteractionRaycastResult, InteractionSystem } from '@haiyue/engine/systems';
import type { ScriptCapabilityName } from '@haiyue/engine/components';
import type { JsonObject, StableId } from '@haiyue/ai-studio-contracts';
import {
  ConversationProjector,
  LogViewerController,
  presentChatPanel,
  renderChatPanel,
  renderLogViewer,
  type ConversationIntent,
  type ConversationReplaySnapshot,
  type LogQueryIntent,
  type LogViewerReadModel,
  type SafeLogPage,
} from '@haiyue/ai-studio-shell';
import type { StudioIpcMethod, StudioIpcRequest, StudioIpcResponse } from './ipc.js';
import { AgentPollScheduler } from './agent-poll-scheduler.js';
import {
  PLAY_DEVICE_PROFILES,
  calculatePlayViewportScale,
  findPlayDeviceProfile,
  normalizePlayViewportSize,
  rotatePlayViewportSize,
  type PlayViewportSize,
} from './play-device-profiles.js';
import { loadPreviewAssets, releasePreviewAssetUrls, type PreviewAssetManifestEntry, type PreviewRuntimeAsset } from './preview-asset-transfer.js';
import { attachSceneEntityVisuals, installSceneEntityMaterialRenderers, isLightSceneKind, isRenderableSceneKind } from './scene-entity-rendering.js';
import {
  applyProjectCamera,
  applyProjectCameraProjection,
  DEFAULT_PROJECT_CAMERA,
  projectCameraFromSettings,
  type ProjectCameraSnapshot,
} from '@haiyue/ai-studio-editor-plugins/camera-authoring';
import type {
  SceneEntityKind,
  SceneMaterialKind,
  SelectionIntentSource,
} from '@haiyue/ai-studio-editor-plugins';
import { defineBorderBeamComponents } from '@haiyue/ui/border-beam';
import { defineDialogComponents, type HYDialog } from '@haiyue/ui/dialog';
import { defineSelectComponents, type HYSelect } from '@haiyue/ui/select';
import { defineSplitComponents, type HYSplit, type HYSplitRatioChangeDetail } from '@haiyue/ui/split';
import { defineTabsComponents, type HYTabs } from '@haiyue/ui/tabs';

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
  readonly id: StableId; readonly name: string; readonly kind: SceneEntityKind;
  readonly parentId: StableId | null; readonly order: number; readonly transform: TransformSnapshot;
  readonly components?: readonly Readonly<{ id: StableId; type: StableId; version: string; enabled: boolean; value: JsonObject }>[];
  readonly appearance?: Readonly<{ material: SceneMaterialKind; color: readonly [number, number, number, number] }>;
  readonly light?: Readonly<{ color: readonly [number, number, number]; intensity: number; range?: number; direction?: readonly [number, number, number]; castShadow?: boolean }>;
}
interface SceneSnapshot { readonly revision: number; readonly documentId: StableId; readonly entities: readonly SceneEntitySnapshot[]; readonly assets?: readonly PreviewAssetManifestEntry[]; readonly camera?: ProjectCameraSnapshot; }
interface ProjectSnapshot {
  readonly smoke?: boolean;
  readonly document: Readonly<{ revision: number; savedRevision: number; dirty: boolean; name: string; settings: JsonObject }> | null;
  readonly history: Readonly<{ canUndo: boolean; canRedo: boolean }>;
  readonly logging: Readonly<{ health: string; canPersist: boolean; nextSequence: number; eventCount: number }>;
}
interface SelectionSnapshot { readonly activeEntityId: StableId | null; readonly source: string; }
interface ScriptResourceSnapshot { readonly id: StableId; readonly entityId: StableId; readonly name?: string; readonly text: string; readonly textRevision: number; readonly enabled: boolean; readonly order: number; readonly dirty: boolean; }
interface ScriptCatalogSnapshot { readonly documentRevision: number; readonly resources: readonly ScriptResourceSnapshot[]; }
interface ScriptProposal { readonly id: StableId; readonly diagnostics: readonly ScriptDiagnostic[]; readonly addedLines: number; readonly removedLines: number; }
interface ScriptDiagnostic { readonly code: string; readonly severity: 'error' | 'warning'; readonly line: number; readonly column: number; readonly message: string; }
interface PreviewScriptDisclosure { readonly scriptId: StableId; readonly entityId: StableId; readonly order: number; readonly textRevision: number; readonly digest: string; readonly capabilities: readonly ScriptCapabilityName[]; readonly diagnostics: readonly ScriptDiagnostic[]; }
interface PreviewDisclosure {
  readonly id: StableId; readonly documentId: StableId; readonly documentRevision: number;
  readonly selection: 'all-enabled' | 'explicit'; readonly scriptSetDigest: string;
  readonly scripts: readonly PreviewScriptDisclosure[]; readonly capabilities: readonly ScriptCapabilityName[];
  readonly runtimeConfig: Readonly<{ schemaVersion: 1; mode: 'fixed-step'; tickRateHz: number; maxSubSteps: number; seed: string }>;
  readonly risk: 'trusted-project';
  readonly diagnostics: readonly (ScriptDiagnostic & Readonly<{ scriptId: StableId; entityId: StableId }>)[];
}
interface PreviewGrant { readonly id: StableId; }
interface ConsumedPreviewPlan extends Omit<PreviewDisclosure, 'scripts'> { readonly scripts: readonly (PreviewScriptDisclosure & Readonly<{ emittedText: string }>)[]; }
interface AgentPreviewCommandReadModel { readonly pending: boolean; readonly command?: Readonly<{ id: StableId; kind: 'start' | 'stop' | 'step' | 'input' | 'inspect' | 'capture'; scene?: SceneSnapshot; plan?: ConsumedPreviewPlan; count?: number; event?: JsonObject }> }
let requestSequence = 0;
let project: ProjectSnapshot | null = null;
let scene: SceneSnapshot | null = null;
let selection: SelectionSnapshot = { activeEntityId: null, source: 'system' };
let selectionIntentGeneration = 0;
let viewport: WebGpuViewportRuntime | null = null;
let previewFrame: SandboxedPreviewFrame | null = null;
let scripts: ScriptCatalogSnapshot = { documentRevision: 0, resources: [] };
let pendingScriptProposal: ScriptProposal | null = null;
let previewDisclosure: PreviewDisclosure | null = null;
let playing = false;
let previewPaused = false;
let playViewportMode = 'responsive';
let playViewportSize: PlayViewportSize = Object.freeze({ width: 393, height: 852 });
let playStageResizeObserver: ResizeObserver | null = null;
let loadedScriptIdentity = '';
const conversationProjector = new ConversationProjector();
let conversationRevision = -1;
const observedAgentToolResults = new Set<StableId>();
let agentPoll: AgentPollScheduler | null = null;
let disposeConversationChanged: (() => void) | null = null;
let logViewer: LogViewerController | null = null;
let logViewerSubscription: Readonly<{ dispose(): void }> | null = null;
let handledPreviewCommand: StableId | null = null;
let conversationBackendId: StableId | null = null;
let conversationCanSend = false;
type ProjectRunRepairContext =
  | Readonly<{ kind: 'script-errors'; scriptId: StableId; entityId: StableId; entityName: string; diagnostics: readonly ScriptDiagnostic[] }>
  | Readonly<{ kind: 'missing-script'; projectName: string; entities: readonly Readonly<{ id: StableId; name: string; kind: SceneEntityKind }>[] }>;
let runScriptContext: ProjectRunRepairContext | null = null;
const scriptDiagnosticsById = new Map<StableId, Readonly<{ textRevision: number; diagnostics: readonly ScriptDiagnostic[] }>>();
const DEMO_SCRIPT = document.body.dataset.shell === 'web'
  ? `const transform = entity.getComponent('CartesianTransform3D');\ntransform?.setPosition(0.4 + Math.sin(time / 500) * 0.8, 0.2, 0);`
  : `const transform = entity.getComponent('CartesianTransform3D') as unknown as { setPosition(x: number, y: number, z: number): unknown } | null;\ntransform?.setPosition(0.4 + Math.sin(time / 500) * 0.8, 0.2, 0);`;
const SPLIT_LAYOUT_STORAGE_PREFIX = 'haiyue.ai-studio.split.v2.';
const LANGUAGE_STORAGE_KEY = 'haiyue.ai-studio.language.v1';
const THEME_STORAGE_KEY = 'haiyue.ai-studio.theme.v1';
type StudioLanguage = 'zh-CN' | 'en';
type StudioTheme = 'light' | 'dark';
let language: StudioLanguage = 'zh-CN';
let theme: StudioTheme = 'dark';
let currentStatusKey: string | null = document.body.dataset.shell === 'web' ? 'startingWeb' : 'starting';

const UI_COPY: Readonly<Record<StudioLanguage, Readonly<Record<string, string>>>> = Object.freeze({
  'zh-CN': Object.freeze({
    newProject: '新建', openProject: '打开', saveProject: '保存', run: '▶ 运行', stop: '■ 停止', runTitle: '运行项目', stopTitle: '停止运行', undo: '撤销', redo: '重做', settings: '设置',
    playPage: '独立运行预览', playRunning: '运行中', playPaused: '已暂停', playStarting: '正在启动…', device: '设备', devicePreset: '设备预设', responsive: '自适应', custom: '自定义', width: '宽', height: '高', customWidth: '自定义宽度', customHeight: '自定义高度', applySize: '应用', rotateDevice: '旋转设备', pause: '⏸ 暂停', resume: '▶ 继续', fullscreen: '全屏', exitFullscreen: '退出全屏', exitPlay: '退出运行',
    scene: '场景', createEmpty: '+ 空物体', createCube: '+ 立方体', inspector: '检查器', noSelection: '未选择物体',
    transformHistory: 'Transform 修改会通过历史记录提交。', position: '位置', rotation: '旋转', scale: '缩放', applyTransform: '应用 Transform',
    noRenderables: '没有可渲染物体', noRenderablesHint: '创建一个基础几何体即可显示。', authoring: '编辑', assets: '资源库',
    cube: '立方体', sphere: '球体', cone: '锥体', cylinder: '圆柱体', plane: '平面', torus: '圆环', icosahedron: '二十面体', lights: '光源', directionalLight: '方向光', pointLight: '点光源', ambientLight: '环境光', builtinGeometry: '点击创建', defaultMaterial: '默认材质', builtinMaterial: '应用到选中几何体', basicMaterial: 'Basic', pbrMaterial: 'PBR', blinnPhongMaterial: 'Blinn-Phong', normalMaterial: 'Normal', noTextures: '项目中暂无纹理', noModels: '项目中暂无模型', noScripts: '项目中暂无脚本',
    geometry: '几何体', materials: '材质', textures: '纹理', models: '模型', scripts: '脚本', scriptRevision: '脚本 r{revision}', scriptUnvalidated: '尚未验证', scriptValid: '验证通过', scriptErrors: '{count} 个错误', agent: 'AI 助手', logs: '日志', agentConversation: 'AI 助手对话',
    refresh: '刷新', exportLogs: '导出安全问题包', downloadLogs: '下载安全日志包', loading: '加载中…', starting: '正在启动 AIStudio…', startingWeb: '正在启动 AIStudio Web…',
    language: '语言', themeColor: '主题色', settingsSaved: '偏好会保存在当前设备中。', done: '完成', browserLocal: '浏览器本地', cancel: '取消', approveRun: '批准并运行', fixWithAgent: '让 AI 自动修复', runApprovalHeading: '运行项目', runApprovalIntro: '项目脚本将在隔离预览环境中运行。请确认本次能力授权。', runValidationFailed: '脚本验证失败，暂时无法运行。', runValidationHint: '请让 AI 修复这些脚本错误，然后重新点击运行。', runMissingScriptHeading: '没有已提交的控制脚本，项目无法运行。', runMissingScriptDetail: '当前场景只有静态实体。脚本可能曾经生成，但尚未获得批准并写入项目。', runMissingScriptHint: '请让 AI 重新生成、验证并提交控制脚本，再批准执行。', agentFixUnavailable: 'AI 助手当前不可发送消息，请先连接后端或等待当前任务完成。', fixRequestSent: '已向 AI 助手发送脚本修复任务',
    webCapability: 'Web 模式将项目和结构化日志保存在当前浏览器中。本地 Codex、API Key、任意目录和原生问题包需要 Electron 应用。',
    chinese: '简体中文', english: 'English', lightTheme: '海月月光', darkTheme: '海月夜幕',
    revision: '文档 r{document} · 场景 r{scene}', ready: '就绪', working: '处理中…', saving: '正在保存项目…', projectSaved: '项目已保存', unsavedChanges: '有未保存的更改', allChangesSaved: '所有更改均已保存', preparingRun: '正在准备隔离预览…', previewRunning: '项目正在运行', previewStopped: '项目已停止', scriptValidationFailed: '脚本验证失败', noProjectRun: '请先新建或打开项目。', noRenderableRun: '场景中没有可渲染物体，请先创建一个立方体。', noScriptRun: '没有可运行的脚本，请先让 AI 或脚本工具为实体创建并提交脚本。', runDisclosure: '{entity} · 风险：{risk} · 能力：{capabilities}', agentPending: '正在提交 AI 请求…', agentAccepted: 'AI 请求已接受', editorReady: 'AIStudio 场景编辑器已就绪',
    newestLogs: '{health} · 显示最新 {visible} / {total} 条安全摘要', logCount: '{health} · {visible} 条安全摘要', bugExported: '问题包已导出 · {digest}',
    connection: '连接', connected: '已连接', reconnecting: '正在重连', disconnected: '已断开', latest: '↓ 最新', send: '发送', cancelTurn: '取消本轮', reconnect: '重新连接', signOut: '退出登录',
    configureKey: '安全配置 API Key', signIn: '使用 ChatGPT 登录', messageAgent: '向游戏创作 AI 助手发送消息', readyToSend: '可以发送。', waitTurn: '请等待当前任务完成或取消任务。',
    allowOnce: '仅允许一次', allowAlways: '始终允许', reject: '拒绝', agentBackend: 'AI 后端', jumpLatest: '跳到最新 AI 消息', noProject: '未打开项目',
  }),
  en: Object.freeze({
    newProject: 'New', openProject: 'Open', saveProject: 'Save', run: '▶ Run', stop: '■ Stop', runTitle: 'Run project', stopTitle: 'Stop project', undo: 'Undo', redo: 'Redo', settings: 'Settings',
    playPage: 'Standalone play preview', playRunning: 'Running', playPaused: 'Paused', playStarting: 'Starting…', device: 'Device', devicePreset: 'Device preset', responsive: 'Responsive', custom: 'Custom', width: 'W', height: 'H', customWidth: 'Custom width', customHeight: 'Custom height', applySize: 'Apply', rotateDevice: 'Rotate device', pause: '⏸ Pause', resume: '▶ Resume', fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen', exitPlay: 'Exit play',
    scene: 'Scene', createEmpty: '+ Empty', createCube: '+ Cube', inspector: 'Inspector', noSelection: 'No entity selected',
    transformHistory: 'Transform values are committed through History.', position: 'Position', rotation: 'Rotation', scale: 'Scale', applyTransform: 'Apply Transform',
    noRenderables: 'No renderable entities', noRenderablesHint: 'Create a primitive geometry to render the scene.', authoring: 'Authoring', assets: 'Assets',
    cube: 'Cube', sphere: 'Sphere', cone: 'Cone', cylinder: 'Cylinder', plane: 'Plane', torus: 'Torus', icosahedron: 'Icosahedron', lights: 'Lights', directionalLight: 'Directional Light', pointLight: 'Point Light', ambientLight: 'Ambient Light', builtinGeometry: 'Click to create', defaultMaterial: 'Default Material', builtinMaterial: 'Apply to selected geometry', basicMaterial: 'Basic', pbrMaterial: 'PBR', blinnPhongMaterial: 'Blinn-Phong', normalMaterial: 'Normal', noTextures: 'No textures in this project', noModels: 'No models in this project', noScripts: 'No scripts in this project',
    geometry: 'Geometry', materials: 'Materials', textures: 'Textures', models: 'Models', scripts: 'Scripts', scriptRevision: 'Script r{revision}', scriptUnvalidated: 'Not validated', scriptValid: 'Valid', scriptErrors: '{count} error(s)', agent: 'AI Agent', logs: 'Logs', agentConversation: 'Agent conversation',
    refresh: 'Refresh', exportLogs: 'Export safe bug bundle', downloadLogs: 'Download safe log bundle', loading: 'Loading…', starting: 'Starting AIStudio…', startingWeb: 'Starting AIStudio Web…',
    language: 'Language', themeColor: 'Theme color', settingsSaved: 'Preferences are stored on this device.', done: 'Done', browserLocal: 'Browser-local', cancel: 'Cancel', approveRun: 'Approve and run', fixWithAgent: 'Ask Agent to fix', runApprovalHeading: 'Run project', runApprovalIntro: 'Project scripts run in an isolated preview environment. Confirm this capability grant.', runValidationFailed: 'Script validation failed; the project cannot run yet.', runValidationHint: 'Ask the Agent to fix these script errors, then run again.', runMissingScriptHeading: 'No committed controller script; the project cannot run.', runMissingScriptDetail: 'The current scene contains static entities only. A script may have been generated but has not yet been approved and written to the project.', runMissingScriptHint: 'Ask the Agent to regenerate, validate, and commit the controller script, then approve it.', agentFixUnavailable: 'The Agent cannot send right now. Connect a backend or wait for the active turn to finish.', fixRequestSent: 'Script repair task sent to the Agent',
    webCapability: 'Web mode stores projects and structured logs in this browser. Local Codex, API keys, arbitrary folders, and native bug bundles require the Electron app.',
    chinese: '简体中文', english: 'English', lightTheme: 'Haiyue Moonlight', darkTheme: 'Haiyue Nightfall',
    revision: 'Document r{document} · Scene r{scene}', ready: 'Ready', working: 'Working…', saving: 'Saving project…', projectSaved: 'Project saved', unsavedChanges: 'Unsaved changes', allChangesSaved: 'All changes saved', preparingRun: 'Preparing isolated preview…', previewRunning: 'Project is running', previewStopped: 'Project stopped', scriptValidationFailed: 'Script validation failed', noProjectRun: 'Create or open a project first.', noRenderableRun: 'The scene has no renderable entities. Create a Cube first.', noScriptRun: 'No runnable script is available. Ask the Agent or script tools to create and commit one for an entity.', runDisclosure: '{entity} · Risk: {risk} · Capabilities: {capabilities}', agentPending: 'Agent intent pending…', agentAccepted: 'Agent intent accepted', editorReady: 'AIStudio scene authoring ready',
    newestLogs: '{health} · newest {visible} of {total} safe summaries', logCount: '{health} · {visible} safe summaries', bugExported: 'Bug bundle exported · {digest}',
    connection: 'Connection', connected: 'connected', reconnecting: 'reconnecting', disconnected: 'disconnected', latest: '↓ Latest', send: 'Send', cancelTurn: 'Cancel turn', reconnect: 'Reconnect', signOut: 'Sign out',
    configureKey: 'Configure API key securely', signIn: 'Sign in with ChatGPT', messageAgent: 'Message the game authoring Agent', readyToSend: 'Ready to send.', waitTurn: 'Wait for the active turn or cancel it.',
    allowOnce: 'Allow once', allowAlways: 'Allow always', reject: 'Reject', agentBackend: 'Agent backend', jumpLatest: 'Jump to latest agent message', noProject: 'No project',
  }),
});

async function invoke<T extends JsonObject>(channel: StudioIpcMethod, payload: JsonObject = {}, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  const sequence = ++requestSequence;
  const requestId = `request:renderer:${sequence}` as StableId;
  const cancel = (): void => window.haiyueStudio.cancel(requestId);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await window.haiyueStudio.invoke({
    schemaVersion: 1,
    id: requestId,
    correlationId: `correlation:renderer:${sequence}` as StableId,
    channel,
    payload,
    });
    if (!response.ok) {
      const diagnostic = response.payload.diagnostic as Readonly<{ message?: string; code?: string }> | undefined;
      throw new Error(diagnostic?.message ?? diagnostic?.code ?? `${channel} failed.`);
    }
    return response.payload as T;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

class WebGpuViewportRuntime {
  private engine: HaiyueEngine | null = null;
  private engineScene: Scene | null = null;
  private interaction: InteractionSystem | null = null;
  private orbitControl: OrbitControl | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly stableByEngineId = new Map<number, StableId>();
  private readonly entitiesByStableId = new Map<StableId, Entity>();
  private selectedEntityId: StableId | null = null;
  private cameraSnapshot: ProjectCameraSnapshot | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;

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
    installSceneEntityMaterialRenderers(engine, engineScene);
    const cameraTransform = engineScene.cameraEntity.getComponent(SphericalTransform3D);
    if (!cameraTransform) throw new Error('Authoring camera is missing SphericalTransform3D.');
    this.orbitControl = new OrbitControl(this.canvas, cameraTransform, {
      rotateSpeed: 0.9, zoomSpeed: 0.9, panSpeed: 0.8, minRadius: 0.5, maxRadius: 200,
    });
    this.interaction = new InteractionSystem(engine, engineScene.cameraEntity, { continuousHover: false });
    engine.switchScene(engineScene);
    this.resizeObserver = new ResizeObserver(() => {
      engine.resizeToDisplaySize();
      if (this.cameraSnapshot && this.engineScene) applyProjectCameraProjection(this.engineScene, this.cameraSnapshot, this.canvasAspect());
    });
    this.resizeObserver.observe(this.canvas);
    engine.resizeToDisplaySize(true);
    engine.run();
    await reportViewport('ready', 'WebGPU viewport initialized.', scene?.revision ?? 0);
  }

  apply(snapshot: SceneSnapshot, selectedEntityId: StableId | null): void {
    const engineScene = this.requireScene();
    const nextCamera = snapshot.camera ?? currentProjectCamera();
    if (!this.cameraSnapshot || !sameCamera(this.cameraSnapshot, nextCamera)) {
      this.cameraSnapshot = nextCamera;
      applyProjectCamera(engineScene, nextCamera, this.canvasAspect());
    }
    engineScene.clear({ keepCamera: true });
    this.stableByEngineId.clear();
    this.entitiesByStableId.clear();
    const entities = new Map<StableId, Entity>();
    this.selectedEntityId = selectedEntityId;
    for (const item of snapshot.entities) {
      const entity = new Entity(item.name);
      entity.addComponent(new CartesianTransform3D({
        position: tuple(item.transform.position),
        rotation: tupleRadians(item.transform.rotationDegrees),
        scale: tuple(item.transform.scale),
      }));
      attachSceneEntityVisuals(entity, item);
      if (item.id === selectedEntityId && isRenderableSceneKind(item.kind)) entity.addComponent(new MeshHelper({ mode: 'aabb', color: [1, 0.66, 0.16, 1], lineWidth: 2 }));
      entities.set(item.id, entity);
      this.entitiesByStableId.set(item.id, entity);
      this.stableByEngineId.set(entity.id, item.id);
    }
    for (const item of snapshot.entities) {
      const entity = entities.get(item.id)!;
      if (item.parentId) entities.get(item.parentId)?.addChild(entity);
      else engineScene.add(entity);
    }
    // The running engine owns scene updates so each render gets a fresh swap-chain view.
    void reportViewport('rendered', selectedEntityId ?? 'Scene rendered.', snapshot.revision, selectedEntityId);
  }

  select(selectedEntityId: StableId | null): void {
    if (selectedEntityId === this.selectedEntityId) return;
    this.setSelectionHelper(this.selectedEntityId, false);
    this.setSelectionHelper(selectedEntityId, true);
    this.selectedEntityId = selectedEntityId;

  }
  updateTransform(entityId: StableId, transform: TransformSnapshot): void {
    const component = this.entitiesByStableId.get(entityId)?.getComponent(CartesianTransform3D);
    if (!component) return;
    component.setPosition(transform.position.x, transform.position.y, transform.position.z);
    const rotation = tupleRadians(transform.rotationDegrees);
    component.setRotation(rotation[0], rotation[1], rotation[2]);
    component.setScale(transform.scale.x, transform.scale.y, transform.scale.z);
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

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.orbitControl?.dispose();
    this.orbitControl = null;
    this.interaction?.destroy();
    this.interaction = null;
    this.stableByEngineId.clear();
    this.entitiesByStableId.clear();
    const engine = this.engine;
    this.engine = null;
    this.engineScene = null;
    this.selectedEntityId = null;
    engine?.stop();
    this.disposal = disposeEngineAfterSubmittedFrames(engine);
    return this.disposal;
  }

  private requireScene(): Scene {
    if (this.disposed || !this.engineScene) throw new Error('WebGPU viewport is not ready.');
    return this.engineScene;
  }

  private canvasAspect(): number {
    const width = this.canvas.width || this.canvas.clientWidth;
    const height = this.canvas.height || this.canvas.clientHeight;
    return width > 0 && height > 0 ? width / height : 1;
  }

  private setSelectionHelper(entityId: StableId | null, selected: boolean): void {
    if (entityId === null) return;
    const entity = this.entitiesByStableId.get(entityId);
    if (!entity) return;
    const helper = entity.getComponent(MeshHelper);
    if (selected && !helper) entity.addComponent(new MeshHelper({ mode: 'aabb', color: [1, 0.66, 0.16, 1], lineWidth: 2 }));
    else if (!selected && helper) entity.removeComponent(helper);
  }
}

async function disposeEngineAfterSubmittedFrames(engine: HaiyueEngine | null): Promise<void> {
  if (!engine) return;
  try {
    if (engine.state === 'ready') await engine.device.queue.onSubmittedWorkDone();
  } catch {
    // A lost device rejects queued-work completion; destroy still owns final cleanup.
  } finally {
    engine.destroy();
  }
}

type PreviewRealmMessage = Readonly<Record<string, unknown> & { protocol: 'haiyue-preview/1'; type: string }>;
type DeferredSignal = Readonly<{ promise: Promise<void>; resolve(value?: void): void; reject(cause: unknown): void; readonly settled: boolean }>;

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
  private paused = false;
  private pauseChange: DeferredSignal | null = null;
  private expectedPaused = false;
  private readonly runtimeAssets: PreviewRuntimeAsset[] = [];
  private scriptSetDigest: string | null = null;
  private scriptDescriptors: readonly Readonly<{ scriptId: StableId; entityId: StableId; order: number }>[] = Object.freeze([]);
  private readonly scriptDisposables = new Map<StableId, number>();
  private readonly scriptPositions = new Map<StableId, Readonly<{ x: number; y: number; z: number }>>();
  private readonly faultedScripts = new Set<StableId>();
  private readonly startController = new AbortController();
  private requestSequence = 0;
  private readonly observationRequests = new Map<string, ReturnType<typeof deferred<JsonObject>>>();
  private readonly stepRequests = new Map<string, ReturnType<typeof deferred<void>>>();
  private readonly captureRequests = new Map<string, ReturnType<typeof deferred<Readonly<{ base64: string; byteLength: number; tick: number; frame: number }>>>>();
  private documentRevision = 0;
  private scriptDigests: readonly string[] = Object.freeze([]);

  constructor(private readonly entityId: StableId) {
    this.frame.id = 'preview-frame';
    this.frame.title = 'Isolated trusted-project game preview';
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.src = document.body.dataset.shell === 'web' ? './preview.html' : 'haiyue-preview://app/preview.html';
    window.addEventListener('message', this.onMessage);
    element('play-device-screen').append(this.frame);
  }

  async start(snapshot: SceneSnapshot, plan: ConsumedPreviewPlan): Promise<void> {
    await withTimeout(this.ready.promise, 10_000, 'Preview realm did not become ready.');
    this.scriptSetDigest = plan.scriptSetDigest;
    this.documentRevision = plan.documentRevision;
    this.scriptDigests = Object.freeze(plan.scripts.map((script) => script.digest));
    this.scriptDescriptors = Object.freeze(plan.scripts.map(({ scriptId, entityId, order }) => Object.freeze({ scriptId, entityId, order })));
    const assets = await loadPreviewAssets(snapshot, (assetId) => invoke('asset/read', { assetId }), undefined, this.startController.signal);
    if (this.disposed) {
      releasePreviewAssetUrls(assets);
      throw new Error('Preview realm was disposed while loading assets.');
    }
    this.runtimeAssets.push(...assets);
    const { assets: _assetManifest, ...runtimeScene } = snapshot;
    this.post({ type: 'start', scene: runtimeScene, plan, assets });
    await withTimeout(this.started.promise, 15_000, 'Preview realm did not start.');
  }

  hotReload(scriptId: StableId, emittedText: string): void {
    if (this.disposed) throw new Error('Preview realm is disposed.');
    this.post({ type: 'hot-reload', scriptId, emittedText });
  }

  async setPaused(paused: boolean): Promise<void> {
    if (this.disposed) throw new Error('Preview realm is disposed.');
    if (this.paused === paused) return;
    if (this.pauseChange && !this.pauseChange.settled) throw new Error('Preview pause transition is already pending.');
    const change = deferred<void>();
    this.pauseChange = change;
    this.expectedPaused = paused;
    this.post({ type: paused ? 'pause' : 'resume' });
    await withTimeout(change.promise, 2_000, paused ? 'Preview pause acknowledgement timed out.' : 'Preview resume acknowledgement timed out.');
  }

  async step(count: number): Promise<JsonObject> {
    if (!this.paused) await this.setPaused(true);
    const requestId = this.nextRequestId('step');
    const completed = deferred<void>(); this.stepRequests.set(requestId, completed);
    this.post({ type: 'step', requestId, count });
    await withTimeout(completed.promise, 5_000, 'Preview step acknowledgement timed out.').finally(() => this.stepRequests.delete(requestId));
    return this.inspect();
  }

  async input(event: JsonObject): Promise<JsonObject> { this.post({ type: 'input', event }); return this.inspect(); }

  async inspect(): Promise<JsonObject> {
    const requestId = this.nextRequestId('inspect');
    const request = deferred<JsonObject>(); this.observationRequests.set(requestId, request);
    this.post({ type: 'inspect', requestId });
    const value = await withTimeout(request.promise, 5_000, 'Preview inspection timed out.').finally(() => this.observationRequests.delete(requestId));
    return this.withProvenance(value);
  }

  async capture(): Promise<JsonObject> {
    const requestId = this.nextRequestId('capture');
    const request = deferred<Readonly<{ base64: string; byteLength: number; tick: number; frame: number }>>(); this.captureRequests.set(requestId, request);
    this.post({ type: 'capture', requestId });
    const value = await withTimeout(request.promise, 8_000, 'Preview screenshot timed out.').finally(() => this.captureRequests.delete(requestId));
    return Object.freeze({ ...this.provenance(value.tick, value.frame), mediaType: 'image/png', byteLength: value.byteLength, base64: value.base64 });
  }

  latestPosition(): Readonly<{ x: number; y: number; z: number }> | null { return this.position; }
  targetEntityId(): StableId { return this.entityId; }
  ownedDisposableCount(): number { return this.disposableCount; }
  runtimeErrorCount(): number { return this.runtimeErrors; }
  activeScriptSetDigest(): string | null { return this.scriptSetDigest; }
  scriptSnapshots(): readonly JsonObject[] {
    return Object.freeze(this.scriptDescriptors.map((script) => Object.freeze({
      ...script,
      state: this.faultedScripts.has(script.scriptId) ? 'faulted' : 'playing',
      position: this.scriptPositions.get(script.scriptId) ?? (script.entityId === this.entityId ? this.position : null),
      disposableCount: this.scriptDisposables.get(script.scriptId) ?? 0,
      errorCount: this.faultedScripts.has(script.scriptId) ? 1 : 0,
    })));
  }

  async dispose(): Promise<number> {
    if (this.disposed) return 0;
    this.disposed = true;
    this.startController.abort(new Error('Preview realm was disposed while loading assets.'));
    this.pauseChange?.resolve();
    for (const request of this.observationRequests.values()) request.reject(new Error('Preview realm disposed.'));
    for (const request of this.stepRequests.values()) request.reject(new Error('Preview realm disposed.'));
    for (const request of this.captureRequests.values()) request.reject(new Error('Preview realm disposed.'));
    this.observationRequests.clear(); this.stepRequests.clear(); this.captureRequests.clear();
    const ownedBeforeStop = this.disposableCount;
    this.post({ type: 'stop' });
    await withTimeout(this.cleanup.promise, 2_000, 'Preview cleanup acknowledgement timed out.').catch(() => undefined);
    window.removeEventListener('message', this.onMessage);
    this.frame.remove();
    releasePreviewAssetUrls(this.runtimeAssets);
    this.runtimeAssets.length = 0;
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
      if (Array.isArray(message.scripts)) for (const script of message.scripts) {
        if (script !== null && typeof script === 'object' && !Array.isArray(script)) {
          const value = script as Record<string, unknown>;
          if (typeof value.scriptId === 'string') {
            const scriptId = value.scriptId as StableId;
            this.scriptDisposables.set(scriptId, finiteNumber(value.disposableCount, 0));
            if (isVec3(value.position)) this.scriptPositions.set(scriptId, Object.freeze({ x: value.position.x, y: value.position.y, z: value.position.z }));
          }
        }
      }
    } else if (message.type === 'hot-reloaded') {
      this.disposableCount = finiteNumber(message.disposableCount, this.disposableCount);
      void reportPreview('hot-reloaded', 'Runtime-only script replacement applied.', this.disposableCount, this.previewId, this.entityId);
    } else if (message.type === 'paused' || message.type === 'resumed') {
      this.paused = message.type === 'paused';
      if (this.pauseChange && this.expectedPaused === this.paused) this.pauseChange.resolve();
      void reportPreview(this.paused ? 'paused' : 'resumed', this.paused ? 'Preview paused.' : 'Preview resumed.', this.disposableCount, this.previewId, this.entityId);
    } else if (message.type === 'runtime-error') {
      this.runtimeErrors += 1;
      if (typeof message.scriptId === 'string') this.faultedScripts.add(message.scriptId as StableId);
      this.disposableCount = finiteNumber(message.disposableCount, this.disposableCount);
      const code = typeof message.code === 'string' ? message.code : 'preview-runtime-error';
      const detail = typeof message.message === 'string' ? message.message : 'Preview runtime failed.';
      element('script-diagnostics').textContent = `${code} ${finiteNumber(message.line, 1)}:${finiteNumber(message.column, 1)} ${detail}`;
      void reportPreview('runtime-error', detail, this.disposableCount, this.previewId, this.entityId);
      if (!this.started.settled) this.started.reject(new Error(detail));
    } else if (message.type === 'inspection' && typeof message.requestId === 'string' && isJsonObject(message.value)) {
      this.observationRequests.get(message.requestId)?.resolve(message.value);
    } else if (message.type === 'stepped' && typeof message.requestId === 'string') {
      this.stepRequests.get(message.requestId)?.resolve();
    } else if (message.type === 'capture' && typeof message.requestId === 'string' && typeof message.base64 === 'string'
      && Number.isSafeInteger(message.byteLength) && Number(message.byteLength) >= 8 && Number(message.byteLength) <= 376 * 1024
      && Number.isSafeInteger(message.tick) && Number.isSafeInteger(message.frame)) {
      this.captureRequests.get(message.requestId)?.resolve(Object.freeze({ base64: message.base64, byteLength: Number(message.byteLength), tick: Number(message.tick), frame: Number(message.frame) }));
    } else if (message.type === 'request-failed' && typeof message.requestId === 'string') {
      const cause = new Error(typeof message.message === 'string' ? message.message : 'Preview observation request failed.');
      this.observationRequests.get(message.requestId)?.reject(cause); this.stepRequests.get(message.requestId)?.reject(cause); this.captureRequests.get(message.requestId)?.reject(cause);
    } else if (message.type === 'cleanup-complete') {
      this.disposableCount = finiteNumber(message.disposableCount, 0);
      this.cleanup.resolve();
      void reportPreview('cleanup-complete', 'Preview Engine/World/ScriptExecutionScope released.', this.disposableCount, this.previewId, this.entityId);
    }
  };

  private post(payload: Readonly<Record<string, unknown>>): void {
    this.frame.contentWindow?.postMessage({ protocol: 'haiyue-preview/1', ...payload }, '*');
  }

  private nextRequestId(kind: string): string { this.requestSequence += 1; return `${this.previewId}:${kind}:${this.requestSequence}`; }
  private withProvenance(value: JsonObject): JsonObject {
    const tick = Number.isSafeInteger(value.tick) ? Number(value.tick) : 0;
    const frame = Number.isSafeInteger(value.frame) ? Number(value.frame) : tick;
    return Object.freeze({ ...this.provenance(tick, frame), value });
  }
  private provenance(tick: number, frame: number): JsonObject {
    const screen = element('play-device-screen');
    return Object.freeze({ playId: this.previewId, documentRevision: this.documentRevision, scriptDigests: this.scriptDigests, tick, frame, viewport: Object.freeze({ width: Math.max(1, screen.clientWidth), height: Math.max(1, screen.clientHeight) }), device: playViewportMode, capturedAt: new Date().toISOString() });
  }
}

async function boot(): Promise<void> {
  document.body.dataset.startupStage = 'ui';
  setStatus('Starting typed editor services…');
  setupUiPreferences();
  setupSplitLayout();
  document.body.dataset.startupStage = 'services';
  const status = await invoke<ProjectSnapshot & JsonObject>('app/status');
  project = status;
  if (!project.document) project = await invoke<ProjectSnapshot & JsonObject>('project/new', { name: status.smoke ? 'G05 WebGPU smoke' : '未命名游戏' });
  bindUi();
  setupLogViewer();
  agentPoll = new AgentPollScheduler({
    intervalMs: 30_000,
    poll: pollAgent,
    onError: (cause) => setStatus(errorMessage(cause)),
    schedule: (task, delayMs) => window.setTimeout(task, delayMs),
    cancel: (handle) => window.clearTimeout(handle as number),
  });
  disposeConversationChanged = window.haiyueStudio.onConversationChanged(() => agentPoll?.trigger());
  agentPoll.start();
  document.body.dataset.agentSync = 'push-single-flight';
  void logViewer?.refresh().catch((cause) => setStatus(errorMessage(cause)));
  document.body.dataset.startupStage = 'viewport';
  viewport = new WebGpuViewportRuntime(element<HTMLCanvasElement>('viewport'));
  try {
    await viewport.initialize();
    document.body.dataset.webgpu = 'ready';
    await refresh();
    if (status.smoke) await runSmokeWorkflow();
    document.body.dataset.status = 'ready';
    document.body.dataset.startupStage = 'ready';
    setStatus('AIStudio scene authoring ready');
  } catch (cause) {
    document.body.dataset.status = 'error';
    setStatus(errorMessage(cause));
    await reportViewport('failed', errorMessage(cause), scene?.revision ?? 0).catch(() => {});
    throw cause;
  }
}

function setupUiPreferences(): void {
  defineBorderBeamComponents();
  defineTabsComponents();
  defineDialogComponents();
  defineSelectComponents();
  language = readStoredLanguage();
  theme = readStoredTheme();
  applyTheme(theme);

  const languageSelect = element<HYSelect>('language-select');
  const themeSelect = element<HYSelect>('theme-select');
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
  element<HYDialog>('settings-dialog').addEventListener('dialog-close', () => element<HTMLButtonElement>('settings-button').focus());
  element<HYDialog>('run-dialog').addEventListener('dialog-close', () => {
    if (!playing) previewDisclosure = null;
    element<HTMLButtonElement>('run-project').focus();
  });
  applyLocale();
}

function applyLocale(): void {
  document.documentElement.lang = language;
  document.body.dataset.language = language;
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset.i18n ?? '');
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria ?? ''));
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle ?? '');

  const rightTabs = element<HYTabs>('right-tabs');
  rightTabs.options = [{ label: t('agent'), value: 'agent' }, { label: t('logs'), value: 'logs' }];
  const resourceTabs = element<HYTabs>('resource-tabs');
  resourceTabs.options = [
    { label: t('geometry'), value: 'geometry' }, { label: t('materials'), value: 'materials' },
    { label: t('textures'), value: 'textures' }, { label: t('models'), value: 'models' }, { label: t('scripts'), value: 'scripts' },
  ];
  const languageSelect = element<HYSelect>('language-select');
  languageSelect.options = [{ label: t('chinese'), value: 'zh-CN' }, { label: t('english'), value: 'en' }];
  languageSelect.value = language;
  languageSelect.setAttribute('aria-label', t('language'));
  const themeSelect = element<HYSelect>('theme-select');
  themeSelect.options = [
    { label: t('darkTheme'), value: 'dark' },
    { label: t('lightTheme'), value: 'light' },
  ];
  themeSelect.value = theme;
  themeSelect.setAttribute('aria-label', t('themeColor'));
  element<HYDialog>('settings-dialog').heading = t('settings');
  element<HYDialog>('run-dialog').heading = t('runApprovalHeading');
  renderPlayDeviceOptions();
  updatePlayControls();
  if (currentStatusKey) element('status').textContent = t(currentStatusKey);
}

function applyTheme(value: StudioTheme): void {
  document.documentElement.dataset.hyTheme = value;
  document.body.dataset.theme = value;
  document.documentElement.style.accentColor = 'var(--hy-accent-color)';
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
function readStoredTheme(): StudioTheme { const value = readPreference(THEME_STORAGE_KEY); return isStudioTheme(value) ? value : 'dark'; }
function isStudioTheme(value: string | null): value is StudioTheme { return value === 'light' || value === 'dark'; }
function readPreference(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function writePreference(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Preferences are optional in restricted storage contexts. */ } }

function setupSplitLayout(): void {
  defineSplitComponents();
  const splits = [...document.querySelectorAll<HYSplit>('hy-split[data-layout-key]')];
  if (splits.length !== 4) throw new Error(`Expected 4 editor split regions, found ${splits.length}.`);
  for (const split of splits) {
    const key = split.dataset.layoutKey;
    if (!key) continue;
    const savedRatio = readStoredSplitRatio(key);
    if (savedRatio !== null) split.ratio = savedRatio;
    split.addEventListener('ratio-change', (event) => {
      const detail = (event as CustomEvent<HYSplitRatioChangeDetail>).detail;
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

function renderPlayDeviceOptions(): void {
  const select = element<HTMLSelectElement>('play-device-preset');
  const selected = playViewportMode;
  const responsive = document.createElement('option');
  responsive.value = 'responsive'; responsive.textContent = t('responsive');
  const phones = document.createElement('optgroup'); phones.label = language === 'zh-CN' ? '主流手机' : 'Phones';
  const tablets = document.createElement('optgroup'); tablets.label = language === 'zh-CN' ? '平板设备' : 'Tablets';
  for (const profile of PLAY_DEVICE_PROFILES) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.label} · ${profile.width}×${profile.height}`;
    (profile.category === 'phone' ? phones : tablets).append(option);
  }
  const custom = document.createElement('option'); custom.value = 'custom'; custom.textContent = t('custom');
  select.replaceChildren(responsive, phones, tablets, custom);
  select.value = [...select.options].some((option) => option.value === selected) ? selected : 'responsive';
}

function setupPlayPageControls(): void {
  const preset = element<HTMLSelectElement>('play-device-preset');
  preset.addEventListener('change', () => applyPlayDevicePreset(preset.value));
  element('play-apply-size').addEventListener('click', () => applyCustomPlayViewport());
  element('play-rotate').addEventListener('click', () => {
    playViewportMode = 'custom';
    applyPlayViewportLayout(rotatePlayViewportSize(playViewportSize));
    preset.value = 'custom';
  });
  for (const input of [element<HTMLInputElement>('play-custom-width'), element<HTMLInputElement>('play-custom-height')]) {
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') applyCustomPlayViewport(); });
  }
  element('play-pause').addEventListener('click', () => void action(togglePreviewPause));
  element('play-exit').addEventListener('click', () => void action(async () => { await stopPreview(); setStatus('Project stopped'); }));
  element('play-fullscreen').addEventListener('click', () => void action(togglePlayFullscreen));
  document.addEventListener('fullscreenchange', () => { updatePlayControls(); updatePlayViewportScale(); });
  playStageResizeObserver = new ResizeObserver(() => updatePlayViewportScale());
  playStageResizeObserver.observe(element('play-stage'));
  applyPlayViewportLayout(playViewportSize);
  document.body.dataset.playPage = 'standalone-device-simulation';
}

function applyPlayDevicePreset(id: string): void {
  playViewportMode = id;
  if (id === 'responsive') { applyPlayViewportLayout(playViewportSize); return; }
  if (id === 'custom') { applyCustomPlayViewport(); return; }
  const profile = findPlayDeviceProfile(id);
  if (!profile) { playViewportMode = 'responsive'; applyPlayViewportLayout(playViewportSize); return; }
  applyPlayViewportLayout(profile);
}

function applyCustomPlayViewport(): void {
  playViewportMode = 'custom';
  element<HTMLSelectElement>('play-device-preset').value = 'custom';
  applyPlayViewportLayout(normalizePlayViewportSize(
    Number(element<HTMLInputElement>('play-custom-width').value),
    Number(element<HTMLInputElement>('play-custom-height').value),
  ));
}

function applyPlayViewportLayout(size: PlayViewportSize): void {
  playViewportSize = normalizePlayViewportSize(size.width, size.height);
  const shell = element('play-device-shell');
  const responsive = playViewportMode === 'responsive';
  shell.dataset.responsive = String(responsive);
  element<HTMLInputElement>('play-custom-width').value = String(playViewportSize.width);
  element<HTMLInputElement>('play-custom-height').value = String(playViewportSize.height);
  if (responsive) {
    shell.style.removeProperty('width'); shell.style.removeProperty('height'); shell.style.removeProperty('--play-scale');
  } else {
    shell.style.width = `${playViewportSize.width}px`;
    shell.style.height = `${playViewportSize.height}px`;
  }
  updatePlayViewportScale();
}

function updatePlayViewportScale(): void {
  const stage = element('play-stage');
  const shell = element('play-device-shell');
  const label = element('play-size-label');
  if (playViewportMode === 'responsive') {
    label.textContent = stage.clientWidth > 0 && stage.clientHeight > 0 ? `${stage.clientWidth} × ${stage.clientHeight}` : t('responsive');
    return;
  }
  const scale = calculatePlayViewportScale(
    { width: playViewportSize.width + 16, height: playViewportSize.height + 16 },
    { width: stage.clientWidth, height: stage.clientHeight },
  );
  shell.style.setProperty('--play-scale', String(scale));
  label.textContent = `${playViewportSize.width} × ${playViewportSize.height} · ${Math.round(scale * 100)}%`;
}

function showPlayPage(): void {
  const page = element('play-page');
  page.hidden = false;
  document.body.dataset.page = 'play';
  element('play-project-name').textContent = project?.document?.name ?? t('playPage');
  previewPaused = false;
  updatePlayControls();
  requestAnimationFrame(() => updatePlayViewportScale());
}

async function hidePlayPage(): Promise<void> {
  const page = element('play-page');
  if (document.fullscreenElement === page) await document.exitFullscreen().catch(() => undefined);
  page.hidden = true;
  document.body.dataset.page = 'authoring';
  updatePlayControls();
}

async function togglePreviewPause(): Promise<void> {
  if (!playing || !previewFrame) return;
  const button = element<HTMLButtonElement>('play-pause');
  button.disabled = true;
  try {
    const next = !previewPaused;
    await previewFrame.setPaused(next);
    previewPaused = next;
    document.body.dataset.preview = next ? 'paused' : 'playing';
    setStatus(next ? 'Preview paused' : 'Project is running');
  } finally { updatePlayControls(); }
}

async function togglePlayFullscreen(): Promise<void> {
  const page = element('play-page');
  if (document.fullscreenElement === page) await document.exitFullscreen();
  else await page.requestFullscreen();
}

function updatePlayControls(): void {
  const state = element('play-state');
  state.textContent = !playing ? t('playStarting') : previewPaused ? t('playPaused') : t('playRunning');
  state.classList.toggle('is-paused', previewPaused);
  const pause = element<HTMLButtonElement>('play-pause');
  pause.disabled = !playing;
  pause.textContent = t(previewPaused ? 'resume' : 'pause');
  const fullscreen = element<HTMLButtonElement>('play-fullscreen');
  fullscreen.textContent = t(document.fullscreenElement === element('play-page') ? 'exitFullscreen' : 'fullscreen');
}

function bindUi(): void {
  setupPlayPageControls();
  element('new-project').addEventListener('click', () => void action(async () => {
    project = await invoke<ProjectSnapshot & JsonObject>('project/new', { name: 'HaiYue Game' });
    selection = { activeEntityId: null, source: 'system' };
    await refresh();
  }));
  element('open-project').addEventListener('click', () => void action(async () => { await invoke('project/open'); await refresh(); }));
  element('save-project').addEventListener('click', () => void saveProject());
  element('run-project').addEventListener('click', () => void toggleProjectRun());
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
  const viewportCanvas = element<HTMLCanvasElement>('viewport');
  let viewportPointerOrigin: Readonly<{ x: number; y: number }> | null = null;
  let viewportDragged = false;
  viewportCanvas.addEventListener('pointerdown', (event) => { viewportPointerOrigin = { x: event.clientX, y: event.clientY }; viewportDragged = false; });
  viewportCanvas.addEventListener('pointermove', (event) => {
    if (viewportPointerOrigin && Math.hypot(event.clientX - viewportPointerOrigin.x, event.clientY - viewportPointerOrigin.y) > 4) viewportDragged = true;
  });
  const clearViewportPointer = () => { viewportPointerOrigin = null; };
  viewportCanvas.addEventListener('pointerup', clearViewportPointer);
  viewportCanvas.addEventListener('pointercancel', clearViewportPointer);
  viewportCanvas.addEventListener('click', (event) => {
    if (viewportDragged) { viewportDragged = false; return; }
    void action(async () => {
      const pointer = event as MouseEvent;
      let entityId: StableId | null = null;
      try { entityId = viewport?.pick(pointer.clientX, pointer.clientY) ?? null; }
      catch (cause) { await reportViewport('picking-failed', errorMessage(cause), scene?.revision ?? 0); throw cause; }
      await selectEntity(entityId, 'viewport');
    });
  });
  element('settings-button').addEventListener('click', () => element<HYDialog>('settings-dialog').showModal());
  element('settings-done').addEventListener('click', () => element<HYDialog>('settings-dialog').close('action'));
  element('run-cancel').addEventListener('click', () => element<HYDialog>('run-dialog').close('cancel'));
  element('run-approve').addEventListener('click', () => void approveProjectRun());
  element('run-fix-agent').addEventListener('click', () => void requestAgentScriptFix());
  window.addEventListener('beforeunload', () => {
    agentPoll?.stop(); agentPoll = null;
    disposeConversationChanged?.(); disposeConversationChanged = null;
    logViewerSubscription?.dispose(); logViewerSubscription = null;
    logViewer?.dispose(); logViewer = null;
    playStageResizeObserver?.disconnect(); playStageResizeObserver = null;
    void viewport?.dispose(); void previewFrame?.dispose();
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
  conversationBackendId = snapshot.backendId;
  conversationCanSend = snapshot.connection === 'connected' && !snapshot.busy && snapshot.backendId !== null;
  let editorChanged = false;
  for (const node of snapshot.nodes) {
    if (node.kind !== 'tool-result' || node.status !== 'completed') continue;
    if (!observedAgentToolResults.has(node.id)) editorChanged = true;
    observedAgentToolResults.add(node.id);
  }
  renderChatPanel(element('chat-content'), presentChatPanel(snapshot), (intent) => void dispatchConversation(intent));
  localizeChatUi(element('chat-content'));
  updateFixAgentButton();
  document.body.dataset.agentUi = 'ready';
  document.body.dataset.agentBackend = snapshot.backendId ?? 'none';
  document.body.dataset.agentBackendState = snapshot.backends.find((item) => item.id === snapshot.backendId)?.state ?? 'unavailable';
  return editorChanged;
}

async function dispatchConversation(intent: ConversationIntent): Promise<boolean> {
  try {
    setStatus('Agent intent pending…');
    await invoke('conversation/intent', { intent: intent as unknown as JsonObject });
    setStatus('Agent intent accepted');
    return true;
  } catch (cause) { setStatus(errorMessage(cause)); return false; }
  finally { agentPoll?.trigger(); }
}

function setupLogViewer(): void {
  const viewer = new LogViewerController({
    async query(query, signal) {
      return await invoke<SafeLogPage & JsonObject>('logs/query', { query: query as unknown as JsonObject }, signal);
    },
    async copyText(text, signal) {
      if (signal.aborted) throw signal.reason;
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(text);
      if (signal.aborted) throw signal.reason;
    },
    async dispatch(intent, signal) {
      const result = await invoke<JsonObject>('logs/export', { query: intent.query as unknown as JsonObject }, signal);
      setStatus(t('bugExported', { digest: String(result.contentDigest ?? '') }));
    },
  });
  logViewer = viewer;
  logViewerSubscription = viewer.subscribe((model) => renderProductLogViewer(model, viewer));
}

function renderProductLogViewer(model: LogViewerReadModel, viewer: LogViewerController): void {
  const safely = (operation: () => Promise<void>): void => { void operation().catch((cause) => setStatus(errorMessage(cause))); };
  renderLogViewer(element('log-viewer'), model, {
    setFilters: (filters) => safely(() => viewer.setFilters(filters)),
    loadMore: () => safely(() => viewer.loadMore()),
    toggleCorrelation: (eventId) => { try { viewer.toggleCorrelation(eventId); } catch (cause) { setStatus(errorMessage(cause)); } },
    copySafeSummary: (eventId) => safely(() => viewer.copySafeSummary(eventId)),
    exportBugBundle: () => safely(() => viewer.exportBugBundle()),
  });
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
    } else if (command.kind === 'stop') await stopPreview();
    else {
      if (!playing || !previewFrame) throw new Error('Play is not active.');
      const result = command.kind === 'step' ? await previewFrame.step(Number(command.count))
        : command.kind === 'input' ? await previewFrame.input(command.event ?? Object.freeze({}))
          : command.kind === 'inspect' ? await previewFrame.inspect() : await previewFrame.capture();
      await invoke('preview/agent-result', { commandId: command.id, ok: true, snapshot: result });
      return;
    }
    await invoke('preview/agent-result', { commandId: command.id, ok: true, snapshot: previewSnapshot() });
  } catch (cause) {
    await invoke('preview/agent-result', { commandId: command.id, ok: false, message: errorMessage(cause) });
  }
}

function previewSnapshot(): JsonObject {
  const position = previewFrame?.latestPosition() ?? null;
  const runtimeScripts = playing ? previewFrame?.scriptSnapshots() ?? Object.freeze([]) : Object.freeze([]);
  return Object.freeze({
    instanceId: playing ? previewFrame?.previewId ?? null : null,
    state: playing ? (previewFrame?.runtimeErrorCount() ? 'faulted' : 'playing') : 'stopped',
    scriptSetDigest: playing ? previewFrame?.activeScriptSetDigest() ?? null : null,
    scriptCount: runtimeScripts.length,
    scripts: runtimeScripts,
    entityId: playing ? previewFrame?.targetEntityId() ?? null : null,
    position,
    disposableCount: previewFrame?.ownedDisposableCount() ?? 0,
    errors: Object.freeze([]),
  });
}

async function createEntity(kind: SceneEntityKind, material?: SceneMaterialKind): Promise<void> {
  await action(async () => {
    scene = await invoke<SceneSnapshot & JsonObject>('scene/create', {
      commandId: `command:create-${kind}:${requestSequence + 1}`,
      baseRevision: documentRevision(),
      kind,
      ...(material ? { material } : {}),
    });
    await refresh();
  });
}

async function applyTransform(): Promise<void> {
  const entityId = selection.activeEntityId;
  if (!entityId) throw new Error('Select an entity before editing Transform.');
  if (!scene) throw new Error('Open a project before editing Transform.');
  const value = (axis: string): number => Number(element<HTMLInputElement>(axis).value);
  const transform = Object.freeze({
    position: Object.freeze({ x: value('position-x'), y: value('position-y'), z: value('position-z') }),
    rotationDegrees: Object.freeze({ x: value('rotation-x'), y: value('rotation-y'), z: value('rotation-z') }),
    scale: Object.freeze({ x: value('scale-x'), y: value('scale-y'), z: value('scale-z') }),
  });
  const previousScene = scene;
  const previousEntity = previousScene.entities.find((entity) => entity.id === entityId);
  scene = Object.freeze({
    ...previousScene,
    entities: Object.freeze(previousScene.entities.map((entity) => entity.id === entityId ? Object.freeze({ ...entity, transform }) : entity)),
  });
  viewport?.updateTransform(entityId, transform);
  renderSelection();
  try {
    const authoritative = await invoke<SceneSnapshot & JsonObject>('scene/transform', {
      commandId: `command:transform:${requestSequence + 1}`,
      baseRevision: documentRevision(),
      entityId,
      transform,
    });
    scene = authoritative;
    const authoritativeEntity = authoritative.entities.find((entity) => entity.id === entityId);
    if (authoritativeEntity) viewport?.updateTransform(entityId, authoritativeEntity.transform);
    project = await invoke<ProjectSnapshot & JsonObject>('project/snapshot');
    renderProjectChrome();
    renderSelection();
  } catch (cause) {
    scene = previousScene;
    if (previousEntity) viewport?.updateTransform(entityId, previousEntity.transform);
    renderSelection();
    throw cause;
  }
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

async function saveProject(): Promise<void> {
  const button = element<HTMLButtonElement>('save-project');
  if (!project?.document || button.disabled) return;
  button.disabled = true;
  try {
    setStatus('Saving project…');
    await invoke('project/save');
    await refresh();
    setStatus('Project saved');
  } catch (cause) { setStatus(errorMessage(cause)); }
  finally { button.disabled = !project?.document; }
}

async function toggleProjectRun(): Promise<void> {
  const button = element<HTMLButtonElement>('run-project');
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (playing) {
      setStatus('Working…');
      await stopPreview();
      setStatus('Project stopped');
      return;
    }
    setStatus('Preparing isolated preview…');
    const valid = await prepareProjectRun();
    element<HYDialog>('run-dialog').showModal();
    setStatus(valid ? 'Ready' : runScriptContext?.kind === 'missing-script' ? t('runMissingScriptHeading') : 'Script validation failed');
  } catch (cause) { setStatus(errorMessage(cause)); }
  finally { updateRunButton(); }
}

async function prepareProjectRun(): Promise<boolean> {
  if (!project?.document || !scene) throw new Error(t('noProjectRun'));
  const sourceScene = scene;
  if (!sourceScene.entities.some((entity) => isRenderableSceneKind(entity.kind))) throw new Error(t('noRenderableRun'));
  const enabledScripts = scripts.resources.filter((script) => script.enabled).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  if (!enabledScripts.length) {
    previewDisclosure = null;
    runScriptContext = Object.freeze({
      kind: 'missing-script',
      projectName: project.document.name,
      entities: Object.freeze(sourceScene.entities.map(({ id, name, kind }) => Object.freeze({ id, name, kind }))),
    });
    element('run-disclosure-text').textContent = '';
    element('run-validation-heading').textContent = t('runMissingScriptHeading');
    element('run-diagnostics').textContent = t('runMissingScriptDetail');
    element('run-validation-hint').textContent = t('runMissingScriptHint');
    element('run-validation').hidden = false;
    element<HTMLButtonElement>('run-approve').disabled = true;
    updateFixAgentButton();
    return false;
  }

  previewDisclosure = await invoke<PreviewDisclosure & JsonObject>('preview/prepare', {});
  for (const planned of previewDisclosure.scripts) {
    const resource = enabledScripts.find((script) => script.id === planned.scriptId);
    if (resource) scriptDiagnosticsById.set(resource.id, Object.freeze({ textRevision: resource.textRevision, diagnostics: planned.diagnostics }));
  }
  const firstPlanned = previewDisclosure.scripts[0]!;
  const entity = sourceScene.entities.find((candidate) => candidate.id === firstPlanned.entityId);
  const firstErrors = previewDisclosure.diagnostics.filter((diagnostic) => diagnostic.scriptId === firstPlanned.scriptId);
  runScriptContext = Object.freeze({ kind: 'script-errors', scriptId: firstPlanned.scriptId, entityId: firstPlanned.entityId, entityName: entity?.name ?? firstPlanned.entityId, diagnostics: firstErrors });
  element('run-disclosure-text').textContent = t('runDisclosure', {
    entity: `${previewDisclosure.scripts.length} scripts`,
    risk: previewDisclosure.risk,
    capabilities: previewDisclosure.capabilities.join(', '),
  });
  element('preview-disclosure').textContent = element('run-disclosure-text').textContent;
  renderScriptPanel(entity ?? null, { preservePreviewDisclosure: true });
  const errors = previewDisclosure.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const validation = element('run-validation');
  element('run-validation-heading').textContent = t('runValidationFailed');
  element('run-validation-hint').textContent = t('runValidationHint');
  validation.hidden = errors.length === 0;
  element('run-diagnostics').textContent = errors.map((diagnostic) => `${diagnostic.code} ${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`).join('\n');
  element<HTMLButtonElement>('run-approve').disabled = errors.length > 0;
  updateFixAgentButton();
  renderScriptResources();
  return errors.length === 0;
}

async function approveProjectRun(): Promise<void> {
  const button = element<HTMLButtonElement>('run-approve');
  if (!previewDisclosure || button.disabled) return;
  button.disabled = true;
  let authorizationFailed = false;
  try {
    setStatus('Working…');
    await approveAndStartPreview();
    element<HYDialog>('run-dialog').close('action');
    setStatus('Project is running');
  } catch (cause) {
    authorizationFailed = true;
    const message = errorMessage(cause);
    previewDisclosure = null;
    element('run-validation').hidden = false;
    element('run-diagnostics').textContent = message;
    button.disabled = true;
    setStatus(message);
  }
  finally { button.disabled = authorizationFailed; updateRunButton(); }
}

function updateRunButton(): void {
  const button = element<HTMLButtonElement>('run-project');
  button.disabled = !project?.document;
  button.textContent = t(playing ? 'stop' : 'run');
  button.title = t(playing ? 'stopTitle' : 'runTitle');
  button.setAttribute('aria-label', button.title);
  button.classList.toggle('is-playing', playing);
}

const BUILTIN_GEOMETRIES: readonly Readonly<{ kind: SceneEntityKind; label: string; icon: string }>[] = Object.freeze([
  { kind: 'cube', label: 'cube', icon: '◇' }, { kind: 'sphere', label: 'sphere', icon: '●' }, { kind: 'cone', label: 'cone', icon: '▲' },
  { kind: 'cylinder', label: 'cylinder', icon: '▣' }, { kind: 'plane', label: 'plane', icon: '▱' }, { kind: 'torus', label: 'torus', icon: '◎' },
  { kind: 'icosahedron', label: 'icosahedron', icon: '⬡' },
]);
const BUILTIN_LIGHTS: readonly Readonly<{ kind: SceneEntityKind; label: string; icon: string }>[] = Object.freeze([
  { kind: 'directional-light', label: 'directionalLight', icon: '☀' }, { kind: 'point-light', label: 'pointLight', icon: '✦' }, { kind: 'ambient-light', label: 'ambientLight', icon: '◉' },
]);
const BUILTIN_MATERIALS: readonly Readonly<{ kind: SceneMaterialKind; label: string }>[] = Object.freeze([
  { kind: 'basic', label: 'basicMaterial' }, { kind: 'pbr', label: 'pbrMaterial' }, { kind: 'blinn-phong', label: 'blinnPhongMaterial' },
  { kind: 'normal', label: 'normalMaterial' },
]);

function renderBuiltinResources(selected: SceneEntitySnapshot | null): void {
  const geometryRoot = element('geometry-resources');
  geometryRoot.replaceChildren();
  for (const resource of BUILTIN_GEOMETRIES) geometryRoot.append(resourceButton(resource.icon, t(resource.label), t('builtinGeometry'), () => void createEntity(resource.kind)));
  const lightLabel = document.createElement('strong'); lightLabel.className = 'resource-group-label'; lightLabel.textContent = t('lights'); geometryRoot.append(lightLabel);
  for (const resource of BUILTIN_LIGHTS) geometryRoot.append(resourceButton(resource.icon, t(resource.label), t('builtinGeometry'), () => void createEntity(resource.kind)));

  const materialRoot = element('material-resources');
  materialRoot.replaceChildren();
  const canApply = Boolean(selected && isRenderableSceneKind(selected.kind));
  for (const resource of BUILTIN_MATERIALS) {
    const button = resourceButton('◩', t(resource.label), t('builtinMaterial'), () => void applyMaterial(resource.kind));
    button.dataset.materialKind = resource.kind;
    button.disabled = !canApply;
    button.classList.toggle('is-active', selected?.appearance?.material === resource.kind);
    materialRoot.append(button);
  }
}

function updateMaterialResources(selected: SceneEntitySnapshot | null): void {
  const canApply = Boolean(selected && isRenderableSceneKind(selected.kind));
  for (const button of element('material-resources').querySelectorAll<HTMLButtonElement>('button[data-material-kind]')) {
    const material = button.dataset.materialKind as SceneMaterialKind | undefined;
    button.disabled = canApply === false;
    button.classList.toggle('is-active', Boolean(material && selected?.appearance?.material === material));
  }
}

function resourceButton(iconText: string, labelText: string, detailText: string, activate: () => void): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'resource-card';
  const icon = document.createElement('span'); icon.className = 'resource-icon'; icon.textContent = iconText;
  const label = document.createElement('strong'); label.textContent = labelText;
  const detail = document.createElement('small'); detail.textContent = detailText;
  button.append(icon, label, detail); button.addEventListener('click', activate); return button;
}

async function applyMaterial(material: SceneMaterialKind): Promise<void> {
  const entityId = selection.activeEntityId;
  if (!entityId) throw new Error('Select a geometry entity before applying a material.');
  await action(async () => {
    scene = await invoke<SceneSnapshot & JsonObject>('scene/material', { commandId: `command:material:${requestSequence + 1}`, baseRevision: documentRevision(), entityId, material });
    await refresh();
  });
}

function renderScriptResources(): void {
  const root = element('script-resources');
  root.replaceChildren();
  if (scripts.resources.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'resource-empty-label';
    empty.textContent = t('noScripts');
    root.append(empty);
    return;
  }
  for (const script of scripts.resources) {
    const entity = scene?.entities.find((candidate) => candidate.id === script.entityId);
    const cached = scriptDiagnosticsById.get(script.id);
    const diagnostics = cached?.textRevision === script.textRevision ? cached.diagnostics : null;
    const errors = diagnostics?.filter((item) => item.severity === 'error') ?? [];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `resource-card script-resource${errors.length ? ' has-errors' : diagnostics ? ' is-valid' : ''}`;
    const icon = document.createElement('span'); icon.className = 'resource-icon'; icon.textContent = '{}';
    const meta = document.createElement('span'); meta.className = 'resource-meta';
    const name = document.createElement('strong'); name.textContent = entity?.name ?? script.name ?? script.id;
    const revision = document.createElement('small'); revision.textContent = t('scriptRevision', { revision: script.textRevision });
    const validation = document.createElement('small'); validation.textContent = errors.length ? t('scriptErrors', { count: errors.length }) : diagnostics ? t('scriptValid') : t('scriptUnvalidated');
    meta.append(name, revision, validation); card.append(icon, meta);
    card.addEventListener('click', () => void action(async () => {
      await selectEntity(script.entityId, 'system');
    }));
    root.append(card);
  }
}

function updateFixAgentButton(): void {
  const button = element<HTMLButtonElement>('run-fix-agent');
  const repairAvailable = runScriptContext?.kind === 'missing-script'
    || runScriptContext?.diagnostics.some((item) => item.severity === 'error') === true;
  button.disabled = !repairAvailable || !conversationCanSend || !conversationBackendId;
  button.title = button.disabled && repairAvailable ? t('agentFixUnavailable') : t('fixWithAgent');
}

async function requestAgentScriptFix(): Promise<void> {
  const context = runScriptContext;
  const backendId = conversationBackendId;
  if (!context || !backendId || !conversationCanSend) { setStatus(t('agentFixUnavailable')); return; }
  const prompt = context.kind === 'missing-script'
    ? [
        'Restore the missing controller script for the current AIStudio game. Perform the edits with tools; do not only explain the fix and do not recreate working scene content.',
        `Project: ${context.projectName}`,
        `Current entities: ${JSON.stringify(context.entities)}`,
        'No script is committed. A prior script proposal may not have been approved or committed, so inspect authoritative project state and do not assume an old proposal is reusable.',
        'Required workflow: call project.snapshot; choose or create one empty controller entity; author the complete game controller as an onUpdate function body with entity, component, world, time, delta, and api already in scope; never use import, export, CommonJS, or lifecycle-function wrappers. Declare every required capability, call script.propose, inspect every diagnostic and keep correcting source or capabilities until there are no errors; only then call script.apply and request approval. Preserve the intended game and existing entities. Do not start preview until the committed script validates without errors.',
      ].join('\n')
    : [
        'Fix the committed AIStudio project script identified below. Perform the edits with tools; do not only explain the fix.',
        `Entity: ${context.entityName} (${context.entityId})`,
        `Script: ${context.scriptId}`,
        'Current validation errors:', context.diagnostics.filter((item) => item.severity === 'error').map((item) => `${item.code} ${item.line}:${item.column} ${item.message}`).join('\n'),
        'Required workflow: call project.snapshot and script.get; rewrite the script as an onUpdate function body with entity, component, world, time, delta, and api already in scope; never use import, export, CommonJS, or lifecycle-function wrappers. If the source uses api.scene, include scene in script.propose capabilities and reuse the returned capabilities for preview.validate; script.ts.2339 for api.scene means the scene capability is missing. Call script.propose, inspect every diagnostic and keep correcting source or capabilities until there are no errors; only then call script.apply. Do not start preview until the committed script validates without errors.',
      ].join('\n');
  conversationCanSend = false;
  updateFixAgentButton();
  element<HYDialog>('run-dialog').close('action');
  element<HYTabs>('right-tabs').value = 'agent';
  if (await dispatchConversation(Object.freeze({ type: 'conversation/send', backendId, prompt }))) setStatus('Script repair task sent to the Agent');
}

function render(): void {
  const hierarchy = element('hierarchy-items');
  hierarchy.replaceChildren();
  for (const entity of scene?.entities ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    const depth = Math.min(6, hierarchyDepth(entity, scene!));
    button.className = `entity depth-${depth}${entity.id === selection.activeEntityId ? ' active' : ''}`;
    button.textContent = `${isRenderableSceneKind(entity.kind) ? '◇' : isLightSceneKind(entity.kind) ? '☀' : '○'} ${entity.name}`;
    button.dataset.entityId = entity.id;
    button.addEventListener('click', () => void action(async () => {
      await selectEntity(entity.id, 'hierarchy');
    }));
    hierarchy.append(button);
  }
  const selected = scene?.entities.find((entity) => entity.id === selection.activeEntityId) ?? null;
  element('selection-label').textContent = selected ? selected.name : t('noSelection');
  setTransformInputs(selected?.transform ?? null);
  element<HTMLButtonElement>('apply-transform').disabled = !selected;
  renderProjectChrome();
  renderScriptResources();
  renderBuiltinResources(selected);
  element('viewport-empty-state').hidden = (scene?.entities.some((entity) => isRenderableSceneKind(entity.kind)) ?? false) || playing;
  renderScriptPanel(selected);
  if (scene && viewport && !playing) viewport.apply(scene, selection.activeEntityId);
}

function renderProjectChrome(): void {
  element<HTMLButtonElement>('undo').disabled = !project?.history.canUndo;
  element<HTMLButtonElement>('redo').disabled = !project?.history.canRedo;
  const saveButton = element<HTMLButtonElement>('save-project');
  saveButton.disabled = !project?.document;
  saveButton.textContent = `${t('saveProject')}${project?.document?.dirty ? ' •' : ''}`;
  saveButton.title = t(project?.document?.dirty ? 'unsavedChanges' : 'allChangesSaved');
  saveButton.setAttribute('aria-label', saveButton.title);
  updateRunButton();
  element('project-name').textContent = project?.document?.name ?? t('noProject');
  element('revision').textContent = t('revision', { document: project?.document?.revision ?? 0, scene: scene?.revision ?? 0 });
}

async function selectEntity(entityId: StableId | null, source: SelectionIntentSource): Promise<void> {
  const generation = ++selectionIntentGeneration;
  const previous = selection;
  selection = Object.freeze({ activeEntityId: entityId, source });
  renderSelection();
  try {
    const authoritative = await invoke<SelectionSnapshot & JsonObject>('scene/select', { entityId, source });
    if (generation !== selectionIntentGeneration) return;
    selection = authoritative;
    renderSelection();
  } catch (cause) {
    if (generation === selectionIntentGeneration) {
      selection = previous;
      renderSelection();
    }
    throw cause;
  }
}

function renderSelection(): void {
  const selected = scene?.entities.find((entity) => entity.id === selection.activeEntityId) ?? null;
  const hierarchy = element('hierarchy-items');
  for (const button of hierarchy.querySelectorAll<HTMLButtonElement>('button.entity')) {
    button.classList.toggle('active', button.dataset.entityId === selection.activeEntityId);
  }
  element('selection-label').textContent = selected ? selected.name : t('noSelection');
  setTransformInputs(selected?.transform ?? null);
  element<HTMLButtonElement>('apply-transform').disabled = selected === null;
  updateMaterialResources(selected);
  renderScriptPanel(selected);
  if (viewport && !playing) viewport.select(selection.activeEntityId);
}

function renderScriptPanel(
  selected: SceneEntitySnapshot | null,
  options: Readonly<{ preservePreviewDisclosure?: boolean }> = {},
): void {
  const script = selected ? scripts.resources.find((resource) => resource.entityId === selected.id) : undefined;
  const identity = `${selected?.id ?? ''}:${script?.textRevision ?? 0}`;
  if (identity !== loadedScriptIdentity) {
    loadedScriptIdentity = identity;
    element<HTMLTextAreaElement>('script-source').value = selected ? script?.text ?? DEMO_SCRIPT : '';
    pendingScriptProposal = null;
    if (!options.preservePreviewDisclosure) previewDisclosure = null;
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
  const enabledScripts = scripts.resources.filter((resource) => resource.enabled);
  if (!enabledScripts.length) throw new Error('Commit a valid script before Play.');
  if (!scene?.entities.some((entity) => isRenderableSceneKind(entity.kind))) {
    throw new Error('Preview scene has no renderable geometry. Create at least one primitive before Play.');
  }
  previewDisclosure = await invoke<PreviewDisclosure & JsonObject>('preview/prepare', {});
  element('preview-disclosure').textContent = `Risk: ${previewDisclosure.risk}. ${previewDisclosure.scripts.length} scripts. Capabilities: ${previewDisclosure.capabilities.join(', ')}.`;
  renderScriptPanel(scene?.entities.find((entity) => entity.id === previewDisclosure!.scripts[0]?.entityId) ?? null, { preservePreviewDisclosure: true });
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
  if (!sourceScene.entities.some((entity) => isRenderableSceneKind(entity.kind))) {
    throw new Error('Preview scene has no renderable geometry. Create at least one primitive before Play.');
  }
  const authoringCleanup = viewport?.dispose();
  viewport = null;
  showPlayPage();
  const primary = plan.scripts[0];
  if (!primary) throw new Error('Preview plan has no scripts.');
  const frame = new SandboxedPreviewFrame(primary.entityId);
  previewFrame = frame;
  const previewScene = Object.freeze({ ...sourceScene, camera: sourceScene.camera ?? currentProjectCamera() });
  try {
    await Promise.all([frame.start(previewScene, plan), authoringCleanup]);
  }
  catch (cause) {
    await frame.dispose();
    if (previewFrame === frame) previewFrame = null;
    await hidePlayPage();
    viewport = new WebGpuViewportRuntime(element<HTMLCanvasElement>('viewport'));
    await viewport.initialize();
    viewport.apply(sourceScene, selection.activeEntityId);
    throw cause;
  }
  playing = true;
  previewPaused = false;
  element('viewport-empty-state').hidden = true;
  document.body.dataset.preview = 'playing';
  element('preview-disclosure').textContent = `Playing isolated trusted-project preview with ${plan.capabilities.join(', ')}.`;
  renderScriptPanel(sourceScene.entities.find((entity) => entity.id === primary.entityId) ?? null);
  updatePlayControls();
  updateRunButton();
}

function currentProjectCamera(): ProjectCameraSnapshot {
  try { return project?.document ? projectCameraFromSettings(project.document.settings) : DEFAULT_PROJECT_CAMERA; }
  catch { return DEFAULT_PROJECT_CAMERA; }
}

function sameCamera(left: ProjectCameraSnapshot, right: ProjectCameraSnapshot): boolean {
  return left.projection === right.projection
    && left.distance === right.distance
    && left.azimuthDegrees === right.azimuthDegrees
    && left.elevationDegrees === right.elevationDegrees
    && left.fovDegrees === right.fovDegrees
    && left.orthographicSize === right.orthographicSize
    && left.near === right.near
    && left.far === right.far
    && left.target.x === right.target.x
    && left.target.y === right.target.y
    && left.target.z === right.target.z;
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
  previewPaused = false;
  document.body.dataset.preview = 'stopped';
  await hidePlayPage();
  viewport = new WebGpuViewportRuntime(element<HTMLCanvasElement>('viewport'));
  await viewport.initialize();
  document.body.dataset.smokeStage = 'authoring-viewport-restored';
  if (scene) viewport.apply(scene, selection.activeEntityId);
  element('viewport-empty-state').hidden = scene?.entities.some((entity) => isRenderableSceneKind(entity.kind)) ?? false;
  element('preview-disclosure').textContent = 'Preview stopped; authoring Scene restored.';
  renderScriptPanel(scene?.entities.find((entity) => entity.id === selection.activeEntityId) ?? null);
  updateRunButton();
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
  await selectEntity(picked, 'viewport');
  await refresh();
  scene = await invoke<SceneSnapshot & JsonObject>('scene/transform', {
    commandId: 'command:smoke-transform-cube', baseRevision: documentRevision(), entityId: picked,
    transform: { position: { x: 0.4, y: 0.2, z: 0 }, rotationDegrees: { x: 0, y: 30, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  });
  project = await invoke<ProjectSnapshot & JsonObject>('project/snapshot');
  await invoke('history/undo', { baseRevision: documentRevision() });
  project = await invoke<ProjectSnapshot & JsonObject>('project/snapshot');
  await invoke('history/redo', { baseRevision: documentRevision() });
  project = await invoke<ProjectSnapshot & JsonObject>('project/snapshot');
  scene = await invoke<SceneSnapshot & JsonObject>('scene/material', {
    commandId: 'command:smoke-material-blinn-phong', baseRevision: documentRevision(), entityId: picked, material: 'blinn-phong',
  });
  await invoke('project/save');
  await invoke('project/reopen');
  await refresh();
  if (!scene.entities.some((entity) => entity.id === picked && entity.transform.position.x === 0.4)) throw new Error('Saved scene did not survive reopen.');
  if (!scene.entities.some((entity) => entity.id === picked && entity.appearance?.material === 'blinn-phong')) throw new Error('Blinn-Phong material did not survive reopen.');
  await viewport!.exerciseDeviceLoss();
  document.body.dataset.smokeStage = 'device-recovered';
  render();
  const smokePreviewSource = `${DEMO_SCRIPT}\nconst smokeInstances = api.scene.instances('${picked}', 4);\nsmokeInstances.setCount(1);\nsmokeInstances.set(0, { position: { x: 0, y: 0, z: 0 } });`;
  const scriptProposal = await invoke<ScriptProposal & JsonObject>('script/propose', {
    entityId: picked, text: smokePreviewSource, baseRevision: documentRevision(), capabilities: ['read', 'input', 'debug', 'scene'],
  });
  document.body.dataset.smokeStage = 'script-proposed';
  if (scriptProposal.diagnostics.some((item) => item.severity === 'error')) throw new Error(`Smoke script validation failed: ${JSON.stringify(scriptProposal.diagnostics)}`);
  await invoke('script/commit', { proposalId: scriptProposal.id, commandId: 'command:smoke-script-edit' });
  await refresh();
  const smokeScript = scripts.resources.find((resource) => resource.entityId === picked);
  if (!smokeScript) throw new Error('Smoke script did not commit.');
  const disclosure = await invoke<PreviewDisclosure & JsonObject>('preview/prepare', {});
  const grant = await invoke<PreviewGrant & JsonObject>('preview/authorize', { planId: disclosure.id, approved: true });
  const previewPlan = await invoke<ConsumedPreviewPlan & JsonObject>('preview/consume', { grantId: grant.id });
  await startPreview(previewPlan);
  document.body.dataset.smokeStage = 'preview-playing';
  if (element('play-page').hidden || !document.querySelector('#play-device-screen > #preview-frame')) throw new Error('Preview did not switch to the standalone play page.');
  applyPlayDevicePreset('iphone-15-pro');
  if (element('play-device-shell').style.width !== '393px' || element('play-device-shell').style.height !== '852px') throw new Error('Phone viewport simulation did not apply logical dimensions.');
  const simulatedFrame = document.querySelector<HTMLIFrameElement>('#play-device-screen > #preview-frame');
  if (simulatedFrame?.clientWidth !== 393 || simulatedFrame.clientHeight !== 852) throw new Error(`Preview iframe size mismatch: ${simulatedFrame?.clientWidth}x${simulatedFrame?.clientHeight}`);
  let moved = false;
  for (let frame = 0; frame < 30 && !moved; frame += 1) {
    await nextFrames(1);
    const position = previewFrame!.latestPosition();
    moved = Boolean(position && Math.abs(position.x - 0.4) > 0.05);
  }
  if (!moved) throw new Error('Trusted preview script did not visibly move the Cube.');
  await togglePreviewPause();
  const pausedPosition = previewFrame!.latestPosition();
  await nextFrames(3);
  if (!previewPaused || previewFrame!.latestPosition()?.x !== pausedPosition?.x) throw new Error('Standalone preview did not remain stable while paused.');
  await togglePreviewPause();
  let resumed = false;
  for (let frame = 0; frame < 30 && !resumed; frame += 1) {
    await nextFrames(1);
    resumed = previewFrame!.latestPosition()?.x !== pausedPosition?.x;
  }
  if (!resumed) throw new Error('Standalone preview did not resume.');
  previewFrame!.hotReload(smokeScript.id, `if (!component.bound) { component.bound = true; api.debug.setInterval(() => {}, 1000); }`);
  await nextFrames(2);
  document.body.dataset.smokeStage = 'preview-hot-reloaded';
  if (previewFrame!.ownedDisposableCount() !== 1) throw new Error('Preview timer was not owned by ScriptExecutionScope.');
  previewFrame!.hotReload(smokeScript.id, `throw new Error('injected preview fault');`);
  await nextFrames(2);
  document.body.dataset.smokeStage = 'preview-fault-observed';
  if (previewFrame!.runtimeErrorCount() === 0 || previewFrame!.ownedDisposableCount() !== 0) throw new Error('Preview fault/cleanup evidence is missing.');
  await stopPreview();
  document.body.dataset.smokeStage = 'preview-stopped';
  if (scene.entities.find((entity) => entity.id === picked)?.transform.position.x !== 0.4) throw new Error('Preview mutation leaked into the edit document.');
  document.body.dataset.workflow = 'create-pick-transform-undo-redo-save-reopen';
  document.body.dataset.webgpu = 'ready';
  document.body.dataset.deviceRecovery = 'ready';
  document.body.dataset.scriptWorkflow = 'proposal-commit-approve-standalone-play-pause-resume-device-hot-reload-fault-stop-isolated';
  await nextFrames(2);
}

async function reportViewport(event: 'ready' | 'rendered' | 'device-lost' | 'failed' | 'picking-failed', message: string, sceneRevision: number, entityId?: StableId | null): Promise<void> {
  await invoke('viewport/report', entityId ? { event, message, sceneRevision, entityId } : { event, message, sceneRevision });
}

async function reportPreview(event: 'started' | 'stopped' | 'paused' | 'resumed' | 'hot-reloaded' | 'runtime-error' | 'cleanup-complete', message: string, disposableCount: number, previewId?: StableId | null, entityId?: StableId | null): Promise<void> {
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
  'Saving project…': 'saving',
  'Project saved': 'projectSaved',
  'Preparing isolated preview…': 'preparingRun',
  'Project is running': 'previewRunning',
  'Project stopped': 'previewStopped',
  'Script validation failed': 'scriptValidationFailed',
  'Script repair task sent to the Agent': 'fixRequestSent',
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

function isJsonObject(value: unknown): value is JsonObject {
  const json = (item: unknown): boolean => item === null || typeof item === 'string' || typeof item === 'boolean'
    || (typeof item === 'number' && Number.isFinite(item)) || (Array.isArray(item) && item.every(json))
    || (Boolean(item) && typeof item === 'object' && !Array.isArray(item) && Object.values(item as Record<string, unknown>).every(json));
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && json(value);
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

void boot().catch((cause) => {
  document.body.dataset.status = 'error';
  document.body.dataset.startupStage = 'failed';
  const message = errorMessage(cause);
  try { setStatus(message); } catch { /* The external startup guard owns the minimal fallback UI. */ }
  window.dispatchEvent(new CustomEvent('haiyue-startup-failed', { detail: message }));
});
