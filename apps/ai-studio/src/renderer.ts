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
import { defineSplitComponents, type GESplit, type GESplitRatioChangeDetail } from '@haiyue/ui';

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
}
interface SelectionSnapshot { readonly activeEntityId: StableId | null; readonly source: string; }
interface ScriptResourceSnapshot { readonly id: StableId; readonly entityId: StableId; readonly text: string; readonly textRevision: number; readonly dirty: boolean; }
interface ScriptCatalogSnapshot { readonly documentRevision: number; readonly resources: readonly ScriptResourceSnapshot[]; }
interface ScriptProposal { readonly id: StableId; readonly diagnostics: readonly ScriptDiagnostic[]; readonly addedLines: number; readonly removedLines: number; }
interface ScriptDiagnostic { readonly code: string; readonly severity: 'error' | 'warning'; readonly line: number; readonly column: number; readonly message: string; }
interface PreviewDisclosure { readonly id: StableId; readonly scriptId: StableId; readonly entityId: StableId; readonly capabilities: readonly ScriptCapabilityName[]; readonly risk: 'trusted-project'; readonly diagnostics: readonly ScriptDiagnostic[]; }
interface PreviewGrant { readonly id: StableId; }
interface ConsumedPreviewPlan extends PreviewDisclosure { readonly emittedText: string; }
interface AgentPreviewCommandReadModel { readonly pending: boolean; readonly command?: Readonly<{ id: StableId; kind: 'start' | 'stop'; plan?: ConsumedPreviewPlan }> }
interface LogViewerResult { readonly events: readonly SafeLogSummary[]; readonly nextCursor?: string; readonly status: Readonly<{ health: string; canPersist: boolean }> }

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
let agentPoll: AgentPollScheduler | null = null;
let disposeConversationChanged: (() => void) | null = null;
let handledPreviewCommand: StableId | null = null;
const DEMO_SCRIPT = `const transform = entity.getComponent('CartesianTransform3D') as unknown as { setPosition(x: number, y: number, z: number): unknown } | null;\ntransform?.setPosition(0.4 + Math.sin(time / 500) * 0.8, 0.2, 0);`;
const SPLIT_LAYOUT_STORAGE_PREFIX = 'haiyue.ai-studio.split.';

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
    this.frame.src = 'haiyue-preview://app/preview.html';
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
  window.addEventListener('beforeunload', () => {
    agentPoll?.stop(); agentPoll = null;
    disposeConversationChanged?.(); disposeConversationChanged = null;
    viewport?.dispose(); void previewFrame?.dispose();
  }, { once: true });
}

async function pollAgent(): Promise<void> {
  await Promise.all([refreshConversation(false), processAgentPreviewCommand()]);
}

async function refreshConversation(force: boolean): Promise<void> {
  const replay = await invoke<ConversationReplaySnapshot & JsonObject>('conversation/replay');
  if (!force && replay.revision === conversationRevision) return;
  conversationRevision = replay.revision;
  const snapshot = conversationProjector.reset(replay);
  renderChatPanel(element('chat-content'), presentChatPanel(snapshot), (intent) => void dispatchConversation(intent));
  document.body.dataset.agentUi = 'ready';
  document.body.dataset.agentBackend = snapshot.backendId ?? 'none';
  document.body.dataset.agentBackendState = snapshot.backends.find((item) => item.id === snapshot.backendId)?.state ?? 'unavailable';
}

async function dispatchConversation(intent: ConversationIntent): Promise<void> {
  try {
    setStatus('Agent intent pending…');
    await invoke('conversation/intent', { intent: intent as unknown as JsonObject });
    setStatus('Agent intent accepted');
  } catch (cause) { setStatus(errorMessage(cause)); }
  finally { agentPoll?.trigger(); }
}

function defaultLogQuery(): LogQueryIntent {
  return Object.freeze({ limit: 80, traverseCorrelation: false });
}

async function refreshLogs(): Promise<void> {
  const result = await invoke<LogViewerResult & JsonObject>('logs/query', { query: defaultLogQuery() as unknown as JsonObject });
  const list = element('log-items');
  list.replaceChildren();
  for (const event of result.events) {
    const row = document.createElement('li');
    row.className = `log-row severity-${event.severity}`;
    row.textContent = `#${event.sequence} ${event.severity} ${event.kind} · ${event.source}`;
    row.title = `${event.timestamp} · ${event.payloadDigest}`;
    list.append(row);
  }
  element('log-health').textContent = `${result.status.health} · ${result.events.length} safe summaries`;
}

async function exportBugBundle(): Promise<void> {
  const result = await invoke<JsonObject>('logs/export', { query: defaultLogQuery() as unknown as JsonObject });
  element('log-health').textContent = `Bug bundle exported · ${String(result.contentDigest ?? '')}`;
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
      await startPreview(command.plan);
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
    entityId: playing ? selection.activeEntityId : null,
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
  element('selection-label').textContent = selected ? selected.name : 'No entity selected';
  setTransformInputs(selected?.transform ?? null);
  element<HTMLButtonElement>('apply-transform').disabled = !selected;
  element<HTMLButtonElement>('undo').disabled = !project?.history.canUndo;
  element<HTMLButtonElement>('redo').disabled = !project?.history.canRedo;
  element('project-name').textContent = project?.document?.name ?? 'No project';
  element('revision').textContent = `Document r${project?.document?.revision ?? 0} · Scene r${scene?.revision ?? 0}`;
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

async function startPreview(plan: ConsumedPreviewPlan): Promise<void> {
  if (!scene) throw new Error('No scene is available for preview.');
  viewport?.dispose();
  viewport = null;
  const frame = new SandboxedPreviewFrame(plan.entityId);
  previewFrame = frame;
  try { await frame.start(scene, plan); }
  catch (cause) {
    await frame.dispose();
    if (previewFrame === frame) previewFrame = null;
    viewport = new WebGpuViewportRuntime(element<HTMLCanvasElement>('viewport'));
    await viewport.initialize();
    viewport.apply(scene, selection.activeEntityId);
    throw cause;
  }
  playing = true;
  document.body.dataset.preview = 'playing';
  element('preview-disclosure').textContent = `Playing isolated trusted-project preview with ${plan.capabilities.join(', ')}.`;
  renderScriptPanel(scene.entities.find((entity) => entity.id === plan.entityId) ?? null);
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

function setStatus(message: string): void { element('status').textContent = message; }
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
