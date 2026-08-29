import { CartesianTransform3D, Entity, HaiyueEngine, Mesh3D, type Scene } from '@haiyue/engine';
import { Camera3D, InstancedMesh3D, Interactive, SCRIPT_CAPABILITIES, ScriptComponent, ScriptResource, type ScriptCapabilityName, type ScriptRuntimeApi, type ScriptRuntimeContext, type ScriptRuntimeErrorEvent } from '@haiyue/engine/components';
import { InstancedMaterial, InstancedPbrMaterial } from '@haiyue/engine/material';
import { createInteractionRaycastResult, InstancedMesh3DRenderSystem, InteractionSystem, type InteractionRaycastResult } from '@haiyue/engine/systems';
import { InputActionMap, type InputActionMapDescriptor, type InputReplayV1, type ReplayInputEventInput, type ReplayInputSnapshot, type SimulationStateValue } from '@haiyue/engine/experimental/simulation';
import { applyProjectCamera, applyProjectCameraProjection, DEFAULT_PROJECT_CAMERA, normalizeProjectCamera, type ProjectCameraSnapshot } from '@haiyue/ai-studio-editor-plugins/camera-authoring';
import type { SceneEntityKind, SceneMaterialKind } from '@haiyue/ai-studio-editor-plugins';
import { attachSceneEntityVisuals, installSceneEntityMaterialRenderers, isRenderableSceneKind } from './scene-entity-rendering.js';
import { PlaySimulation } from './play-simulation.js';
import { PhysicsPlayRuntime } from './physics-play-runtime.js';
import { RenderEffectsPlayRuntime } from '@haiyue/ai-studio-script-preview/effects';
import { createEquirectangularReflectionMap } from '@haiyue/engine/lighting';

interface Vec3 { readonly x: number; readonly y: number; readonly z: number; }
interface SceneEntity {
  readonly id: string; readonly name: string; readonly kind: SceneEntityKind; readonly parentId: string | null;
  readonly transform: Readonly<{ position: Vec3; rotationDegrees: Vec3; scale: Vec3 }>;
  readonly components?: readonly SceneComponent[];
  readonly appearance?: Readonly<{ material: SceneMaterialKind; color: readonly [number, number, number, number] }>;
  readonly light?: Readonly<{ color: readonly [number, number, number]; intensity: number; range?: number; direction?: readonly [number, number, number]; castShadow?: boolean }>;
}
interface SceneSnapshot { readonly documentId: string; readonly revision: number; readonly entities: readonly SceneEntity[]; readonly camera?: ProjectCameraSnapshot; }
interface PreviewScriptPlan { readonly scriptId: string; readonly entityId: string; readonly order: number; readonly textRevision: number; readonly digest: string; readonly emittedText: string; readonly capabilities: readonly ScriptCapabilityName[]; readonly diagnostics: readonly unknown[]; }
interface PreviewPlan {
  readonly id: string; readonly documentId: string; readonly documentRevision: number;
  readonly selection: 'all-enabled' | 'explicit'; readonly scriptSetDigest: string;
  readonly scripts: readonly PreviewScriptPlan[]; readonly capabilities: readonly ScriptCapabilityName[];
  readonly runtimeConfig: Readonly<{ schemaVersion: 1; mode: 'fixed-step'; tickRateHz: number; maxSubSteps: number; seed: string }>;
  readonly risk: 'trusted-project'; readonly diagnostics: readonly unknown[];
}
interface ScriptOwner { readonly plan: PreviewScriptPlan; readonly resource: ScriptResource; readonly component: ScriptComponent; readonly entity: Entity; }
interface PreviewAsset { readonly id: string; readonly kind: 'texture' | 'model' | 'audio' | 'animation'; readonly mimeType: string; readonly byteLength: number; readonly url?: string; readonly source?: string; }

let engine: HaiyueEngine | null = null;
let scene: Scene | null = null;
const scriptOwners: ScriptOwner[] = [];
const planByComponent = new Map<ScriptComponent, PreviewScriptPlan>();
let target: Entity | null = null;
let resizeObserver: ResizeObserver | null = null;
let activeCamera: ProjectCameraSnapshot | null = null;
let simulation: PlaySimulation | null = null;
let activeInput: ReplayInputSnapshot | null = null;
let animationFrame: number | null = null;
let previousFrameTime: number | null = null;
let removeInputListeners: (() => void) | null = null;
let pollGamepadInput: (() => void) | null = null;
let gameplayCamera: GameplayCameraRuntime | null = null;
let activeSceneEntities: readonly SceneEntity[] | null = null;
let interactionSystem: InteractionSystem | null = null;
let physicsRuntime: PhysicsPlayRuntime | null = null;
let physicsLoadController: AbortController | null = null;
let renderEffectsRuntime: RenderEffectsPlayRuntime | null = null;
let interactionRaycast: InteractionRaycastResult = createInteractionRaycastResult();
let interactionEvents: readonly StudioInteractionEvent[] = Object.freeze([]);
let hoveredEntityId: string | null = null;
const pointerDownTargets = new Map<number, string>();
const instanceSets = new Map<number, StudioInstanceSet>();
const entitiesByStableId = new Map<string, Entity>();
const stableIdByEntityId = new Map<number, string>();
let disposed = false;
let paused = false;
let lifecycleGeneration = 0;

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== parent || !isRecord(event.data) || event.data.protocol !== 'haiyue-preview/1') return;
  if (event.data.type === 'start') {
    const request = parseStartRequest(event.data);
    if (!request) { fail(new Error('Preview start request failed schema validation.')); return; }
    const generation = ++lifecycleGeneration;
    void start(request.scene, request.plan, request.assets, generation).catch((cause) => {
      if (generation !== lifecycleGeneration) return;
      stop('start-failed'); fail(cause);
    });
  } else if (event.data.type === 'hot-reload' && exactKeys(event.data, ['protocol', 'type', 'scriptId', 'emittedText'])
    && typeof event.data.scriptId === 'string' && typeof event.data.emittedText === 'string' && event.data.emittedText.length <= 250_000) {
    try {
      const scriptId = event.data.scriptId;
      const owner = scriptOwners.find((candidate) => candidate.plan.scriptId === scriptId);
      if (!owner) throw new Error(`Preview script ${scriptId} is not playing.`);
      owner.resource.setScript('onUpdate', event.data.emittedText);
      send('hot-reloaded', { scriptId: owner.plan.scriptId, entityId: owner.plan.entityId, disposableCount: totalDisposableCount() });
    } catch (cause) { fail(cause); }
  } else if (event.data.type === 'pause' && exactKeys(event.data, ['protocol', 'type'])) pause();
  else if (event.data.type === 'resume' && exactKeys(event.data, ['protocol', 'type'])) resume();
  else if (event.data.type === 'step' && exactKeys(event.data, ['protocol', 'type', 'count']) && Number.isSafeInteger(event.data.count) && Number(event.data.count) >= 1 && Number(event.data.count) <= 10_000) step(Number(event.data.count));
  else if (event.data.type === 'input' && exactKeys(event.data, ['protocol', 'type', 'event']) && isRecord(event.data.event)) injectInput(event.data.event as unknown as ReplayInputEventInput);
  else if (event.data.type === 'replay' && exactKeys(event.data, ['protocol', 'type', 'replay']) && isRecord(event.data.replay)) loadReplay(event.data.replay as unknown as InputReplayV1);
  else if (event.data.type === 'inspect' && exactKeys(event.data, ['protocol', 'type'])) publishInspection();
  else if (event.data.type === 'stop' && exactKeys(event.data, ['protocol', 'type'])) stop('parent-request');
});

async function start(snapshot: SceneSnapshot, plan: PreviewPlan, assets: readonly PreviewAsset[], generation: number): Promise<void> {
  if (engine) stop('restart', false);
  if (snapshot.documentId !== plan.documentId || snapshot.revision !== plan.documentRevision) throw new Error('Preview plan does not match the Scene document revision.');
  if (!snapshot.entities.some((item) => isRenderableSceneKind(item.kind))) throw new Error('Preview scene has no renderable geometry. Create at least one primitive before Play.');
  const canvas = document.querySelector<HTMLCanvasElement>('#preview-canvas');
  if (!canvas) throw new Error('Preview canvas is missing.');
  const renderProfile = RenderEffectsPlayRuntime.engineProfile(snapshot.entities);
  const devicePixelRatio = boundedDevicePixelRatio(canvas, renderProfile.devicePixelRatio, renderProfile.maxRenderPixels);
  const ownedEngine = new HaiyueEngine({ canvas, renderProfile: renderProfile.renderProfile, msaaSamples: renderProfile.msaaSamples, clearColor: renderProfile.clearColor, devicePixelRatio, recoverDeviceLost: true });
  engine = ownedEngine;
  activeSceneEntities = snapshot.entities;
  paused = false;
  await ownedEngine.init();
  if (disposed || generation !== lifecycleGeneration || engine !== ownedEngine) { ownedEngine.destroy(); return; }
  const ownedScene = ownedEngine.createScene({ name: 'Trusted Project Preview', render3D: true });
  scene = ownedScene;
  activeCamera = snapshot.camera ?? DEFAULT_PROJECT_CAMERA;
  applyProjectCamera(ownedScene, activeCamera, canvasAspect(canvas));
  const entities = new Map<string, Entity>();
  for (const item of snapshot.entities) {
    const entity = new Entity(item.name);
    entity.addComponent(new CartesianTransform3D({ position: tuple(item.transform.position), rotation: radians(item.transform.rotationDegrees), scale: tuple(item.transform.scale) }));
    attachSceneEntityVisuals(entity, item);
    const pointerInteraction = item.components?.find((candidate) => candidate.type === 'haiyue.interaction.pointer' && candidate.enabled);
    if (pointerInteraction) entity.addComponent(new Interactive({ penetrable: pointerInteraction.value.penetrable === true }));
    entities.set(item.id, entity);
    entitiesByStableId.set(item.id, entity);
    stableIdByEntityId.set(entity.id, item.id);
  }
  for (const item of snapshot.entities) { const entity = entities.get(item.id)!; if (item.parentId) entities.get(item.parentId)?.addChild(entity); else ownedScene.add(entity); }
  gameplayCamera = configureGameplayCamera(snapshot.entities, ownedScene, canvas);
  if (gameplayCamera) activeCamera = null;
  installSceneEntityMaterialRenderers(ownedEngine, ownedScene);
  ownedScene.addSystem(new InstancedMesh3DRenderSystem(ownedEngine, ownedScene.activeCameraEntity, { loadOp: 'load' }));
  interactionSystem = new InteractionSystem(ownedEngine, ownedScene.activeCameraEntity, { bindCanvas: false, continuousHover: false });
  ownedScene.addSystem(interactionSystem, false);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  renderEffectsRuntime = await RenderEffectsPlayRuntime.create({
    engine: ownedEngine, scene: ownedScene, sceneEntities: snapshot.entities, entitiesByStableId,
    resolveTextureAsset: async (assetId) => {
      const asset = requirePreviewAsset(assetsById, assetId, 'texture');
      if (!asset.url) throw new Error(`texture.asset-payload-invalid: ${assetId} has no controlled URL.`);
      return Object.freeze({ texture: asset.url, release() {} });
    },
    resolveModelAsset: async (assetId) => {
      const asset = requirePreviewAsset(assetsById, assetId, 'model');
      if (!asset.url) throw new Error(`model.asset-payload-invalid: ${assetId} has no controlled URL.`);
      return Object.freeze({ url: asset.url, release() {} });
    },
    resolveAudioAsset: async (assetId) => {
      const asset = requirePreviewAsset(assetsById, assetId, 'audio');
      if (!asset.url) throw new Error(`audio.asset-payload-invalid: ${assetId} has no controlled URL.`);
      return Object.freeze({ url: asset.url, release() {} });
    },
    resolveAnimationAsset: async (assetId) => {
      const asset = requirePreviewAsset(assetsById, assetId, 'animation');
      if (!asset.source) throw new Error(`animation.asset-payload-invalid: ${assetId} has no controlled source.`);
      let source: unknown;
      try { source = JSON.parse(asset.source); } catch { throw new Error(`animation.asset-json-invalid: ${assetId} is not valid JSON.`); }
      if (!isRecord(source)) throw new Error(`animation.asset-json-invalid: ${assetId} must contain an object.`);
      return Object.freeze({ source: source as never, release() {} });
    },
    resolveEnvironmentAsset: async (assetId, signal) => {
      const asset = requirePreviewAsset(assetsById, assetId, 'texture');
      if (!asset.url) throw new Error(`environment.asset-payload-invalid: ${assetId} has no controlled URL.`);
      if (asset.mimeType === 'image/ktx2') {
        const manager = ownedEngine.assetManager;
        if (!manager) throw new Error('environment.asset-manager-unavailable: Engine AssetManager is unavailable.');
        const handle = await manager.loadTexture({ kind: 'compressed-texture', type: 'texture/ktx2', src: asset.url }, { cacheKey: asset.id, signal });
        return Object.freeze({ texture: handle.value, release: () => handle.release() });
      }
      const response = await fetch(asset.url, { signal });
      if (!response.ok) throw new Error(`environment.asset-fetch-failed: ${assetId} returned ${response.status}.`);
      const bitmap = await createImageBitmap(await response.blob());
      try {
        const texture = await createEquirectangularReflectionMap(ownedEngine.device, bitmap, { label: asset.id, signal });
        return Object.freeze({ texture, release: () => texture.destroy() });
      } finally { bitmap.close(); }
    },
  });
  target = entities.get(plan.scripts[0]!.entityId) ?? null;
  if (!target) throw new Error(`Preview target ${plan.scripts[0]!.entityId} is missing.`);
  const persistedSettings = readSimulationSettings(snapshot.entities);
  const settings = plan.runtimeConfig;
  if (persistedSettings.tickRateHz !== settings.tickRateHz || persistedSettings.maxSubSteps !== settings.maxSubSteps || persistedSettings.seed !== settings.seed) {
    throw new Error('Authorized fixed-step runtime settings no longer match the Scene.');
  }
  physicsLoadController = new AbortController();
  const ownedPhysics = await PhysicsPlayRuntime.create({
    world: ownedScene.world,
    sceneEntities: snapshot.entities,
    entitiesByStableId,
    stableIdByEntityId,
    tickRateHz: settings.tickRateHz,
    signal: physicsLoadController.signal,
  });
  if (disposed || generation !== lifecycleGeneration || engine !== ownedEngine) { ownedPhysics.dispose(); return; }
  physicsRuntime = ownedPhysics;
  const actionMap = readInputActionMap(snapshot.entities);
  ScriptComponent.setRuntimeApiFactory((base, context) => studioRuntimeApi(base, context, planByComponent.get(context.component)?.capabilities ?? Object.freeze([])));
  ScriptComponent.enableTrustedProject({ capabilities: plan.capabilities, errorPolicy: 'disable-script', onError: runtimeError });
  for (const script of plan.scripts) {
    const entity = entities.get(script.entityId);
    if (!entity) throw new Error(`Preview entity ${script.entityId} is missing.`);
    const resource = new ScriptResource({ name: script.scriptId, sourcePath: `scripts/${script.scriptId}.ts`, scripts: { onUpdate: script.emittedText } });
    const component = new ScriptComponent({}, resource);
    planByComponent.set(component, script);
    entity.addComponent(component);
    scriptOwners.push(Object.freeze({ plan: script, resource, component, entity }));
  }
  ownedEngine.switchScene(ownedScene);
  resizeObserver = new ResizeObserver(() => {
    ownedEngine.resizeToDisplaySize();
    if (activeCamera && scene === ownedScene) applyProjectCameraProjection(ownedScene, activeCamera, canvasAspect(canvas));
    else if (gameplayCamera && scene === ownedScene) resizeGameplayCamera(gameplayCamera, ownedScene, canvas);
  });
  resizeObserver.observe(canvas);
  ownedEngine.resizeToDisplaySize(true);
  simulation = new PlaySimulation({
    tickRateHz: settings.tickRateHz,
    maxSubSteps: settings.maxSubSteps,
    seed: settings.seed,
    onTick: (step, input) => {
      activeInput = input;
      renderEffectsRuntime?.beforeTick(step.tick);
      physicsRuntime?.beforeTick(input, step.deltaMs);
      updateGameplayCamera(step.deltaMs);
      updateInteractions(input);
      ownedEngine.updateActiveScene(step.timeMs, step.deltaMs);
      physicsRuntime?.afterTick(step.tick);
      publishState();
    },
    readState: readSimulationState,
  });
  removeInputListeners = installInput(canvas, actionMap);
  previousFrameTime = null;
  animationFrame = requestAnimationFrame(displayFrame);
  send('started', { entityId: plan.scripts[0]!.entityId, scriptSetDigest: plan.scriptSetDigest, scriptCount: plan.scripts.length, tickRateHz: settings.tickRateHz, seed: settings.seed, physics: physicsRuntime.status(), renderEffects: renderEffectsRuntime.manifest(), disposableCount: 0 });
}

function beginManualRenderFrame(ownedEngine: HaiyueEngine): void {
  // Fixed-step Play drives World updates itself instead of using Engine.run().
  // Invalidate the presented swap-chain view before every submitted render.
  (ownedEngine.renderTarget as typeof ownedEngine.renderTarget & Readonly<{ beginFrame(): void }>).beginFrame();
}

function publishState(): void {
  const transform = target?.getComponent(CartesianTransform3D);
  if (!transform) return;
  send('state', { tick: simulation?.clock.tick ?? 0, inputHash: activeInput?.hash ?? null, position: { x: transform.position[0], y: transform.position[1], z: transform.position[2] }, disposableCount: totalDisposableCount(), scripts: scriptRuntimeStates() });
}

function runtimeError(event: ScriptRuntimeErrorEvent): void {
  const plan = planByComponent.get(event.component);
  send('runtime-error', { scriptId: plan?.scriptId ?? null, entityId: plan?.entityId ?? null, code: event.error.code, message: event.error.message, line: event.sourceLocation.line, column: event.sourceLocation.column, disposableCount: totalDisposableCount() });
}
interface SceneComponent { readonly id: string; readonly type: string; readonly version: string; readonly enabled: boolean; readonly value: Readonly<Record<string, unknown>>; }
interface GameplayCameraRuntime { readonly entity: Entity; readonly component: Camera3D; readonly descriptor: SceneComponent; readonly follow?: SceneComponent; }
interface StudioInteractionEvent { readonly tick: number; readonly type: 'hover' | 'click' | 'move' | 'down' | 'up' | 'drag' | 'wheel' | 'cancel'; readonly entityId: string; readonly pointerId: number; readonly distance: number; readonly point: readonly number[]; readonly normal: readonly number[]; }

function pause(): void {
  if (!engine) { fail(new Error('Preview is not playing.')); return; }
  if (!paused) { simulation?.pause(); paused = true; }
  send('paused', { tick: simulation?.clock.tick ?? 0, disposableCount: totalDisposableCount() });
}

function resume(): void {
  if (!engine) { fail(new Error('Preview is not playing.')); return; }
  if (paused) { simulation?.resume(); previousFrameTime = null; paused = false; }
  send('resumed', { tick: simulation?.clock.tick ?? 0, disposableCount: totalDisposableCount() });
}

function displayFrame(timestamp: number): void {
  if (!engine || !simulation) return;
  pollGamepadInput?.();
  const deltaMs = previousFrameTime === null ? 0 : Math.max(0, timestamp - previousFrameTime);
  previousFrameTime = timestamp;
  try {
    beginManualRenderFrame(engine);
    simulation.advanceDisplayFrame(deltaMs);
  }
  catch (cause) { stop('simulation-failed'); fail(cause); return; }
  animationFrame = requestAnimationFrame(displayFrame);
}

function step(count: number): void {
  if (!simulation || !engine) { fail(new Error('Preview is not playing.')); return; }
  if (!paused) { fail(new Error('Preview must be paused before stepping.')); return; }
  try { beginManualRenderFrame(engine); simulation.step(count); send('stepped', { count, tick: simulation.clock.tick, disposableCount: totalDisposableCount() }); }
  catch (cause) { fail(cause); }
}

function injectInput(event: ReplayInputEventInput): void {
  if (!simulation) { fail(new Error('Preview is not playing.')); return; }
  try { simulation.inject(event); }
  catch (cause) { fail(cause); }
}

function loadReplay(replay: InputReplayV1): void {
  if (!simulation) { fail(new Error('Preview is not playing.')); return; }
  try { simulation.loadReplay(replay); activeInput = simulation.input.snapshot(); previousFrameTime = null; send('replay-loaded', { eventCount: replay.events.length, tick: 0 }); }
  catch (cause) { fail(cause); }
}

function publishInspection(): void {
  if (!simulation) { fail(new Error('Preview is not playing.')); return; }
  const snapshot = simulation.snapshot();
  send('inspection', { tick: snapshot.tick, timeMs: snapshot.timeMs, paused: snapshot.paused, seed: snapshot.seed, input: snapshot.input, trace: snapshot.trace, physics: physicsRuntime?.status() ?? null, physicsEvents: physicsRuntime?.events() ?? [], renderEffects: renderEffectsRuntime?.manifest() ?? null });
}

function readSimulationState(): SimulationStateValue {
  return Object.freeze({
    tick: simulation?.clock.tick ?? 0,
    entities: Object.freeze([...entitiesByStableId].sort((left, right) => left[0].localeCompare(right[0])).map(([id, entity]) => {
      const transform = entity.getComponent(CartesianTransform3D);
      return Object.freeze({ id, position: transform ? Object.freeze([...transform.position]) : null, rotation: transform ? Object.freeze([...transform.rotation]) : null, scale: transform ? Object.freeze([...transform.scale]) : null });
    })),
    physics: physicsRuntime?.state() ?? null,
    renderEffects: (renderEffectsRuntime?.manifest() ?? null) as unknown as SimulationStateValue,
  });
}

function readSimulationSettings(entities: readonly SceneEntity[]): Readonly<{ tickRateHz: number; maxSubSteps: number; seed: string }> {
  const value = findEnabledComponent(entities, 'haiyue.simulation.settings')?.value;
  return Object.freeze({
    tickRateHz: finiteNumber(value?.tickRateHz, 1, 240, 60),
    maxSubSteps: integerNumber(value?.maxSubSteps, 1, 10_000, 1_000),
    seed: typeof value?.seed === 'string' && value.seed.length >= 1 && value.seed.length <= 256 ? value.seed : 'haiyue-play',
  });
}

function readInputActionMap(entities: readonly SceneEntity[]): InputActionMap {
  const value = findEnabledComponent(entities, 'haiyue.input.action-map')?.value;
  const descriptor: Record<string, InputActionMapDescriptor[string]> = {};
  if (Array.isArray(value?.actions)) {
    for (const candidate of value.actions) {
      if (!isRecord(candidate) || typeof candidate.name !== 'string') continue;
      descriptor[candidate.name] = {
        keys: stringArray(candidate.keys),
        pointerButtons: integerArray(candidate.pointerButtons),
        gamepadButtons: integerArray(candidate.gamepadButtons),
        gamepadAxes: Array.isArray(candidate.gamepadAxes) ? candidate.gamepadAxes.filter(isRecord).map((axis) => ({
          axis: Number(axis.axis),
          ...(axis.direction === 'positive' || axis.direction === 'negative' || axis.direction === 'both' ? { direction: axis.direction } : {}),
          ...(Number.isFinite(axis.deadZone) ? { deadZone: Number(axis.deadZone) } : {}),
          ...(Number.isFinite(axis.scale) ? { scale: Number(axis.scale) } : {}),
        })) : [],
      };
    }
  }
  return Object.keys(descriptor).length ? new InputActionMap(descriptor) : InputActionMap.standardGameplay();
}

function configureGameplayCamera(entities: readonly SceneEntity[], ownedScene: Scene, canvas: HTMLCanvasElement): GameplayCameraRuntime | null {
  for (const item of entities) {
    const descriptor = item.components?.find((candidate) => candidate.enabled && (candidate.type === 'haiyue.camera.3d' || candidate.type === 'haiyue.camera.2d') && candidate.value.active === true);
    if (!descriptor) continue;
    const entity = entitiesByStableId.get(item.id);
    if (!entity) continue;
    const camera = new Camera3D();
    entity.addComponent(camera);
    ownedScene.setCamera(entity);
    const follow = item.components?.find((candidate) => candidate.enabled && candidate.type === 'haiyue.camera.follow');
    const runtime = Object.freeze({ entity, component: camera, descriptor, ...(follow ? { follow } : {}) });
    resizeGameplayCamera(runtime, ownedScene, canvas);
    return runtime;
  }
  return null;
}

function resizeGameplayCamera(runtime: GameplayCameraRuntime, ownedScene: Scene, canvas: HTMLCanvasElement): void {
  const value = runtime.descriptor.value;
  const aspect = canvasAspect(canvas);
  const camera = runtime.component;
  if (runtime.descriptor.type === 'haiyue.camera.2d') {
    const designHeight = finiteNumber(value.designHeight, 1, 32_768, 600);
    const zoom = finiteNumber(value.zoom, 0.001, 1_000, 1);
    const height = designHeight / zoom;
    camera.projectionType = 'orthographic';
    camera.orthoTop = height / 2; camera.orthoBottom = -height / 2; camera.orthoRight = height * aspect / 2; camera.orthoLeft = -height * aspect / 2;
    camera.near = finiteNumber(value.near, -1_000_000, 1_000_000, -1_000);
    camera.far = Math.max(camera.near + 0.0001, finiteNumber(value.far, -1_000_000, 1_000_000, 1_000));
    camera.reverseZ = false;
  } else {
    camera.projectionType = value.projection === 'orthographic' ? 'orthographic' : 'perspective';
    camera.fov = finiteNumber(value.fovDegrees, 1, 179, 45) * Math.PI / 180;
    camera.near = finiteNumber(value.near, 0.0001, 1_000, 0.1);
    camera.far = Math.max(camera.near + 0.0001, finiteNumber(value.far, 0.001, 1_000_000, 1_000));
    camera.reverseZ = value.reverseZ === true;
    const height = finiteNumber(value.orthographicHeight, 0.01, 10_000, 20);
    camera.orthoTop = height / 2; camera.orthoBottom = -height / 2; camera.orthoRight = height * aspect / 2; camera.orthoLeft = -height * aspect / 2;
  }
  camera.aspect = aspect;
  ownedScene.renderView.reverseZ = camera.reverseZ;
  const viewport = isRecord(value.viewport) ? value.viewport : null;
  const x = finiteNumber(viewport?.x, 0, 1, 0), y = finiteNumber(viewport?.y, 0, 1, 0);
  const width = finiteNumber(viewport?.width, 0.000001, 1, 1), height = finiteNumber(viewport?.height, 0.000001, 1, 1);
  const displayWidth = canvas.width || canvas.clientWidth || 1, displayHeight = canvas.height || canvas.clientHeight || 1;
  ownedScene.renderView.viewport = x === 0 && y === 0 && width === 1 && height === 1 ? null : {
    x: Math.floor(displayWidth * x), y: Math.floor(displayHeight * y),
    width: Math.max(1, Math.floor(displayWidth * Math.min(width, 1 - x))), height: Math.max(1, Math.floor(displayHeight * Math.min(height, 1 - y))),
  };
}

function updateGameplayCamera(_deltaMs: number): void {
  const runtime = gameplayCamera;
  const follow = runtime?.follow;
  if (!runtime || !follow) return;
  const targetId = typeof follow.value.targetEntityId === 'string' ? follow.value.targetEntityId : '';
  const targetTransform = entitiesByStableId.get(targetId)?.getComponent(CartesianTransform3D);
  const cameraTransform = runtime.entity.getComponent(CartesianTransform3D);
  if (!targetTransform || !cameraTransform) return;
  const offset = vec3Value(follow.value.offset, { x: 0, y: 8, z: 10 });
  const lookAtOffset = vec3Value(follow.value.lookAtOffset, { x: 0, y: 0, z: 0 });
  const mode = follow.value.mode === 'look-at' || follow.value.mode === 'position' ? follow.value.mode : 'position-and-look-at';
  if (mode !== 'look-at') {
    let x = targetTransform.position[0] + offset.x, y = targetTransform.position[1] + offset.y, z = targetTransform.position[2] + offset.z;
    const bounds = isRecord(follow.value.bounds) ? follow.value.bounds : null;
    if (bounds?.enabled === true) {
      const minimum = vec3Value(bounds.minimum, { x: -1_000, y: -1_000, z: -1_000 });
      const maximum = vec3Value(bounds.maximum, { x: 1_000, y: 1_000, z: 1_000 });
      x = clamp(x, minimum.x, maximum.x); y = clamp(y, minimum.y, maximum.y); z = clamp(z, minimum.z, maximum.z);
    }
    const response = finiteNumber(follow.value.smoothing, 0, 1, 0.15);
    const alpha = response <= 0 ? 1 : response;
    cameraTransform.setPosition(lerp(cameraTransform.position[0], x, alpha), lerp(cameraTransform.position[1], y, alpha), lerp(cameraTransform.position[2], z, alpha));
  }
  if (mode !== 'position') {
    const dx = targetTransform.position[0] + lookAtOffset.x - cameraTransform.position[0];
    const dy = targetTransform.position[1] + lookAtOffset.y - cameraTransform.position[1];
    const dz = targetTransform.position[2] + lookAtOffset.z - cameraTransform.position[2];
    const horizontal = Math.hypot(dx, dz);
    cameraTransform.setRotation(Math.atan2(dy, Math.max(0.000001, horizontal)), Math.atan2(-dx, -dz), 0);
  }
}

function updateInteractions(input: ReplayInputSnapshot): void {
  const system = interactionSystem;
  const world = scene?.world;
  if (!system || !world) { interactionEvents = Object.freeze([]); return; }
  const output: StudioInteractionEvent[] = [];
  const counts = new Map<string, number>();
  const emit = (type: StudioInteractionEvent['type'], entityId: string, pointerId: number, hit: InteractionRaycastResult): void => {
    const descriptor = findEntityComponent(entityId, 'haiyue.interaction.pointer');
    if (!descriptor) return;
    const allowed = Array.isArray(descriptor.value.events) ? descriptor.value.events : [];
    if (!allowed.includes(type)) return;
    const maximum = integerNumber(descriptor.value.maxEventsPerTick, 1, 256, 32);
    const count = counts.get(entityId) ?? 0;
    if (count >= maximum || output.length >= 256) return;
    counts.set(entityId, count + 1);
    output.push(Object.freeze({ tick: input.tick, type, entityId, pointerId, distance: Number.isFinite(hit.distance) ? hit.distance : 0, point: Object.freeze([...hit.point]), normal: Object.freeze([...hit.normal]) }));
  };
  for (const event of input.events) {
    if (event.kind !== 'pointer') continue;
    const ndcX = event.x * 2 - 1, ndcY = 1 - event.y * 2;
    let hitEntityId: string | null = null;
    try {
      if (system.raycast(world, ndcX, ndcY, interactionRaycast) && interactionRaycast.entity) hitEntityId = stableIdByEntityId.get(interactionRaycast.entity.id) ?? null;
    } catch { hitEntityId = null; }
    if (event.phase === 'move') {
      if (hitEntityId && hitEntityId !== hoveredEntityId) emit('hover', hitEntityId, event.pointerId, interactionRaycast);
      if (hitEntityId) emit(input.pointers.find((pointer) => pointer.pointerId === event.pointerId)?.dragging ? 'drag' : 'move', hitEntityId, event.pointerId, interactionRaycast);
      hoveredEntityId = hitEntityId;
    } else if (event.phase === 'down' && hitEntityId) {
      pointerDownTargets.set(event.pointerId, hitEntityId);
      emit('down', hitEntityId, event.pointerId, interactionRaycast);
    } else if (event.phase === 'up') {
      if (hitEntityId) emit('up', hitEntityId, event.pointerId, interactionRaycast);
      const downTarget = pointerDownTargets.get(event.pointerId);
      if (hitEntityId && downTarget === hitEntityId) emit('click', hitEntityId, event.pointerId, interactionRaycast);
      pointerDownTargets.delete(event.pointerId);
    } else if (event.phase === 'wheel' && hitEntityId) emit('wheel', hitEntityId, event.pointerId, interactionRaycast);
    else if (event.phase === 'cancel') {
      const downTarget = pointerDownTargets.get(event.pointerId);
      if (downTarget) emit('cancel', downTarget, event.pointerId, interactionRaycast);
      pointerDownTargets.delete(event.pointerId);
    }
  }
  interactionEvents = Object.freeze(output);
}

function findEntityComponent(entityId: string, type: string): SceneComponent | undefined {
  const entity = entitiesByStableId.get(entityId);
  if (!entity) return undefined;
  const stableId = stableIdByEntityId.get(entity.id);
  return stableId ? activeSceneEntities?.find((candidate) => candidate.id === stableId)?.components?.find((candidate) => candidate.enabled && candidate.type === type) : undefined;
}

function installInput(canvas: HTMLCanvasElement, actionMap: InputActionMap): () => void {
  const disposers: Array<() => void> = [];
  const listen = <K extends keyof WindowEventMap>(target: Window | HTMLCanvasElement, type: K, listener: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions): void => {
    target.addEventListener(type, listener as EventListener, options);
    disposers.push(() => target.removeEventListener(type, listener as EventListener, options));
  };
  const queueAction = (action: string, phase: 'down' | 'value' | 'up', source: 'keyboard' | 'pointer' | 'gamepad', value?: number): void => {
    try { simulation?.injectNext({ kind: 'action', action, phase, source, ...(value === undefined ? {} : { value }) }); }
    catch (cause) { fail(cause); }
  };
  const queuePointer = (phase: 'move' | 'down' | 'up' | 'cancel' | 'wheel', event: PointerEvent | WheelEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const y = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    try {
      simulation?.injectNext({ kind: 'pointer', phase, source: 'pointer', pointerId: event instanceof PointerEvent ? event.pointerId : 1, x, y, ...('button' in event && phase !== 'move' && phase !== 'wheel' ? { button: Math.max(0, event.button) } : {}), ...(event instanceof WheelEvent ? { wheelX: event.deltaX, wheelY: event.deltaY } : {}) });
    } catch (cause) { fail(cause); }
  };
  canvas.tabIndex = 0;
  listen(window, 'keydown', (event) => {
    if (event.repeat) return;
    const actions = new Set([event.code, ...actionMap.actionsForKey(event.code)]);
    for (const action of actions) queueAction(action, 'down', 'keyboard');
    if (actions.size > 1) event.preventDefault();
  });
  listen(window, 'keyup', (event) => {
    const actions = new Set([event.code, ...actionMap.actionsForKey(event.code)]);
    for (const action of actions) queueAction(action, 'up', 'keyboard');
  });
  listen(canvas, 'pointermove', (event) => queuePointer('move', event as PointerEvent));
  listen(canvas, 'pointerdown', (event) => {
    const pointer = event as PointerEvent;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(pointer.pointerId);
    queuePointer('down', pointer);
    for (const action of actionMap.actionsForPointerButton(pointer.button)) queueAction(action, 'down', 'pointer');
  });
  listen(window, 'pointerup', (event) => {
    const pointer = event as PointerEvent;
    queuePointer('up', pointer);
    for (const action of actionMap.actionsForPointerButton(pointer.button)) queueAction(action, 'up', 'pointer');
  });
  listen(window, 'pointercancel', (event) => queuePointer('cancel', event as PointerEvent));
  listen(canvas, 'wheel', (event) => { event.preventDefault(); queuePointer('wheel', event as WheelEvent); }, { passive: false });
  listen(window, 'blur', () => { try { simulation?.injectNext({ kind: 'reset', source: 'system', reason: 'blur' }); } catch (cause) { fail(cause); } });

  const gamepadValues = new Map<string, number>();
  pollGamepadInput = () => {
    const gamepad = navigator.getGamepads?.()[0] ?? null;
    const sampled = actionMap.sampleGamepad(gamepad ? { connected: gamepad.connected, buttons: gamepad.buttons.map((button) => ({ pressed: button.pressed, value: button.value })), axes: [...gamepad.axes] } : null);
    const next = new Map(sampled.map((entry) => [entry.action, entry.value]));
    for (const action of new Set([...gamepadValues.keys(), ...next.keys()])) {
      const previous = gamepadValues.get(action) ?? 0;
      const value = next.get(action) ?? 0;
      if (value !== previous) queueAction(action, 'value', 'gamepad', value);
    }
    gamepadValues.clear(); for (const [action, value] of next) gamepadValues.set(action, value);
  };
  listen(window, 'gamepaddisconnected', () => { gamepadValues.clear(); try { simulation?.injectNext({ kind: 'reset', source: 'system', reason: 'disconnect' }); } catch (cause) { fail(cause); } });
  return () => { pollGamepadInput = null; for (const dispose of disposers.splice(0).reverse()) dispose(); };
}

function findEnabledComponent(entities: readonly SceneEntity[], type: string): SceneComponent | undefined {
  for (const entity of entities) { const component = entity.components?.find((candidate) => candidate.type === type && candidate.enabled); if (component) return component; }
  return undefined;
}

function stop(reason: string, invalidatePendingStart = true): void {
  if (invalidatePendingStart) lifecycleGeneration += 1;
  const disposableCount = totalDisposableCount();
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null; previousFrameTime = null;
  removeInputListeners?.(); removeInputListeners = null;
  physicsLoadController?.abort(new Error(`physics.runtime-stopped:${reason}`)); physicsLoadController = null;
  simulation?.reset(); simulation = null; activeInput = null;
  resizeObserver?.disconnect(); resizeObserver = null;
  physicsRuntime?.dispose(); physicsRuntime = null;
  renderEffectsRuntime?.dispose(); renderEffectsRuntime = null;
  for (const owner of scriptOwners.splice(0).reverse()) {
    owner.entity.removeComponent(owner.component);
    owner.component.destroy();
    planByComponent.delete(owner.component);
  }
  planByComponent.clear();
  engine?.destroy();
  instanceSets.clear();
  entitiesByStableId.clear();
  ScriptComponent.resetRuntimeApiFactory();
  ScriptComponent.resetExecutionOptions();
  engine = null; scene = null; target = null; activeCamera = null; gameplayCamera = null; activeSceneEntities = null; interactionSystem = null; interactionEvents = Object.freeze([]); hoveredEntityId = null; pointerDownTargets.clear(); stableIdByEntityId.clear(); paused = false;
  send('cleanup-complete', { reason, disposedSideEffects: disposableCount, disposableCount: 0 });
}

function totalDisposableCount(): number { return scriptOwners.reduce((sum, owner) => sum + owner.component.disposableCount, 0); }
function scriptRuntimeStates(): readonly Readonly<{ scriptId: string; entityId: string; order: number; position: Vec3 | null; disposableCount: number }>[] {
  return Object.freeze(scriptOwners.map((owner) => {
    const transform = owner.entity.getComponent(CartesianTransform3D);
    return Object.freeze({
      scriptId: owner.plan.scriptId, entityId: owner.plan.entityId, order: owner.plan.order,
      position: transform ? Object.freeze({ x: transform.position[0], y: transform.position[1], z: transform.position[2] }) : null,
      disposableCount: owner.component.disposableCount,
    });
  }));
}
function fail(cause: unknown): void { send('runtime-error', { code: 'preview-start-failed', message: cause instanceof Error ? cause.message : String(cause), line: 1, column: 1, disposableCount: totalDisposableCount() }); }
function send(type: string, payload: Record<string, unknown>): void { parent.postMessage({ protocol: 'haiyue-preview/1', type, ...payload }, '*'); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}
function parseStartRequest(value: Record<string, unknown>): Readonly<{ scene: SceneSnapshot; plan: PreviewPlan; assets: readonly PreviewAsset[] }> | null {
  if (!exactKeys(value, ['protocol', 'type', 'scene', 'plan', 'assets']) || !isRecord(value.scene) || !isRecord(value.plan) || !Array.isArray(value.assets) || value.assets.length > 128) return null;
  const rawScene = value.scene;
  const rawPlan = value.plan;
  if (typeof rawScene.documentId !== 'string' || !Number.isSafeInteger(rawScene.revision)
    || !Array.isArray(rawScene.entities) || rawScene.entities.length > 10_000
    || !exactKeys(rawPlan, ['id', 'documentId', 'documentRevision', 'selection', 'scriptSetDigest', 'scripts', 'capabilities', 'runtimeConfig', 'risk', 'diagnostics'])
    || typeof rawPlan.id !== 'string' || rawPlan.id.length > 256 || typeof rawPlan.documentId !== 'string' || rawPlan.documentId !== rawScene.documentId
    || !Number.isSafeInteger(rawPlan.documentRevision) || rawPlan.documentRevision !== rawScene.revision
    || (rawPlan.selection !== 'all-enabled' && rawPlan.selection !== 'explicit')
    || typeof rawPlan.scriptSetDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(rawPlan.scriptSetDigest)
    || !Array.isArray(rawPlan.scripts) || rawPlan.scripts.length < 1 || rawPlan.scripts.length > 128 || !rawPlan.scripts.every(isPreviewScriptPlan)
    || !Array.isArray(rawPlan.capabilities) || rawPlan.capabilities.length > 6 || !rawPlan.capabilities.every(isCapability) || new Set(rawPlan.capabilities).size !== rawPlan.capabilities.length
    || !isPlayRuntimeConfig(rawPlan.runtimeConfig) || rawPlan.risk !== 'trusted-project'
    || !Array.isArray(rawPlan.diagnostics) || rawPlan.diagnostics.length > 4_096
    || !rawScene.entities.every(isSceneEntity) || !value.assets.every(isPreviewAsset)
    || new Set(value.assets.map((asset) => (asset as PreviewAsset).id)).size !== value.assets.length) return null;
  const scripts = rawPlan.scripts as unknown as PreviewScriptPlan[];
  const aggregateCapabilities = rawPlan.capabilities as ScriptCapabilityName[];
  const sceneIds = new Set((rawScene.entities as SceneEntity[]).map((entity) => entity.id));
  const expectedCapabilities = SCRIPT_CAPABILITIES.filter((capability) => scripts.some((script) => script.capabilities.includes(capability)));
  if (new Set(scripts.map((script) => script.scriptId)).size !== scripts.length
    || new Set(scripts.map((script) => script.entityId)).size !== scripts.length
    || scripts.some((script) => !sceneIds.has(script.entityId))
    || scripts.some((script, index) => index > 0 && compareScriptPlans(scripts[index - 1]!, script) > 0)
    || expectedCapabilities.length !== aggregateCapabilities.length
    || expectedCapabilities.some((capability, index) => capability !== aggregateCapabilities[index])) return null;
  let camera: ProjectCameraSnapshot | undefined;
  try { camera = rawScene.camera === undefined ? undefined : normalizeProjectCamera(rawScene.camera); }
  catch { return null; }
  return Object.freeze({ scene: Object.freeze({ documentId: rawScene.documentId, revision: Number(rawScene.revision), entities: rawScene.entities as SceneEntity[], ...(camera ? { camera } : {}) }), plan: rawPlan as unknown as PreviewPlan, assets: Object.freeze(value.assets as PreviewAsset[]) });
}
function isPreviewScriptPlan(value: unknown): value is PreviewScriptPlan {
  return isRecord(value) && exactKeys(value, ['scriptId', 'entityId', 'order', 'textRevision', 'digest', 'capabilities', 'diagnostics', 'emittedText'])
    && typeof value.scriptId === 'string' && value.scriptId.length >= 1 && value.scriptId.length <= 256
    && typeof value.entityId === 'string' && value.entityId.length >= 1 && value.entityId.length <= 256
    && Number.isSafeInteger(value.order) && Number(value.order) >= 0 && Number(value.order) <= 1_000_000
    && Number.isSafeInteger(value.textRevision) && Number(value.textRevision) >= 1
    && typeof value.digest === 'string' && value.digest.length >= 32 && value.digest.length <= 128
    && Array.isArray(value.capabilities) && value.capabilities.length <= 6 && value.capabilities.every(isCapability) && new Set(value.capabilities).size === value.capabilities.length
    && Array.isArray(value.diagnostics) && value.diagnostics.length <= 1_024
    && typeof value.emittedText === 'string' && value.emittedText.length <= 250_000 && !value.emittedText.includes('\0');
}
function isPlayRuntimeConfig(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['schemaVersion', 'mode', 'tickRateHz', 'maxSubSteps', 'seed'])
    && value.schemaVersion === 1 && value.mode === 'fixed-step'
    && Number.isSafeInteger(value.tickRateHz) && Number(value.tickRateHz) >= 1 && Number(value.tickRateHz) <= 240
    && Number.isSafeInteger(value.maxSubSteps) && Number(value.maxSubSteps) >= 1 && Number(value.maxSubSteps) <= 10_000
    && typeof value.seed === 'string' && value.seed.length >= 1 && value.seed.length <= 256;
}
function compareScriptPlans(left: PreviewScriptPlan, right: PreviewScriptPlan): number { return left.order - right.order || left.scriptId.localeCompare(right.scriptId); }
function isPreviewAsset(value: unknown): value is PreviewAsset {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^asset:[a-f0-9]{24}$/u.test(value.id)
    || !['texture', 'model', 'audio', 'animation'].includes(String(value.kind)) || typeof value.mimeType !== 'string' || value.mimeType.length < 3 || value.mimeType.length > 128
    || !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1 || Number(value.byteLength) > 32 * 1024 * 1024) return false;
  if (value.kind === 'animation') return exactKeys(value, ['id', 'kind', 'mimeType', 'byteLength', 'source']) && typeof value.source === 'string' && new TextEncoder().encode(value.source).byteLength <= Number(value.byteLength);
  return exactKeys(value, ['id', 'kind', 'mimeType', 'byteLength', 'url']) && typeof value.url === 'string' && /^blob:/u.test(value.url);
}
function requirePreviewAsset(values: ReadonlyMap<string, PreviewAsset>, id: string, kind: PreviewAsset['kind']): PreviewAsset { const asset = values.get(id); if (!asset) throw new Error(`${kind}.asset-missing: ${id} was not transferred to the isolated preview.`); if (asset.kind !== kind) throw new Error(`${kind}.asset-kind-mismatch: ${id} is ${asset.kind}.`); return asset; }
function isSceneEntity(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
    || !isSceneEntityKind(value.kind) || (value.parentId !== null && typeof value.parentId !== 'string')
    || !isRecord(value.transform)) return false;
  if (!isVec3(value.transform.position) || !isVec3(value.transform.rotationDegrees) || !isVec3(value.transform.scale)) return false;
  if (value.components !== undefined && (!Array.isArray(value.components) || value.components.length > 256 || !value.components.every(isSceneComponent))) return false;
  if (isRenderableSceneKind(value.kind as SceneEntityKind)) return value.appearance === undefined || isAppearance(value.appearance);
  if (value.kind !== 'empty') return value.light === undefined || isLight(value.light);
  return true;
}
function isVec3(value: unknown): value is Vec3 {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
function isCapability(value: unknown): value is ScriptCapabilityName {
  return value === 'read' || value === 'input' || value === 'debug' || value === 'scene' || value === 'physics' || value === 'asset';
}
function isSceneEntityKind(value: unknown): value is SceneEntityKind { return value === 'empty' || ['cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron', 'directional-light', 'point-light', 'ambient-light'].includes(String(value)); }
function isAppearance(value: unknown): boolean { return isRecord(value) && ['basic', 'pbr', 'blinn-phong', 'normal'].includes(String(value.material)) && Array.isArray(value.color) && value.color.length === 4 && value.color.every(Number.isFinite); }
function isLight(value: unknown): boolean { return isRecord(value) && Array.isArray(value.color) && value.color.length === 3 && value.color.every(Number.isFinite) && Number.isFinite(value.intensity); }
function finiteNumber(value: unknown, minimum: number, maximum: number, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback; }
function integerNumber(value: unknown, minimum: number, maximum: number, fallback: number): number { return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : fallback; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function integerArray(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => Number.isSafeInteger(item)) : []; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function lerp(from: number, to: number, alpha: number): number { return from + (to - from) * alpha; }
function vec3Value(value: unknown, fallback: Vec3): Vec3 { return isVec3(value) ? value : fallback; }
function tuple(value: Vec3): [number, number, number] { return [value.x, value.y, value.z]; }
function radians(value: Vec3): [number, number, number] { const factor = Math.PI / 180; return [value.x * factor, value.y * factor, value.z * factor]; }
function canvasAspect(canvas: HTMLCanvasElement): number { const width = canvas.width || canvas.clientWidth; const height = canvas.height || canvas.clientHeight; return width > 0 && height > 0 ? width / height : 1; }
function boundedDevicePixelRatio(canvas: HTMLCanvasElement, requested: number, maxPixels: number): number {
  const width = Math.max(1, canvas.clientWidth || canvas.width || 1), height = Math.max(1, canvas.clientHeight || canvas.height || 1);
  return Math.max(0.25, Math.min(requested, Math.sqrt(maxPixels / (width * height))));
}

interface InstanceTransformInput { readonly position: Vec3; readonly rotationDegrees?: Vec3; readonly scale?: Vec3; readonly color?: readonly [number, number, number, number?]; }
interface StudioInstanceSet { readonly capacity: number; setCount(count: number): void; set(index: number, transform: InstanceTransformInput): void; }

function studioRuntimeApi(base: ScriptRuntimeApi, context: ScriptRuntimeContext, capabilities: readonly ScriptCapabilityName[]): ScriptRuntimeApi {
  const input = Object.freeze({
    isPressed: (action: string): boolean => simulation?.input.isPressed(action) ?? false,
    wasPressed: (action: string): boolean => simulation?.input.wasPressed(action) ?? false,
    wasReleased: (action: string): boolean => simulation?.input.wasReleased(action) ?? false,
    isKeyPressed: (code: string): boolean => simulation?.input.isPressed(code) ?? false,
    wasKeyPressed: (code: string): boolean => simulation?.input.wasPressed(code) ?? false,
    wasKeyReleased: (code: string): boolean => simulation?.input.wasReleased(code) ?? false,
    value: (action: string): number => simulation?.input.value(action) ?? 0,
    action: (action: string) => simulation?.input.action(action),
    pointer: (pointerId = 1) => simulation?.input.pointer(pointerId),
    events: () => simulation?.input.events() ?? Object.freeze([]),
    interactions: () => interactionEvents,
    snapshot: () => simulation?.input.snapshot(),
  });
  const complete = {
    ...base,
    input,
    physics: physicsRuntime?.api(),
    scene: Object.freeze({
      ...(base.scene ?? {}),
      instances(target: Entity | number | string, capacity: number): StudioInstanceSet {
        const entity = target instanceof Entity
          ? target
          : typeof target === 'string'
            ? entitiesByStableId.get(target) ?? context.world?.getEntity(target) ?? null
            : context.world?.getEntity(target) ?? null;
        if (!entity) throw new Error(`Instance target ${String(target)} was not found.`);
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4_096) throw new RangeError('Instance capacity must be an integer from 1 to 4096.');
        const cached = instanceSets.get(entity.id);
        if (cached) {
          if (cached.capacity !== capacity) throw new Error(`Instance capacity for ${entity.name} is already ${cached.capacity}.`);
          return cached;
        }
        const source = entity.getComponent(Mesh3D);
        if (!source) throw new Error(`Instance target ${entity.name} must be a geometry entity.`);
        const stableId = stableIdByEntityId.get(entity.id);
        const appearance = stableId ? activeSceneEntities?.find((candidate) => candidate.id === stableId)?.appearance : undefined;
        const templateColor = appearance?.color ?? [1, 1, 1, 1] as const;
        // Basic authoring materials must remain unlit in Play. Upgrading every
        // instance template to PBR makes otherwise valid scenes render black
        // when they intentionally contain no lights (for example, Tetris).
        const material = appearance?.material === 'pbr'
          ? new InstancedPbrMaterial(capacity, { metallic: 0.05, roughness: 0.65 })
          : new InstancedMaterial(capacity);
        let activeCount = 0;
        material.setActiveInstanceCount(activeCount);
        entity.removeComponent(source);
        entity.addComponent(new InstancedMesh3D(source.geometry, material));
        const instances: StudioInstanceSet = Object.freeze({
          capacity,
          setCount(count: number): void {
            if (!Number.isSafeInteger(count) || count < 0 || count > capacity) throw new RangeError(`Active instance count must be from 0 to ${capacity}.`);
            activeCount = count;
            material.setActiveInstanceCount(activeCount);
          },
          set(index: number, transform: InstanceTransformInput): void {
            if (!Number.isSafeInteger(index) || index < 0 || index >= capacity) throw new RangeError(`Instance index must be from 0 to ${capacity - 1}.`);
            material.setTransform(index, composeInstanceMatrix(transform));
            const color = transform.color ?? templateColor;
            material.setColor(index, color[0], color[1], color[2], color[3] ?? 1);
            if (index >= activeCount) {
              activeCount = index + 1;
              material.setActiveInstanceCount(activeCount);
            }
          },
        });
        instanceSets.set(entity.id, instances);
        return instances;
      },
    }),
  } as unknown as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};
  for (const capability of capabilities) if (complete[capability] !== undefined) filtered[capability] = complete[capability];
  return Object.freeze(filtered) as unknown as ScriptRuntimeApi;
}
function isSceneComponent(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string' && typeof value.version === 'string' && typeof value.enabled === 'boolean' && isRecord(value.value);
}

function composeInstanceMatrix(value: InstanceTransformInput): Float32Array {
  if (!isVec3(value.position) || (value.rotationDegrees !== undefined && !isVec3(value.rotationDegrees)) || (value.scale !== undefined && !isVec3(value.scale))) throw new TypeError('Instance transform vectors must contain finite x, y and z values.');
  const rotation = value.rotationDegrees ?? { x: 0, y: 0, z: 0 };
  const scale = value.scale ?? { x: 1, y: 1, z: 1 };
  const factor = Math.PI / 360;
  const sx = Math.sin(rotation.x * factor), cx = Math.cos(rotation.x * factor);
  const sy = Math.sin(rotation.y * factor), cy = Math.cos(rotation.y * factor);
  const sz = Math.sin(rotation.z * factor), cz = Math.cos(rotation.z * factor);
  const qx = sx * cy * cz - cx * sy * sz;
  const qy = cx * sy * cz + sx * cy * sz;
  const qz = cx * cy * sz - sx * sy * cz;
  const qw = cx * cy * cz + sx * sy * sz;
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return new Float32Array([
    (1 - 2 * (yy + zz)) * scale.x, (2 * (xy + wz)) * scale.x, (2 * (xz - wy)) * scale.x, 0,
    (2 * (xy - wz)) * scale.y, (1 - 2 * (xx + zz)) * scale.y, (2 * (yz + wx)) * scale.y, 0,
    (2 * (xz + wy)) * scale.z, (2 * (yz - wx)) * scale.z, (1 - 2 * (xx + yy)) * scale.z, 0,
    value.position.x, value.position.y, value.position.z, 1,
  ]);
}

window.addEventListener('beforeunload', () => { disposed = true; stop('realm-unload'); }, { once: true });
send('ready', {});
