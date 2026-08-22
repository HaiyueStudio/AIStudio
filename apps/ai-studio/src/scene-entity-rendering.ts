import {
  BasicMaterial, createBox3D, createPlane3D, createSphere3D,
  type Entity, type HaiyueEngine, Mesh3D, PbrMaterial, type Scene,
} from '@haiyue/engine';
import { BlinnPhongMaterial, BlinnPhongRenderSystem, createCone3D, createCylinder3D, createIcosahedron3D, createTorus3D, NormalMaterial } from '@haiyue/engine/experimental';
import { AmbientLight, DirectionalLight, PointLight } from '@haiyue/engine/lighting';
import type { SceneEntityKind, SceneMaterialKind } from '@haiyue/ai-studio-editor-plugins';

export interface RenderableSceneEntity {
  readonly kind: SceneEntityKind;
  readonly appearance?: Readonly<{ material: SceneMaterialKind; color: readonly [number, number, number, number] }>;
  readonly light?: Readonly<{ color: readonly [number, number, number]; intensity: number; range?: number; direction?: readonly [number, number, number]; castShadow?: boolean }>;
}


const GEOMETRY_KINDS = new Set<SceneEntityKind>(['cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron']);
const LIGHT_KINDS = new Set<SceneEntityKind>(['directional-light', 'point-light', 'ambient-light']);

export function isRenderableSceneKind(kind: SceneEntityKind): boolean { return GEOMETRY_KINDS.has(kind); }
export function isLightSceneKind(kind: SceneEntityKind): boolean { return LIGHT_KINDS.has(kind); }

/** Installs renderers for supported materials that are not part of Engine's default 3-D registry. */
export function installSceneEntityMaterialRenderers(engine: HaiyueEngine, scene: Scene): void {
  const render3DSystem = scene.render3DSystem;
  if (!render3DSystem) throw new Error('Scene entity materials require a Render3DSystem.');
  scene.addSystem(new BlinnPhongRenderSystem(engine, scene.cameraEntity, { render3DSystem }), false);
}

export function attachSceneEntityVisuals(entity: Entity, item: RenderableSceneEntity): void {
  if (isRenderableSceneKind(item.kind)) {
    const appearance = item.appearance ?? { material: 'basic' as const, color: [0.16, 0.58, 1, 1] as const };
    entity.addComponent(new Mesh3D(createGeometry(item.kind), createMaterial(appearance)));
    return;
  }
  if (!isLightSceneKind(item.kind)) return;
  const light = item.light ?? defaultLight(item.kind);
  if (item.kind === 'directional-light') entity.addComponent(new DirectionalLight({ color: light.color, intensity: light.intensity, direction: [...(light.direction ?? [-0.5, -1, -0.35])] as [number, number, number], castShadow: light.castShadow !== false }));
  else if (item.kind === 'point-light') entity.addComponent(new PointLight({ color: light.color, intensity: light.intensity, range: light.range ?? 12 }));
  else entity.addComponent(new AmbientLight({ color: light.color, intensity: light.intensity }));
}

function createGeometry(kind: SceneEntityKind) {
  switch (kind) {
    case 'cube': return createBox3D(); case 'sphere': return createSphere3D(); case 'cone': return createCone3D(); case 'cylinder': return createCylinder3D();
    case 'plane': return createPlane3D(); case 'torus': return createTorus3D(); case 'icosahedron': return createIcosahedron3D();
    default: throw new Error(`Entity kind ${kind} has no geometry.`);
  }
}

function createMaterial(appearance: NonNullable<RenderableSceneEntity['appearance']>) {
  switch (appearance.material) {
    case 'basic': return new BasicMaterial({ color: appearance.color });
    case 'pbr': return new PbrMaterial({ baseColor: appearance.color, metallic: 0.05, roughness: 0.65 });
    case 'blinn-phong': return new BlinnPhongMaterial({ diffuse: appearance.color });
    case 'normal': return new NormalMaterial({ space: 'world' });
  }
}

function defaultLight(kind: SceneEntityKind): NonNullable<RenderableSceneEntity['light']> {
  if (kind === 'directional-light') return { color: [1, 1, 1], intensity: 1, direction: [-0.5, -1, -0.35], castShadow: true };
  if (kind === 'point-light') return { color: [1, 0.9, 0.75], intensity: 2, range: 12 };
  return { color: [0.7, 0.8, 1], intensity: 0.25 };
}
