import { randomUUID } from 'node:crypto';
import {
  BasicMaterial,
  CartesianTransform3D,
  createBox3D,
  createPlane3D,
  createSphere3D,
  Entity,
  Mesh3D,
  PbrMaterial,
  World,
} from '@haiyue/engine';
import { BlinnPhongMaterial, createCone3D, createCylinder3D, createIcosahedron3D, createTorus3D, NormalMaterial } from '@haiyue/engine/experimental';
import { AmbientLight, DirectionalLight, PointLight } from '@haiyue/engine/lighting';
import type { EditorSelectionService } from '@haiyue/editor-platform';
import {
  asStableId,
  createStudioServiceToken,
  defineStudioPlugin,
  type JsonObject,
  type JsonValue,
  type GameComponentInstanceV2,
  type GameDocumentOperationV2,
  type StableId,
  type StudioPluginDefinition,
} from '@haiyue/ai-studio-contracts';
import { editorFoundationTokens } from '@haiyue/ai-studio-kernel';
import { operationLogServiceToken, type OperationLog } from '@haiyue/ai-studio-operation-log';
import { projectWorkspaceServiceToken } from './project/index.js';
import type { ProjectDocumentMutation, ProjectWorkspace } from './history/index.js';
import { CONTROLLED_ASSET_CATALOG_SETTING_KEY, ControlledAssetCatalog, type ControlledAssetManifestEntry } from './assets/catalog.js';

export const SCENE_GEOMETRY_KINDS = Object.freeze(['cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron'] as const);
export const SCENE_LIGHT_KINDS = Object.freeze(['directional-light', 'point-light', 'ambient-light'] as const);
export const SCENE_MATERIAL_KINDS = Object.freeze(['basic', 'pbr', 'blinn-phong', 'normal'] as const);
export type SceneGeometryKind = typeof SCENE_GEOMETRY_KINDS[number];
export type SceneLightKind = typeof SCENE_LIGHT_KINDS[number];
export type SceneMaterialKind = typeof SCENE_MATERIAL_KINDS[number];
export type SceneMaterialColor = readonly [number, number, number, number];
export type SceneEntityKind = 'empty' | SceneGeometryKind | SceneLightKind;
export type SelectionIntentSource = 'hierarchy' | 'viewport' | 'inspector' | 'system';

export interface Vec3Snapshot { readonly x: number; readonly y: number; readonly z: number; }
export interface TransformSnapshot {
  readonly position: Vec3Snapshot;
  readonly rotationDegrees: Vec3Snapshot;
  readonly scale: Vec3Snapshot;
}
export interface SceneEntitySnapshot {
  readonly id: StableId;
  readonly name: string;
  readonly kind: SceneEntityKind;
  readonly parentId: StableId | null;
  readonly order: number;
  readonly transform: TransformSnapshot;
  readonly components?: readonly GameComponentInstanceV2[];
  readonly appearance?: Readonly<{ material: SceneMaterialKind; color: SceneMaterialColor }>;
  readonly light?: Readonly<{
    color: readonly [number, number, number]; intensity: number; range?: number;
    direction?: readonly [number, number, number]; castShadow?: boolean;
  }>;
}
export interface SceneSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly documentId: StableId;
  readonly entities: readonly SceneEntitySnapshot[];
  readonly assets: readonly ControlledAssetManifestEntry[];
}
export interface CreateSceneEntityIntent {
  readonly commandId: StableId;
  readonly baseRevision: number;
  readonly kind: SceneEntityKind;
  readonly name?: string;
  readonly parentId?: StableId | null;
  readonly material?: SceneMaterialKind;
  readonly color?: SceneMaterialColor;
  readonly transform?: TransformSnapshot;
}
export interface SetEntityTransformIntent {
  readonly commandId: StableId;
  readonly baseRevision: number;
  readonly entityId: StableId;
  readonly transform: TransformSnapshot;
}
export interface RenameSceneEntityIntent {
  readonly commandId: StableId;
  readonly baseRevision: number;
  readonly entityId: StableId;
  readonly name: string;
}
export interface SetEntityMaterialIntent {
  readonly commandId: StableId;
  readonly baseRevision: number;
  readonly entityId: StableId;
  readonly material: SceneMaterialKind;
  readonly color?: SceneMaterialColor;
}

export interface SceneAuthoringService {
  snapshot(): SceneSnapshot;
  resources(): Readonly<{ engineEntityCount: number; projectionGeneration: number; disposed: boolean }>;
  createEntity(intent: CreateSceneEntityIntent, signal?: AbortSignal): Promise<SceneSnapshot>;
  renameEntity(intent: RenameSceneEntityIntent, signal?: AbortSignal): Promise<SceneSnapshot>;
  setTransform(intent: SetEntityTransformIntent, signal?: AbortSignal): Promise<SceneSnapshot>;
  setMaterial(intent: SetEntityMaterialIntent, signal?: AbortSignal): Promise<SceneSnapshot>;
  subscribe(listener: (snapshot: SceneSnapshot) => void): Readonly<{ dispose(): void }>;
}

export interface SceneSelectionSnapshot {
  readonly revision: number;
  readonly activeEntityId: StableId | null;
  readonly entityIds: readonly StableId[];
  readonly source: SelectionIntentSource;
}
export interface SceneSelectionService {
  snapshot(): SceneSelectionSnapshot;
  select(entityId: StableId | null, source: SelectionIntentSource, correlationId?: StableId): Promise<SceneSelectionSnapshot>;
  pick(readback: Promise<StableId | null>, source?: SelectionIntentSource, correlationId?: StableId): Promise<SceneSelectionSnapshot>;
  invalidatePendingPick(): void;
}

export interface ViewportPickInput {
  readonly clientX: number;
  readonly clientY: number;
  readonly rect: Readonly<{ left: number; top: number; width: number; height: number }>;
  readonly devicePixelRatio: number;
}
export interface ViewportPickPoint { readonly pixelX: number; readonly pixelY: number; readonly normalizedX: number; readonly normalizedY: number; }
export type ViewportState = 'detached' | 'initializing' | 'ready' | 'device-lost' | 'failed' | 'disposed';
export interface ViewportBackend {
  initialize(): Promise<void>;
  render(scene: SceneSnapshot, selectedEntityId: StableId | null): void;
  pick(point: ViewportPickPoint): Promise<StableId | null>;
  resize(width: number, height: number, devicePixelRatio: number): void;
  dispose(): void | Promise<void>;
}
export interface ViewportService {
  readonly state: ViewportState;
  attach(backend: ViewportBackend): Promise<void>;
  detach(): Promise<void>;
  render(): void;
  pick(input: ViewportPickInput, correlationId?: StableId): Promise<SceneSelectionSnapshot>;
  resize(width: number, height: number, devicePixelRatio: number): void;
  deviceLost(message: string): Promise<void>;
  dispose(): Promise<void>;
}

export const sceneAuthoringToken = createStudioServiceToken<SceneAuthoringService>('studio.scene-authoring');
export const hierarchyServiceToken = createStudioServiceToken<Pick<SceneAuthoringService, 'snapshot' | 'createEntity'>>('studio.hierarchy');
export const sceneSelectionToken = createStudioServiceToken<SceneSelectionService>('studio.scene-selection');
export const transformServiceToken = createStudioServiceToken<Pick<SceneAuthoringService, 'snapshot' | 'setTransform'>>('studio.transform');
export const viewportServiceToken = createStudioServiceToken<ViewportService>('studio.viewport');

const ENTITY_SELECTION_KIND = 'scene-entity';

class EngineSceneProjection {
  private worldValue = new World('AIStudio Authoring World');
  private entities = new Map<StableId, Entity>();
  private disposed = false;
  private generation = 0;

  resources(): Readonly<{ engineEntityCount: number; projectionGeneration: number; disposed: boolean }> {
    return Object.freeze({ engineEntityCount: this.entities.size, projectionGeneration: this.generation, disposed: this.disposed });
  }

  rebuild(snapshot: SceneSnapshot): void {
    this.assertActive();
    const nextWorld = new World('AIStudio Authoring World');
    const nextEntities = new Map<StableId, Entity>();
    for (const item of snapshot.entities) {
      const entity = new Entity(item.name);
      const transform = new CartesianTransform3D({
        position: tuple(item.transform.position),
        rotation: tupleDegreesToRadians(item.transform.rotationDegrees),
        scale: tuple(item.transform.scale),
      });
      entity.addComponent(transform);
      if (isSceneGeometryKind(item.kind)) entity.addComponent(new Mesh3D(createGeometry(item.kind), createMaterial(item.appearance!)));
      else if (isSceneLightKind(item.kind)) entity.addComponent(createLight(item.kind, item.light!));
      nextEntities.set(item.id, entity);
    }
    for (const item of snapshot.entities) {
      const entity = nextEntities.get(item.id)!;
      if (item.parentId) {
        const parent = nextEntities.get(item.parentId);
        if (!parent) throw new Error(`Scene parent ${item.parentId} is missing.`);
        parent.addChild(entity);
      }
    }
    for (const item of snapshot.entities) if (!item.parentId) nextWorld.addEntity(nextEntities.get(item.id)!);
    const previous = this.worldValue;
    this.worldValue = nextWorld;
    this.entities = nextEntities;
    this.generation += 1;
    previous.destroy();
  }

  apply(before: SceneEntitySnapshot | null, after: SceneEntitySnapshot | null): void {
    this.assertActive();
    if (!after && before) { const entity = this.entities.get(before.id); if (entity) { entity.destroy(); this.entities.delete(before.id); this.generation += 1; } return; }
    if (!after) return;
    if (!before) {
      const entity = engineEntity(after); this.entities.set(after.id, entity);
      if (after.parentId) { const parent = this.entities.get(after.parentId); if (!parent) throw new Error(`Scene parent ${after.parentId} is missing.`); parent.addChild(entity); }
      else this.worldValue.addEntity(entity);
      this.generation += 1; return;
    }
    const entity = this.entities.get(after.id); if (!entity) throw new Error(`Projected entity ${after.id} is missing.`);
    entity.name = after.name;
    const transform = entity.getComponent(CartesianTransform3D); if (!transform) throw new Error(`Projected transform ${after.id} is missing.`);
    transform.setPosition(...tuple(after.transform.position)).setRotation(...tupleDegreesToRadians(after.transform.rotationDegrees)).setScale(...tuple(after.transform.scale));
    if (before.parentId !== after.parentId) {
      if (after.parentId) { const parent = this.entities.get(after.parentId); if (!parent) throw new Error(`Scene parent ${after.parentId} is missing.`); parent.addChild(entity); }
      else if (entity.parent) { entity.parent.removeChild(entity); this.worldValue.addEntity(entity); }
    }
    if (isSceneGeometryKind(after.kind)) {
      entity.removeComponent(DirectionalLight); entity.removeComponent(PointLight); entity.removeComponent(AmbientLight);
      entity.addComponent(new Mesh3D(createGeometry(after.kind), createMaterial(after.appearance!)));
    } else if (isSceneLightKind(after.kind)) {
      entity.removeComponent(Mesh3D); entity.removeComponent(DirectionalLight); entity.removeComponent(PointLight); entity.removeComponent(AmbientLight); entity.addComponent(createLight(after.kind, after.light!));
    } else {
      entity.removeComponent(Mesh3D); entity.removeComponent(DirectionalLight); entity.removeComponent(PointLight); entity.removeComponent(AmbientLight);
    }
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entities.clear();
    this.worldValue.destroy();
  }
  private assertActive(): void { if (this.disposed) throw new Error('Engine Scene projection is disposed.'); }
}

export class ProjectSceneAuthoringService implements SceneAuthoringService {
  private readonly projection = new EngineSceneProjection();
  private readonly listeners = new Set<(snapshot: SceneSnapshot) => void>();
  private readonly workspaceSubscription: Readonly<{ dispose(): void }>;
  private current: SceneSnapshot;
  private readonly sceneEntities = new Map<StableId, SceneEntitySnapshot>();
  private disposed = false;

  constructor(private readonly workspace: ProjectWorkspace, private readonly log: OperationLog) {
    this.current = sceneFromWorkspace(workspace);
    for (const entity of this.current.entities) this.sceneEntities.set(entity.id, entity);
    this.projection.rebuild(this.current);
    this.workspaceSubscription = workspace.subscribeDocumentMutations((mutation) => this.sync(mutation));
  }

  snapshot(): SceneSnapshot { this.assertActive(); return this.current; }
  resources(): Readonly<{ engineEntityCount: number; projectionGeneration: number; disposed: boolean }> { return this.projection.resources(); }

  async createEntity(intent: CreateSceneEntityIntent, signal?: AbortSignal): Promise<SceneSnapshot> {
    this.assertActive();
    try {
      if (!isSceneEntityKind(intent.kind)) throw new TypeError(`Unsupported entity kind ${intent.kind}.`);
      if (intent.material !== undefined && !isSceneMaterialKind(intent.material)) throw new TypeError(`Unsupported material ${intent.material}.`);
      if ((intent.material !== undefined || intent.color !== undefined) && !isSceneGeometryKind(intent.kind)) throw new TypeError('Only geometry entities can use materials.');
      const before = this.current;
      if (intent.parentId && !before.entities.some((item) => item.id === intent.parentId)) throw new Error(`Parent ${intent.parentId} does not exist.`);
      const siblings = before.entities.filter((item) => item.parentId === (intent.parentId ?? null));
      const entity: SceneEntitySnapshot = freezeEntity({
        id: asStableId(`entity:${randomUUID()}`),
        name: normalizeEntityName(intent.name, intent.kind),
        kind: intent.kind,
        parentId: intent.parentId ?? null,
        order: siblings.length,
        transform: intent.transform ? freezeTransform(intent.transform) : defaultTransform(),
        ...(isSceneGeometryKind(intent.kind) ? { appearance: defaultAppearance(intent.material, intent.color) } : {}),
        ...(isSceneLightKind(intent.kind) ? { light: defaultLight(intent.kind) } : {}),
      });
      const sceneId = this.workspace.primarySceneId();
      const transformId = asStableId(`component:transform:${randomUUID()}`);
      const operations: GameDocumentOperationV2[] = [
        { op: 'entity.add', entity: { id: entity.id, sceneId, name: entity.name, parentId: entity.parentId, order: entity.order, componentIds: [] } },
        { op: 'component.add', entityId: entity.id, component: this.workspace.componentRegistry.create({ id: transformId, type: asStableId('haiyue.transform.3d'), version: '1.0.0', value: entity.transform as unknown as JsonObject }) },
      ];
      if (isSceneGeometryKind(entity.kind)) {
        const geometryId = asStableId(`component:geometry:${randomUUID()}`); const materialId = asStableId(`component:material:${randomUUID()}`);
        operations.push({ op: 'component.add', entityId: entity.id, component: this.workspace.componentRegistry.create({ id: geometryId, type: asStableId('haiyue.render.geometry'), version: '1.0.0', value: { kind: entity.kind } }) });
        operations.push({ op: 'component.add', entityId: entity.id, component: this.workspace.componentRegistry.create({ id: materialId, type: asStableId('haiyue.render.material'), version: '1.0.0', value: entity.appearance as unknown as JsonObject }) });
      } else if (isSceneLightKind(entity.kind)) {
        const lightId = asStableId(`component:light:${randomUUID()}`);
        operations.push({ op: 'component.add', entityId: entity.id, component: this.workspace.componentRegistry.create({ id: lightId, type: asStableId(componentLightType(entity.kind)), version: '1.0.0', value: entity.light as unknown as JsonObject }) });
      }
      await this.workspace.executeBatch({ id: intent.commandId, label: `Create ${entityKindLabel(intent.kind)}`, baseRevision: intent.baseRevision, operations }, signal);
      await this.appendCommandFact('scene/entity-created', intent.commandId, {
        entityId: entity.id, kind: entity.kind, sceneRevision: this.current.revision,
      });
      return this.current;
    } catch (cause) {
      await this.appendRejectedFact(intent.commandId, cause);
      throw cause;
    }
  }

  async setTransform(intent: SetEntityTransformIntent, signal?: AbortSignal): Promise<SceneSnapshot> {
    this.assertActive();
    try {
      const transform = freezeTransform(intent.transform);
      if (!this.sceneEntities.has(intent.entityId)) throw new Error(`Entity ${intent.entityId} does not exist.`);
      const component = this.entityComponent(intent.entityId, 'haiyue.transform.3d');
      await this.workspace.executeBatch({ id: intent.commandId, label: 'Edit Transform', baseRevision: intent.baseRevision, operations: [{ op: 'component.replace', component: { ...component, value: transform as unknown as JsonObject } }] }, signal);
      await this.appendCommandFact('scene/transform-edited', intent.commandId, {
        entityId: intent.entityId, sceneRevision: this.current.revision,
      });
      return this.current;
    } catch (cause) {
      await this.appendRejectedFact(intent.commandId, cause);
      throw cause;
    }
  }

  async setMaterial(intent: SetEntityMaterialIntent, signal?: AbortSignal): Promise<SceneSnapshot> {
    this.assertActive();
    try {
      if (!isSceneMaterialKind(intent.material)) throw new TypeError(`Unsupported material ${intent.material}.`);
      const target = this.sceneEntities.get(intent.entityId); if (!target) throw new Error(`Entity ${intent.entityId} does not exist.`); if (!isSceneGeometryKind(target.kind) || !target.appearance) throw new TypeError('Only geometry entities can use materials.');
      const component = this.entityComponent(intent.entityId, 'haiyue.render.material'); const appearance = freezeAppearance({ ...target.appearance, material: intent.material, color: intent.color ?? target.appearance.color });
      await this.workspace.executeBatch({ id: intent.commandId, label: 'Set Material', baseRevision: intent.baseRevision, operations: [{ op: 'component.replace', component: { ...component, value: appearance as unknown as JsonObject } }] }, signal);
      await this.appendCommandFact('scene/material-edited', intent.commandId, { entityId: intent.entityId, material: intent.material, color: intent.color ?? null, sceneRevision: this.current.revision });
      return this.current;
    } catch (cause) {
      await this.appendRejectedFact(intent.commandId, cause);
      throw cause;
    }
  }

  async renameEntity(intent: RenameSceneEntityIntent, signal?: AbortSignal): Promise<SceneSnapshot> {
    this.assertActive();
    try {
      const name = normalizeRequiredEntityName(intent.name);
      if (!this.sceneEntities.has(intent.entityId)) throw new Error(`Entity ${intent.entityId} does not exist.`);
      await this.workspace.executeBatch({ id: intent.commandId, label: 'Rename Entity', baseRevision: intent.baseRevision, operations: [{ op: 'entity.update', entityId: intent.entityId, patch: { name } }] }, signal);
      await this.appendCommandFact('scene/entity-renamed', intent.commandId, { entityId: intent.entityId, name, sceneRevision: this.current.revision });
      return this.current;
    } catch (cause) {
      await this.appendRejectedFact(intent.commandId, cause);
      throw cause;
    }
  }

  subscribe(listener: (snapshot: SceneSnapshot) => void): Readonly<{ dispose(): void }> {
    this.assertActive();
    this.listeners.add(listener);
    listener(this.current);
    let active = true;
    return Object.freeze({ dispose: () => { if (active) { active = false; this.listeners.delete(listener); } } });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workspaceSubscription.dispose();
    this.listeners.clear();
    this.projection.dispose();
  }

  private sync(mutation: ProjectDocumentMutation): void {
    if (this.disposed) return;
    if (mutation.kind === 'replace') {
      const next = sceneFromWorkspace(this.workspace); this.sceneEntities.clear(); for (const entity of next.entities) this.sceneEntities.set(entity.id, entity);
      this.projection.rebuild(next); this.current = next; for (const listener of [...this.listeners]) listener(next); return;
    }
    const affected = affectedEntityIds(mutation.delta, this.workspace);
    if (affected.size === 0) {
      const next = sceneFromWorkspace(this.workspace);
      this.current = next;
      for (const listener of [...this.listeners]) listener(next);
      return;
    }
    for (const entityId of affected) {
      const before = this.sceneEntities.get(entityId) ?? null; const after = sceneEntityFromWorkspace(this.workspace, entityId);
      this.projection.apply(before, after); if (after) this.sceneEntities.set(entityId, after); else this.sceneEntities.delete(entityId);
    }
    this.current = freezeScene({ schemaVersion: 1, revision: mutation.delta.afterRevision, documentId: mutation.delta.documentId as StableId, entities: sortSceneEntities([...this.sceneEntities.values()]), assets: controlledAssets(this.workspace) });
    for (const listener of [...this.listeners]) listener(this.current);
  }
  private entityComponent(entityId: StableId, type: string): GameComponentInstanceV2 {
    const result = this.workspace.queryGameDocument({ entityId, limit: 1 }); const component = result.components.find((value) => value.type === type);
    if (!component) throw new Error(`Entity ${entityId} does not contain ${type}.`); return component;
  }
  private async appendCommandFact(kind: string, commandId: StableId, payload: JsonObject): Promise<void> {
    const document = this.workspace.snapshot().document;
    await this.log.append({
      kind, severity: 'info', source: asStableId('studio.scene'),
      correlation: { commandId, projectId: document?.projectId, documentId: document?.documentId },
      payload: { ...payload, documentRevision: document?.revision ?? 0 },
    });
  }
  private async appendRejectedFact(commandId: StableId, cause: unknown): Promise<void> {
    const document = this.workspace.snapshot().document;
    await this.log.append({
      kind: 'scene/command-rejected', severity: 'warning', source: asStableId('studio.scene'),
      correlation: { commandId, projectId: document?.projectId, documentId: document?.documentId },
      payload: { message: errorMessage(cause), documentRevision: document?.revision ?? 0 },
    }).catch(() => {});
  }
  private assertActive(): void { if (this.disposed) throw new Error('Scene authoring service is disposed.'); }
}

export class UnifiedSceneSelectionService implements SceneSelectionService {
  private source: SelectionIntentSource = 'system';
  private pickGeneration = 0;
  private pendingFacts: Promise<void> = Promise.resolve();
  constructor(private readonly selection: EditorSelectionService, private readonly scene: SceneAuthoringService, private readonly log: OperationLog) {}

  snapshot(): SceneSelectionSnapshot {
    const value = this.selection.snapshot();
    return Object.freeze({
      revision: value.revision,
      activeEntityId: value.active?.kind === ENTITY_SELECTION_KIND ? asStableId(value.active.id) : null,
      entityIds: Object.freeze(value.items.filter((item) => item.kind === ENTITY_SELECTION_KIND).map((item) => asStableId(item.id))),
      source: this.source,
    });
  }

  async select(entityId: StableId | null, source: SelectionIntentSource, correlationId = asStableId(`selection:${randomUUID()}`)): Promise<SceneSelectionSnapshot> {
    this.pickGeneration += 1;
    if (entityId && !this.scene.snapshot().entities.some((item) => item.id === entityId)) throw new Error(`Entity ${entityId} does not exist.`);
    const fact = {
      kind: entityId ? 'selection/entity-selected' : 'selection/cleared', severity: 'info', source: asStableId('studio.selection'),
      correlation: { entityId: entityId ?? undefined, commandId: correlationId }, payload: { source },
    } as const;
    this.source = source;
    if (entityId) {
      const documentId = this.scene.snapshot().documentId;
      this.selection.set([{ kind: ENTITY_SELECTION_KIND, id: entityId, documentId }]);
    } else this.selection.clear();
    const snapshot = this.snapshot();
    const previousFacts = this.pendingFacts;
    this.pendingFacts = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => previousFacts).then(async () => { await this.log.append(fact); }).catch(() => {});
    return snapshot;
  }

  async pick(readback: Promise<StableId | null>, source: SelectionIntentSource = 'viewport', correlationId?: StableId): Promise<SceneSelectionSnapshot> {
    const generation = ++this.pickGeneration;
    const result = await readback;
    if (generation !== this.pickGeneration) return this.snapshot();
    return this.select(result, source, correlationId);
  }
  invalidatePendingPick(): void { this.pickGeneration += 1; }
  async whenIdle(): Promise<void> { await this.pendingFacts; }
}

export class OwnedViewportService implements ViewportService {
  private backend: ViewportBackend | null = null;
  private generation = 0;
  private stateValue: ViewportState = 'detached';
  private disposed = false;
  private lastRenderSignature: string | null = null;
  private pendingFacts: Promise<void> = Promise.resolve();
  constructor(private readonly scene: SceneAuthoringService, private readonly selection: SceneSelectionService, private readonly log: OperationLog) {}
  get state(): ViewportState { return this.stateValue; }

  async attach(backend: ViewportBackend): Promise<void> {
    this.assertActive();
    await this.detach();
    const generation = ++this.generation;
    this.stateValue = 'initializing';
    this.backend = backend;
    try {
      await backend.initialize();
      if (generation !== this.generation || this.disposed) { await backend.dispose(); return; }
      this.stateValue = 'ready';
      await this.log.append({ kind: 'viewport/ready', severity: 'info', source: asStableId('studio.viewport'), correlation: {}, payload: {} });
      this.render();
    } catch (cause) {
      this.stateValue = 'failed';
      try { await backend.dispose(); } catch { /* initialization failure remains authoritative */ }
      this.backend = null;
      await this.log.append({ kind: 'viewport/initialization-failed', severity: 'error', source: asStableId('studio.viewport'), correlation: {}, payload: { message: errorMessage(cause) } });
      throw cause;
    }
  }

  render(): void {
    if (this.stateValue !== 'ready' || !this.backend) return;
    try {
      const scene = this.scene.snapshot();
      const selectedEntityId = this.selection.snapshot().activeEntityId;
      this.backend.render(scene, selectedEntityId);
      const signature = `${scene.documentId}:${scene.revision}:${selectedEntityId ?? ''}`;
      if (signature !== this.lastRenderSignature) {
        this.lastRenderSignature = signature;
        this.appendFact({
          kind: 'viewport/rendered-state', severity: 'info', source: asStableId('studio.viewport'),
          correlation: { documentId: scene.documentId, entityId: selectedEntityId ?? undefined },
          payload: { sceneRevision: scene.revision, selectedEntityId },
        });
      }
    }
    catch (cause) {
      this.stateValue = 'failed';
      void this.log.append({ kind: 'viewport/render-failed', severity: 'error', source: asStableId('studio.viewport'), correlation: {}, payload: { message: errorMessage(cause) } });
    }
  }

  async pick(input: ViewportPickInput, correlationId?: StableId): Promise<SceneSelectionSnapshot> {
    this.assertActive();
    if (this.stateValue !== 'ready' || !this.backend) throw new Error('Viewport is not ready.');
    try {
      return await this.selection.pick(this.backend.pick(normalizePickPoint(input)), 'viewport', correlationId);
    } catch (cause) {
      await this.log.append({ kind: 'viewport/picking-failed', severity: 'error', source: asStableId('studio.viewport'), correlation: { commandId: correlationId }, payload: { message: errorMessage(cause) } });
      throw cause;
    }
  }
  resize(width: number, height: number, devicePixelRatio: number): void {
    if (![width, height, devicePixelRatio].every(Number.isFinite) || width <= 0 || height <= 0 || devicePixelRatio <= 0) throw new TypeError('Viewport size is invalid.');
    this.backend?.resize(width, height, devicePixelRatio);
  }
  async deviceLost(message: string): Promise<void> {
    if (this.disposed) return;
    this.stateValue = 'device-lost';
    this.selection.invalidatePendingPick();
    await this.log.append({ kind: 'viewport/device-lost', severity: 'error', source: asStableId('studio.viewport'), correlation: {}, payload: { message } });
  }
  async detach(): Promise<void> {
    this.generation += 1;
    this.selection.invalidatePendingPick();
    const backend = this.backend;
    this.backend = null;
    this.lastRenderSignature = null;
    this.stateValue = this.disposed ? 'disposed' : 'detached';
    await backend?.dispose();
  }
  async dispose(): Promise<void> { if (!this.disposed) { this.disposed = true; await this.detach(); await this.pendingFacts; this.stateValue = 'disposed'; } }
  private appendFact(fact: Parameters<OperationLog['append']>[0]): void {
    this.pendingFacts = this.pendingFacts.then(() => this.log.append(fact).then(() => undefined)).catch(() => {});
  }
  private assertActive(): void { if (this.disposed) throw new Error('Viewport service is disposed.'); }
}

export function createSceneAuthoringPlugins(): readonly StudioPluginDefinition<any>[] {
  return Object.freeze([
    scenePlugin(), hierarchyPlugin(), selectionPlugin(), transformPlugin(), viewportPlugin(),
  ]);
}

function scenePlugin(): StudioPluginDefinition<any> {
  return plugin('studio.scene.plugin', [
    { id: asStableId('studio.project-workspace'), version: '1.0.0' },
    { id: asStableId('studio.operation-log'), version: '1.0.0' },
  ], [{ id: asStableId('studio.scene-authoring'), version: '1.0.0' }], (context) => {
    const service = new ProjectSceneAuthoringService(context.services.get(projectWorkspaceServiceToken), context.services.get(operationLogServiceToken).log);
    context.effects.own('scene-authoring.dispose', () => service.dispose());
    context.services.provide(sceneAuthoringToken, service);
  });
}
function hierarchyPlugin(): StudioPluginDefinition<any> {
  return plugin('studio.hierarchy.plugin', [{ id: asStableId('studio.scene-authoring'), version: '1.0.0' }], [{ id: asStableId('studio.hierarchy'), version: '1.0.0' }], (context) => {
    const scene = context.services.get(sceneAuthoringToken);
    context.services.provide(hierarchyServiceToken, Object.freeze({ snapshot: () => scene.snapshot(), createEntity: scene.createEntity.bind(scene) }));
  });
}
function selectionPlugin(): StudioPluginDefinition<any> {
  return plugin('studio.selection.plugin', [
    { id: asStableId('studio.scene-authoring'), version: '1.0.0' }, { id: asStableId('editor.selection'), version: '0.1.0' }, { id: asStableId('studio.operation-log'), version: '1.0.0' },
  ], [{ id: asStableId('studio.scene-selection'), version: '1.0.0' }], (context) => {
    const service = new UnifiedSceneSelectionService(context.services.get(editorFoundationTokens.selection), context.services.get(sceneAuthoringToken), context.services.get(operationLogServiceToken).log);
    context.services.provide(sceneSelectionToken, service);
  });
}
function transformPlugin(): StudioPluginDefinition<any> {
  return plugin('studio.transform.plugin', [{ id: asStableId('studio.scene-authoring'), version: '1.0.0' }], [{ id: asStableId('studio.transform'), version: '1.0.0' }], (context) => {
    const scene = context.services.get(sceneAuthoringToken);
    context.services.provide(transformServiceToken, Object.freeze({ snapshot: () => scene.snapshot(), setTransform: scene.setTransform.bind(scene) }));
  });
}
function viewportPlugin(): StudioPluginDefinition<any> {
  return plugin('studio.viewport.plugin', [
    { id: asStableId('studio.scene-authoring'), version: '1.0.0' }, { id: asStableId('studio.scene-selection'), version: '1.0.0' }, { id: asStableId('studio.operation-log'), version: '1.0.0' },
  ], [{ id: asStableId('studio.viewport'), version: '1.0.0' }], (context) => {
    const service = new OwnedViewportService(context.services.get(sceneAuthoringToken), context.services.get(sceneSelectionToken), context.services.get(operationLogServiceToken).log);
    context.effects.own('viewport.dispose', () => service.dispose());
    context.services.provide(viewportServiceToken, service);
  });
}

function plugin(id: string, required: readonly { id: StableId; version: string }[], provides: readonly { id: StableId; version: string }[], activate: StudioPluginDefinition<any>['activate']): StudioPluginDefinition<any> {
  return defineStudioPlugin({
    manifest: { schemaVersion: 1, id: asStableId(id), version: '0.0.0', apiVersion: '1.0', required, optional: [], provides, contributions: [], activationPolicy: 'required' },
    validateConfig(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) throw new TypeError(`${id} config must be empty.`); return Object.freeze({}); },
    activate,
  });
}

export function normalizePickPoint(input: ViewportPickInput): ViewportPickPoint {
  const { left, top, width, height } = input.rect;
  if (![input.clientX, input.clientY, left, top, width, height, input.devicePixelRatio].every(Number.isFinite) || width <= 0 || height <= 0 || input.devicePixelRatio <= 0) throw new TypeError('Viewport pick coordinates are invalid.');
  const localX = input.clientX - left;
  const localY = input.clientY - top;
  return Object.freeze({
    pixelX: Math.max(0, Math.min(Math.ceil(width * input.devicePixelRatio) - 1, Math.floor(localX * input.devicePixelRatio))),
    pixelY: Math.max(0, Math.min(Math.ceil(height * input.devicePixelRatio) - 1, Math.floor(localY * input.devicePixelRatio))),
    normalizedX: Math.max(0, Math.min(1, localX / width)),
    normalizedY: Math.max(0, Math.min(1, localY / height)),
  });
}

function sceneFromWorkspace(workspace: ProjectWorkspace): SceneSnapshot {
  const document = workspace.snapshot().document;
  if (!document) return freezeScene({ schemaVersion: 1, revision: 0, documentId: asStableId('document:none'), entities: [], assets: [] });
  const entities: SceneEntitySnapshot[] = []; let cursor: string | undefined;
  do { const result = workspace.queryGameDocument({ limit: 1_000, ...(cursor ? { cursor } : {}) }); for (const entity of result.entities) entities.push(sceneEntity(entity, result.components)); cursor = result.nextCursor ?? undefined; } while (cursor);
  return freezeScene({ schemaVersion: 1, revision: document.revision, documentId: document.documentId, entities: sortSceneEntities(entities), assets: controlledAssets(workspace) });
}

function controlledAssets(workspace: ProjectWorkspace): readonly ControlledAssetManifestEntry[] { return ControlledAssetCatalog.fromManifest(workspace.gameSnapshot().settings[CONTROLLED_ASSET_CATALOG_SETTING_KEY]).manifest(); }

function sceneEntityFromWorkspace(workspace: ProjectWorkspace, entityId: StableId): SceneEntitySnapshot | null { const result = workspace.queryGameDocument({ entityId, limit: 1 }); const entity = result.entities[0]; return entity ? sceneEntity(entity, result.components) : null; }
function sceneEntity(entity: ReturnType<ProjectWorkspace['queryGameDocument']>['entities'][number], components: readonly GameComponentInstanceV2[]): SceneEntitySnapshot {
  const componentIds = new Set(entity.componentIds); const ownedComponents = components.filter((component) => componentIds.has(component.id)).sort((left, right) => left.id.localeCompare(right.id)); const byType = new Map(ownedComponents.map((component) => [component.type, component])); const transform = byType.get('haiyue.transform.3d'); if (!transform) throw new Error(`Entity ${entity.id} has no Transform component.`);
  const geometry = byType.get('haiyue.render.geometry'); const material = byType.get('haiyue.render.material'); const directional = byType.get('haiyue.light.directional'); const point = byType.get('haiyue.light.point'); const ambient = byType.get('haiyue.light.ambient');
  const kind = geometry ? String(geometry.value.kind) : directional ? 'directional-light' : point ? 'point-light' : ambient ? 'ambient-light' : 'empty';
  return freezeEntity({ id: asStableId(entity.id, 'entity id'), name: entity.name, kind: kind as SceneEntityKind, parentId: entity.parentId ? asStableId(entity.parentId, 'parent id') : null, order: entity.order, transform: transform.value as unknown as TransformSnapshot, components: ownedComponents, ...(geometry && material ? { appearance: material.value as unknown as NonNullable<SceneEntitySnapshot['appearance']> } : {}), ...((directional ?? point ?? ambient) ? { light: (directional ?? point ?? ambient)!.value as unknown as NonNullable<SceneEntitySnapshot['light']> } : {}) });
}

function affectedEntityIds(delta: { readonly operations: readonly GameDocumentOperationV2[] }, workspace: ProjectWorkspace): Set<StableId> {
  const result = new Set<StableId>();
  for (const operation of delta.operations) {
    if (operation.op === 'entity.add') result.add(asStableId(operation.entity.id, 'entity id'));
    else if (operation.op === 'entity.update' || operation.op === 'entity.remove') result.add(asStableId(operation.entityId, 'entity id'));
    else if (operation.op === 'component.add' || operation.op === 'component.remove') result.add(asStableId(operation.entityId, 'entity id'));
    else if (operation.op === 'component.patch' || operation.op === 'component.unset' || operation.op === 'component.replace') { const id = operation.op === 'component.replace' ? operation.component.id : operation.componentId; const owner = workspace.componentOwner(asStableId(id, 'component id')); if (owner) result.add(owner); }
  }
  return result;
}
function sortSceneEntities(values: readonly SceneEntitySnapshot[]): SceneEntitySnapshot[] { const children = new Map<string, SceneEntitySnapshot[]>(); for (const value of values) { const key = value.parentId ?? ''; const list = children.get(key) ?? []; list.push(value); children.set(key, list); } for (const list of children.values()) list.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)); const output: SceneEntitySnapshot[] = []; const visit = (parentId: string): void => { for (const child of children.get(parentId) ?? []) { output.push(child); visit(child.id); } }; visit(''); return output; }

export function parseSceneSnapshot(value: JsonValue, documentId: StableId): SceneSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Scene snapshot must be an object.');
  const raw = value as Record<string, JsonValue>;
  if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || !Array.isArray(raw.entities)) throw new TypeError('Scene snapshot envelope is invalid.');
  const ids = new Set<string>();
  const entities = raw.entities.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`Scene entity ${index} is invalid.`);
    const entity = item as unknown as SceneEntitySnapshot;
    asStableId(entity.id, 'scene entity id');
    if (ids.has(entity.id)) throw new TypeError(`Duplicate scene entity ${entity.id}.`);
    ids.add(entity.id);
    return freezeEntity(entity);
  });
  for (const entity of entities) if (entity.parentId && !ids.has(entity.parentId)) throw new TypeError(`Missing scene parent ${entity.parentId}.`);
  const assets = ControlledAssetCatalog.fromManifest(raw.assets).manifest();
  return freezeScene({ schemaVersion: 1, revision: raw.revision as number, documentId, entities, assets });
}

function freezeScene(value: SceneSnapshot): SceneSnapshot { return Object.freeze({ ...value, entities: Object.freeze(value.entities.map(freezeEntity)), assets: Object.freeze([...value.assets]) }); }
function freezeEntity(value: SceneEntitySnapshot): SceneEntitySnapshot {
  if (!isSceneEntityKind(value.kind) || !value.name.trim() || !Number.isSafeInteger(value.order) || value.order < 0) throw new TypeError('Scene entity metadata is invalid.');
  return Object.freeze({
    id: value.id, name: value.name, kind: value.kind, parentId: value.parentId, order: value.order, transform: freezeTransform(value.transform),
    ...(value.components ? { components: Object.freeze(value.components.map(freezeComponentInstance)) } : {}),
    ...(isSceneGeometryKind(value.kind) ? { appearance: freezeAppearance(value.appearance ?? defaultAppearance()) } : {}),
    ...(isSceneLightKind(value.kind) ? { light: freezeLight(value.kind, value.light ?? defaultLight(value.kind)) } : {}),
  });
}
function freezeTransform(value: TransformSnapshot): TransformSnapshot {
  const position = freezeVec3(value.position, 'position');
  const rotationDegrees = freezeVec3(value.rotationDegrees, 'rotation');
  const scale = freezeVec3(value.scale, 'scale');
  if (scale.x <= 0 || scale.y <= 0 || scale.z <= 0) throw new TypeError('Transform scale must be greater than zero.');
  return Object.freeze({ position, rotationDegrees, scale });
}
function freezeVec3(value: Vec3Snapshot, label: string): Vec3Snapshot {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) throw new TypeError(`Transform ${label} must contain finite values.`);
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}
function defaultTransform(): TransformSnapshot { return freezeTransform({ position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }); }
function normalizeEntityName(value: string | undefined, kind: SceneEntityKind): string { const name = value?.trim() || entityKindLabel(kind); if (name.length > 80) throw new TypeError('Entity name is too long.'); return name; }
function normalizeRequiredEntityName(value: string): string { const name = value.trim(); if (!name || name.length > 80) throw new TypeError('Entity name must contain 1-80 characters.'); return name; }
function tuple(value: Vec3Snapshot): [number, number, number] { return [value.x, value.y, value.z]; }
function tupleDegreesToRadians(value: Vec3Snapshot): [number, number, number] { const factor = Math.PI / 180; return [value.x * factor, value.y * factor, value.z * factor]; }
function engineEntity(item: SceneEntitySnapshot): Entity { const entity = new Entity(item.name); entity.addComponent(new CartesianTransform3D({ position: tuple(item.transform.position), rotation: tupleDegreesToRadians(item.transform.rotationDegrees), scale: tuple(item.transform.scale) })); if (isSceneGeometryKind(item.kind)) entity.addComponent(new Mesh3D(createGeometry(item.kind), createMaterial(item.appearance!))); else if (isSceneLightKind(item.kind)) entity.addComponent(createLight(item.kind, item.light!)); return entity; }
export function isSceneGeometryKind(value: unknown): value is SceneGeometryKind { return SCENE_GEOMETRY_KINDS.includes(value as SceneGeometryKind); }
export function isSceneLightKind(value: unknown): value is SceneLightKind { return SCENE_LIGHT_KINDS.includes(value as SceneLightKind); }
export function isSceneMaterialKind(value: unknown): value is SceneMaterialKind { return SCENE_MATERIAL_KINDS.includes(value as SceneMaterialKind); }
export function isSceneEntityKind(value: unknown): value is SceneEntityKind { return value === 'empty' || isSceneGeometryKind(value) || isSceneLightKind(value); }
function defaultAppearance(material: SceneMaterialKind = 'basic', color: SceneMaterialColor = [0.16, 0.58, 1, 1]): NonNullable<SceneEntitySnapshot['appearance']> { return freezeAppearance({ material, color }); }
function freezeAppearance(value: NonNullable<SceneEntitySnapshot['appearance']>): NonNullable<SceneEntitySnapshot['appearance']> {
  if (!isSceneMaterialKind(value.material) || !Array.isArray(value.color) || value.color.length !== 4 || !value.color.every((item) => Number.isFinite(item) && item >= 0 && item <= 1)) throw new TypeError('Scene material appearance is invalid.');
  return Object.freeze({ material: value.material, color: Object.freeze([...value.color] as [number, number, number, number]) });
}
function defaultLight(kind: SceneLightKind): NonNullable<SceneEntitySnapshot['light']> {
  if (kind === 'directional-light') return Object.freeze({ color: Object.freeze([1, 1, 1] as const), intensity: 1, direction: Object.freeze([-0.5, -1, -0.35] as const), castShadow: true });
  if (kind === 'point-light') return Object.freeze({ color: Object.freeze([1, 0.9, 0.75] as const), intensity: 2, range: 12 });
  return Object.freeze({ color: Object.freeze([0.7, 0.8, 1] as const), intensity: 0.25 });
}
function freezeLight(kind: SceneLightKind, value: NonNullable<SceneEntitySnapshot['light']>): NonNullable<SceneEntitySnapshot['light']> {
  if (!Array.isArray(value.color) || value.color.length !== 3 || !value.color.every((item) => Number.isFinite(item) && item >= 0) || !Number.isFinite(value.intensity) || value.intensity < 0) throw new TypeError('Scene light is invalid.');
  const color = Object.freeze([...value.color] as [number, number, number]);
  if (kind === 'directional-light') {
    const direction = value.direction ?? [-0.5, -1, -0.35];
    if (!Array.isArray(direction) || direction.length !== 3 || !direction.every(Number.isFinite)) throw new TypeError('Directional light direction is invalid.');
    return Object.freeze({ color, intensity: value.intensity, direction: Object.freeze([...direction] as [number, number, number]), castShadow: value.castShadow !== false });
  }
  if (kind === 'point-light') {
    if (!Number.isFinite(value.range) || (value.range ?? 0) <= 0) throw new TypeError('Point light range is invalid.');
    return Object.freeze({ color, intensity: value.intensity, range: value.range });
  }
  return Object.freeze({ color, intensity: value.intensity });
}
function createGeometry(kind: SceneGeometryKind) {
  switch (kind) {
    case 'cube': return createBox3D(); case 'sphere': return createSphere3D(); case 'cone': return createCone3D(); case 'cylinder': return createCylinder3D();
    case 'plane': return createPlane3D(); case 'torus': return createTorus3D(); case 'icosahedron': return createIcosahedron3D();
  }
}
function createMaterial(appearance: NonNullable<SceneEntitySnapshot['appearance']>) {
  switch (appearance.material) {
    case 'basic': return new BasicMaterial({ color: appearance.color });
    case 'pbr': return new PbrMaterial({ baseColor: appearance.color, metallic: 0.05, roughness: 0.65 });
    case 'blinn-phong': return new BlinnPhongMaterial({ diffuse: appearance.color });
    case 'normal': return new NormalMaterial({ space: 'world' });
  }
}
function createLight(kind: SceneLightKind, light: NonNullable<SceneEntitySnapshot['light']>) {
  if (kind === 'directional-light') return new DirectionalLight({ color: light.color, intensity: light.intensity, direction: [...light.direction!] as [number, number, number], castShadow: light.castShadow });
  if (kind === 'point-light') return new PointLight({ color: light.color, intensity: light.intensity, range: light.range });
  return new AmbientLight({ color: light.color, intensity: light.intensity });
}
function freezeComponentInstance(value: GameComponentInstanceV2): GameComponentInstanceV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' || typeof value.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.version) || !value.value || typeof value.value !== 'object' || Array.isArray(value.value)) throw new TypeError('Scene component instance is invalid.');
  return Object.freeze({ id: asStableId(value.id, 'component id'), type: asStableId(value.type, 'component type'), version: value.version, enabled: value.enabled, value: freezeJsonObject(value.value) });
}
function freezeJsonObject(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> { return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeJsonValue(child)]))); }
function freezeJsonValue(value: JsonValue): JsonValue { if (Array.isArray(value)) return Object.freeze(value.map(freezeJsonValue)) as unknown as JsonValue; if (value && typeof value === 'object') return freezeJsonObject(value as Readonly<Record<string, JsonValue>>) as JsonValue; return value; }
function componentLightType(kind: SceneLightKind): string { return kind === 'directional-light' ? 'haiyue.light.directional' : kind === 'point-light' ? 'haiyue.light.point' : 'haiyue.light.ambient'; }
function entityKindLabel(kind: SceneEntityKind): string { return ({ empty: 'Empty', cube: 'Cube', sphere: 'Sphere', cone: 'Cone', cylinder: 'Cylinder', plane: 'Plane', torus: 'Torus', icosahedron: 'Icosahedron', 'directional-light': 'Directional Light', 'point-light': 'Point Light', 'ambient-light': 'Ambient Light' } as Record<SceneEntityKind, string>)[kind]; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
