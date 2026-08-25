import { CartesianTransform3D, Entity, HaiyueEngine, Mesh3D, type Scene } from '@haiyue/engine';
import { InstancedMesh3D, KeyboardComponent, ScriptComponent, ScriptResource, type ScriptCapabilityName, type ScriptRuntimeApi, type ScriptRuntimeContext, type ScriptRuntimeErrorEvent } from '@haiyue/engine/components';
import { InstancedPbrMaterial } from '@haiyue/engine/material';
import { InstancedMesh3DRenderSystem } from '@haiyue/engine/systems';
import type { SceneEntityKind, SceneMaterialKind } from '@haiyue/ai-studio-editor-plugins';
import { attachSceneEntityVisuals, installSceneEntityMaterialRenderers, isRenderableSceneKind } from './scene-entity-rendering.js';

interface Vec3 { readonly x: number; readonly y: number; readonly z: number; }
interface SceneEntity {
  readonly id: string; readonly name: string; readonly kind: SceneEntityKind; readonly parentId: string | null;
  readonly transform: Readonly<{ position: Vec3; rotationDegrees: Vec3; scale: Vec3 }>;
  readonly appearance?: Readonly<{ material: SceneMaterialKind; color: readonly [number, number, number, number] }>;
  readonly light?: Readonly<{ color: readonly [number, number, number]; intensity: number; range?: number; direction?: readonly [number, number, number]; castShadow?: boolean }>;
}
interface SceneSnapshot { readonly entities: readonly SceneEntity[]; }
interface PreviewPlan { readonly entityId: string; readonly scriptId: string; readonly emittedText: string; readonly capabilities: readonly ScriptCapabilityName[]; }

let engine: HaiyueEngine | null = null;
let scene: Scene | null = null;
let resource: ScriptResource | null = null;
let component: ScriptComponent | null = null;
let target: Entity | null = null;
let resizeObserver: ResizeObserver | null = null;
const instanceSets = new Map<number, StudioInstanceSet>();
let disposed = false;
let lifecycleGeneration = 0;

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== parent || !isRecord(event.data) || event.data.protocol !== 'haiyue-preview/1') return;
  if (event.data.type === 'start') {
    const request = parseStartRequest(event.data);
    if (!request) { fail(new Error('Preview start request failed schema validation.')); return; }
    const generation = ++lifecycleGeneration;
    void start(request.scene, request.plan, generation).catch((cause) => {
      if (generation !== lifecycleGeneration) return;
      stop('start-failed'); fail(cause);
    });
  } else if (event.data.type === 'hot-reload' && exactKeys(event.data, ['protocol', 'type', 'emittedText'])
    && typeof event.data.emittedText === 'string' && event.data.emittedText.length <= 250_000) {
    try {
      if (!resource) throw new Error('Preview is not playing.');
      resource.setScript('onUpdate', event.data.emittedText);
      send('hot-reloaded', { disposableCount: component?.disposableCount ?? 0 });
    } catch (cause) { stop('hot-reload-failed'); fail(cause); }
  } else if (event.data.type === 'stop' && exactKeys(event.data, ['protocol', 'type'])) stop('parent-request');
});

async function start(snapshot: SceneSnapshot, plan: PreviewPlan, generation: number): Promise<void> {
  if (engine) stop('restart', false);
  if (!snapshot.entities.some((item) => isRenderableSceneKind(item.kind))) throw new Error('Preview scene has no renderable geometry. Create at least one primitive before Play.');
  const canvas = document.querySelector<HTMLCanvasElement>('#preview-canvas');
  if (!canvas) throw new Error('Preview canvas is missing.');
  const ownedEngine = new HaiyueEngine({ canvas, renderProfile: 'batched', clearColor: { r: 0.03, g: 0.03, b: 0.03, a: 1 }, recoverDeviceLost: true });
  engine = ownedEngine;
  await ownedEngine.init();
  if (disposed || generation !== lifecycleGeneration || engine !== ownedEngine) { ownedEngine.destroy(); return; }
  const ownedScene = ownedEngine.createScene({ name: 'Trusted Project Preview', render3D: true });
  scene = ownedScene;
  installSceneEntityMaterialRenderers(ownedEngine, ownedScene);
  ownedScene.addSystem(new InstancedMesh3DRenderSystem(ownedEngine, ownedScene.cameraEntity, { loadOp: 'load' }), false);
  const entities = new Map<string, Entity>();
  for (const item of snapshot.entities) {
    const entity = new Entity(item.name);
    entity.addComponent(new CartesianTransform3D({ position: tuple(item.transform.position), rotation: radians(item.transform.rotationDegrees), scale: tuple(item.transform.scale) }));
    attachSceneEntityVisuals(entity, item);
    entities.set(item.id, entity);
  }
  for (const item of snapshot.entities) { const entity = entities.get(item.id)!; if (item.parentId) entities.get(item.parentId)?.addChild(entity); else ownedScene.add(entity); }
  target = entities.get(plan.entityId) ?? null;
  if (!target) throw new Error(`Preview target ${plan.entityId} is missing.`);
  resource = new ScriptResource({ name: plan.scriptId, sourcePath: `scripts/${plan.scriptId}.ts`, scripts: { onUpdate: plan.emittedText } });
  target.addComponent(new KeyboardComponent());
  component = new ScriptComponent({}, resource);
  target.addComponent(component);
  ScriptComponent.setRuntimeApiFactory(studioRuntimeApi);
  ScriptComponent.enableTrustedProject({ capabilities: plan.capabilities, errorPolicy: 'disable-script', onError: runtimeError });
  ownedEngine.switchScene(ownedScene);
  resizeObserver = new ResizeObserver(() => ownedEngine.resizeToDisplaySize());
  resizeObserver.observe(canvas);
  ownedEngine.resizeToDisplaySize(true);
  ownedEngine.on('after-update', () => publishState());
  ownedEngine.run();
  send('started', { entityId: plan.entityId, disposableCount: 0 });
}

function publishState(): void {
  const transform = target?.getComponent(CartesianTransform3D);
  if (!transform) return;
  send('state', { position: { x: transform.position[0], y: transform.position[1], z: transform.position[2] }, disposableCount: component?.disposableCount ?? 0 });
}

function runtimeError(event: ScriptRuntimeErrorEvent): void {
  send('runtime-error', { code: event.error.code, message: event.error.message, line: event.sourceLocation.line, column: event.sourceLocation.column, disposableCount: component?.disposableCount ?? 0 });
}

function stop(reason: string, invalidatePendingStart = true): void {
  if (invalidatePendingStart) lifecycleGeneration += 1;
  const disposableCount = component?.disposableCount ?? 0;
  resizeObserver?.disconnect(); resizeObserver = null;
  engine?.destroy();
  instanceSets.clear();
  ScriptComponent.resetRuntimeApiFactory();
  ScriptComponent.resetExecutionOptions();
  engine = null; scene = null; resource = null; component = null; target = null;
  send('cleanup-complete', { reason, disposedSideEffects: disposableCount, disposableCount: 0 });
}

function fail(cause: unknown): void { send('runtime-error', { code: 'preview-start-failed', message: cause instanceof Error ? cause.message : String(cause), line: 1, column: 1, disposableCount: component?.disposableCount ?? 0 }); }
function send(type: string, payload: Record<string, unknown>): void { parent.postMessage({ protocol: 'haiyue-preview/1', type, ...payload }, '*'); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}
function parseStartRequest(value: Record<string, unknown>): Readonly<{ scene: SceneSnapshot; plan: PreviewPlan }> | null {
  if (!exactKeys(value, ['protocol', 'type', 'scene', 'plan']) || !isRecord(value.scene) || !isRecord(value.plan)) return null;
  const rawScene = value.scene;
  const rawPlan = value.plan;
  if (!Array.isArray(rawScene.entities) || rawScene.entities.length > 10_000
    || typeof rawPlan.entityId !== 'string' || typeof rawPlan.scriptId !== 'string'
    || typeof rawPlan.emittedText !== 'string' || rawPlan.emittedText.length > 250_000
    || !Array.isArray(rawPlan.capabilities) || !rawPlan.capabilities.every(isCapability)
    || !rawScene.entities.every(isSceneEntity)) return null;
  return Object.freeze({ scene: rawScene as unknown as SceneSnapshot, plan: rawPlan as unknown as PreviewPlan });
}
function isSceneEntity(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
    || !isSceneEntityKind(value.kind) || (value.parentId !== null && typeof value.parentId !== 'string')
    || !isRecord(value.transform)) return false;
  if (!isVec3(value.transform.position) || !isVec3(value.transform.rotationDegrees) || !isVec3(value.transform.scale)) return false;
  if (isRenderableSceneKind(value.kind as SceneEntityKind)) return value.appearance === undefined || isAppearance(value.appearance);
  if (value.kind !== 'empty') return value.light === undefined || isLight(value.light);
  return true;
}
function isVec3(value: unknown): boolean {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
function isCapability(value: unknown): value is ScriptCapabilityName {
  return value === 'read' || value === 'input' || value === 'debug' || value === 'scene';
}
function isSceneEntityKind(value: unknown): value is SceneEntityKind { return value === 'empty' || ['cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron', 'directional-light', 'point-light', 'ambient-light'].includes(String(value)); }
function isAppearance(value: unknown): boolean { return isRecord(value) && ['basic', 'pbr', 'blinn-phong', 'normal'].includes(String(value.material)) && Array.isArray(value.color) && value.color.length === 4 && value.color.every(Number.isFinite); }
function isLight(value: unknown): boolean { return isRecord(value) && Array.isArray(value.color) && value.color.length === 3 && value.color.every(Number.isFinite) && Number.isFinite(value.intensity); }
function tuple(value: Vec3): [number, number, number] { return [value.x, value.y, value.z]; }
function radians(value: Vec3): [number, number, number] { const factor = Math.PI / 180; return [value.x * factor, value.y * factor, value.z * factor]; }

interface InstanceTransformInput { readonly position: Vec3; readonly rotationDegrees?: Vec3; readonly scale?: Vec3; readonly color?: readonly [number, number, number, number?]; }
interface StudioInstanceSet { readonly capacity: number; setCount(count: number): void; set(index: number, transform: InstanceTransformInput): void; }

function studioRuntimeApi(base: ScriptRuntimeApi, context: ScriptRuntimeContext): ScriptRuntimeApi {
  return Object.freeze({
    ...base,
    scene: Object.freeze({
      instances(target: Entity | number | string, capacity: number): StudioInstanceSet {
        const entity = target instanceof Entity ? target : context.world?.getEntity(target) ?? null;
        if (!entity) throw new Error(`Instance target ${String(target)} was not found.`);
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4_096) throw new RangeError('Instance capacity must be an integer from 1 to 4096.');
        const cached = instanceSets.get(entity.id);
        if (cached) {
          if (cached.capacity !== capacity) throw new Error(`Instance capacity for ${entity.name} is already ${cached.capacity}.`);
          return cached;
        }
        const source = entity.getComponent(Mesh3D);
        if (!source) throw new Error(`Instance target ${entity.name} must be a geometry entity.`);
        const material = new InstancedPbrMaterial(capacity, { metallic: 0.05, roughness: 0.65 });
        material.setActiveInstanceCount(0);
        entity.removeComponent(source);
        entity.addComponent(new InstancedMesh3D(source.geometry, material));
        const instances: StudioInstanceSet = Object.freeze({
          capacity,
          setCount(count: number): void {
            if (!Number.isSafeInteger(count) || count < 0 || count > capacity) throw new RangeError(`Active instance count must be from 0 to ${capacity}.`);
            material.setActiveInstanceCount(count);
          },
          set(index: number, transform: InstanceTransformInput): void {
            if (!Number.isSafeInteger(index) || index < 0 || index >= capacity) throw new RangeError(`Instance index must be from 0 to ${capacity - 1}.`);
            material.setTransform(index, composeInstanceMatrix(transform));
            if (transform.color) material.setColor(index, transform.color[0], transform.color[1], transform.color[2], transform.color[3] ?? 1);
          },
        });
        instanceSets.set(entity.id, instances);
        return instances;
      },
    }),
  }) as unknown as ScriptRuntimeApi;
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
