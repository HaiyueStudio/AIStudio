import { BasicMaterial, CartesianTransform3D, createBox3D, Entity, HaiyueEngine, Mesh3D, type Scene } from '@haiyue/engine';
import { ScriptComponent, ScriptResource, type ScriptCapabilityName, type ScriptRuntimeErrorEvent } from '@haiyue/engine/components';

interface Vec3 { readonly x: number; readonly y: number; readonly z: number; }
interface SceneEntity { readonly id: string; readonly name: string; readonly kind: 'empty' | 'cube'; readonly parentId: string | null; readonly transform: Readonly<{ position: Vec3; rotationDegrees: Vec3; scale: Vec3 }> }
interface SceneSnapshot { readonly entities: readonly SceneEntity[]; }
interface PreviewPlan { readonly entityId: string; readonly scriptId: string; readonly emittedText: string; readonly capabilities: readonly ScriptCapabilityName[]; }

let engine: HaiyueEngine | null = null;
let scene: Scene | null = null;
let resource: ScriptResource | null = null;
let component: ScriptComponent | null = null;
let target: Entity | null = null;
let resizeObserver: ResizeObserver | null = null;
let disposed = false;

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== parent || !isRecord(event.data) || event.data.protocol !== 'haiyue-preview/1') return;
  if (event.data.type === 'start') {
    const request = parseStartRequest(event.data);
    if (!request) { fail(new Error('Preview start request failed schema validation.')); return; }
    void start(request.scene, request.plan).catch(fail);
  } else if (event.data.type === 'hot-reload' && exactKeys(event.data, ['protocol', 'type', 'emittedText'])
    && typeof event.data.emittedText === 'string' && event.data.emittedText.length <= 250_000) {
    resource?.setScript('onUpdate', event.data.emittedText);
    send('hot-reloaded', { disposableCount: component?.disposableCount ?? 0 });
  } else if (event.data.type === 'stop' && exactKeys(event.data, ['protocol', 'type'])) stop('parent-request');
});

async function start(snapshot: SceneSnapshot, plan: PreviewPlan): Promise<void> {
  if (engine) stop('restart');
  if (!snapshot.entities.some((item) => item.kind === 'cube')) throw new Error('Preview scene has no renderable entities. Create at least one Cube before Play.');
  const canvas = document.querySelector<HTMLCanvasElement>('#preview-canvas');
  if (!canvas) throw new Error('Preview canvas is missing.');
  const ownedEngine = new HaiyueEngine({ canvas, renderProfile: 'batched', clearColor: { r: 0.03, g: 0.03, b: 0.03, a: 1 }, recoverDeviceLost: true });
  engine = ownedEngine;
  await ownedEngine.init();
  if (disposed) { ownedEngine.destroy(); return; }
  const ownedScene = ownedEngine.createScene({ name: 'Trusted Project Preview', render3D: true });
  scene = ownedScene;
  const entities = new Map<string, Entity>();
  for (const item of snapshot.entities) {
    const entity = new Entity(item.name);
    entity.addComponent(new CartesianTransform3D({ position: tuple(item.transform.position), rotation: radians(item.transform.rotationDegrees), scale: tuple(item.transform.scale) }));
    if (item.kind === 'cube') entity.addComponent(new Mesh3D(createBox3D(), new BasicMaterial({ color: item.id === plan.entityId ? [1, .66, .16, 1] : [.16, .58, 1, 1] })));
    entities.set(item.id, entity);
  }
  for (const item of snapshot.entities) { const entity = entities.get(item.id)!; if (item.parentId) entities.get(item.parentId)?.addChild(entity); else ownedScene.add(entity); }
  target = entities.get(plan.entityId) ?? null;
  if (!target) throw new Error(`Preview target ${plan.entityId} is missing.`);
  resource = new ScriptResource({ name: plan.scriptId, sourcePath: `scripts/${plan.scriptId}.ts`, scripts: { onUpdate: plan.emittedText } });
  component = new ScriptComponent({}, resource);
  target.addComponent(component);
  ScriptComponent.enableTrustedProject({ capabilities: plan.capabilities, errorPolicy: 'disable-script', onError: runtimeError });
  ownedEngine.switchScene(ownedScene);
  resizeObserver = new ResizeObserver(() => ownedEngine.resizeToDisplaySize(true));
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

function stop(reason: string): void {
  const disposableCount = component?.disposableCount ?? 0;
  resizeObserver?.disconnect(); resizeObserver = null;
  engine?.destroy();
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
    || (value.kind !== 'empty' && value.kind !== 'cube') || (value.parentId !== null && typeof value.parentId !== 'string')
    || !isRecord(value.transform)) return false;
  return isVec3(value.transform.position) && isVec3(value.transform.rotationDegrees) && isVec3(value.transform.scale);
}
function isVec3(value: unknown): boolean {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
function isCapability(value: unknown): value is ScriptCapabilityName {
  return value === 'read' || value === 'input' || value === 'debug';
}
function tuple(value: Vec3): [number, number, number] { return [value.x, value.y, value.z]; }
function radians(value: Vec3): [number, number, number] { const factor = Math.PI / 180; return [value.x * factor, value.y * factor, value.z * factor]; }

window.addEventListener('beforeunload', () => { disposed = true; stop('realm-unload'); }, { once: true });
send('ready', {});
