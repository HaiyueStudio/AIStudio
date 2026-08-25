import { performance } from 'node:perf_hooks';
import {
  asStableId,
  type GameComponentInstanceV2,
  type GameDocumentDeltaV2,
  type GameDocumentOperationV2,
  type GameDocumentQueryResultV2,
  type GameDocumentQueryV2,
  type GameDocumentV2,
  type JsonObject,
  type JsonValue,
  type StableId,
} from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';
import { ComponentRegistry } from '../components/registry.js';

type Scene = GameDocumentV2['scenes'][number];
type GameEntity = GameDocumentV2['entities'][number];
type GameScript = GameDocumentV2['scripts'][number];
type GameAsset = GameDocumentV2['assets'][number];

export class GameDocumentStore {
  private readonly scenes = new Map<string, Scene>();
  private readonly entities = new Map<string, GameEntity>();
  private readonly components = new Map<string, GameComponentInstanceV2>();
  private readonly scripts = new Map<string, GameScript>();
  private readonly assets = new Map<string, GameAsset>();
  private readonly settings = new Map<string, JsonValue>();
  private readonly componentOwners = new Map<string, string>();
  private orderedEntityIds: readonly string[] | null = null;
  private currentRevision: number;
  private currentSavedRevision: number;
  private migration: GameDocumentV2['migration'];

  constructor(readonly id: StableId, snapshot: GameDocumentV2, readonly registry: ComponentRegistry) {
    if (snapshot.id !== id) throw new GameDocumentError('document.identity-mismatch', 'GameDocument identity does not match its owner.');
    this.currentRevision = revision(snapshot.revision, 'document revision');
    this.currentSavedRevision = revision(snapshot.savedRevision, 'saved revision');
    if (this.currentSavedRevision > this.currentRevision) throw new GameDocumentError('document.revision-invalid', 'Saved revision cannot exceed document revision.');
    this.migration = freezeMigration(snapshot.migration);
    for (const scene of snapshot.scenes) { const frozen = freezeScene(scene); insertUnique(this.scenes, frozen.id, frozen, 'scene'); }
    if (this.scenes.size < 1) throw new GameDocumentError('document.scene-missing', 'GameDocument must contain at least one scene.');
    for (const entity of snapshot.entities) { const frozen = freezeEntity(entity); insertUnique(this.entities, frozen.id, frozen, 'entity'); }
    for (const component of snapshot.components) { const frozen = registry.validate(component); insertUnique(this.components, frozen.id, frozen, 'component'); }
    for (const script of snapshot.scripts) { const frozen = freezeScript(script); insertUnique(this.scripts, frozen.id, frozen, 'script'); }
    for (const asset of snapshot.assets) { const frozen = freezeAsset(asset); insertUnique(this.assets, frozen.id, frozen, 'asset'); }
    for (const [key, value] of Object.entries(snapshot.settings)) { assertSettingKey(key); this.settings.set(key, cloneJson(value)); }
    this.validateRelationships();
  }

  static empty(id: StableId, registry: ComponentRegistry, revisionValue = 1, savedRevision = 0): GameDocumentStore {
    const sceneId = asStableId(`scene:${id.replace(/^document:/u, '').slice(0, 80) || 'main'}`);
    return new GameDocumentStore(id, Object.freeze({
      schemaVersion: 2, id, revision: revisionValue, savedRevision,
      scenes: Object.freeze([Object.freeze({ id: sceneId, name: 'Main', rootEntityIds: Object.freeze([]) })]),
      entities: Object.freeze([]), components: Object.freeze([]), scripts: Object.freeze([]), assets: Object.freeze([]), settings: Object.freeze({}),
      migration: Object.freeze({ fromVersion: null, migratedAt: null, sourceDigest: null }),
    }), registry);
  }

  get revision(): number { return this.currentRevision; }
  get savedRevision(): number { return this.currentSavedRevision; }
  get sceneCount(): number { return this.scenes.size; }
  get entityCount(): number { return this.entities.size; }
  get componentCount(): number { return this.components.size; }
  get scriptCount(): number { return this.scripts.size; }
  get assetCount(): number { return this.assets.size; }

  settingsSnapshot(): JsonObject { return freezeObject(Object.fromEntries([...this.settings.entries()].map(([key, value]) => [key, cloneJson(value)]))); }

  apply(transactionId: StableId, operations: readonly GameDocumentOperationV2[]): GameDocumentDeltaV2 {
    if (operations.length < 1 || operations.length > 1_000) throw new GameDocumentError('document.batch-size-invalid', 'A batch must contain 1-1000 operations.');
    const started = performance.now();
    const beforeRevision = this.currentRevision;
    const inverse: GameDocumentOperationV2[] = [];
    let projectionWork = 0;
    let structural = false;
    try {
      for (const operation of operations) {
        const result = this.mutate(operation);
        inverse.unshift(result.inverse);
        projectionWork += result.projectionWork;
        structural ||= isStructuralOperation(operation);
      }
      if (structural) this.validateRelationships();
    } catch (cause) {
      for (const operation of inverse) this.mutate(operation);
      this.currentRevision = beforeRevision;
      if (structural) this.validateRelationships();
      throw cause;
    }
    this.currentRevision += 1;
    const frozenOperations = Object.freeze(operations.map(freezeOperation));
    const frozenInverse = Object.freeze(inverse.map(freezeOperation));
    const copiedBytes = jsonBytes(frozenOperations);
    return Object.freeze({
      schemaVersion: 2, transactionId, documentId: this.id, beforeRevision, afterRevision: this.currentRevision,
      operations: frozenOperations, inverse: frozenInverse,
      metrics: Object.freeze({ copiedBytes, historyBytes: copiedBytes + jsonBytes(frozenInverse), projectionWork, durationMicros: Math.max(0, Math.round((performance.now() - started) * 1_000)) }),
    });
  }

  markSaved(value = this.currentRevision): void {
    const next = revision(value, 'saved revision');
    if (next > this.currentRevision) throw new GameDocumentError('document.saved-revision-invalid', 'Saved revision cannot exceed document revision.');
    this.currentSavedRevision = next;
  }

  query(input: GameDocumentQueryV2): GameDocumentQueryResultV2 {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) throw new GameDocumentError('document.query-limit-invalid', 'Query limit must be 1-1000.');
    const offset = decodeCursor(input.cursor);
    let scanned = 0;
    let candidates: readonly GameEntity[];
    if (input.entityId) {
      const entity = this.entities.get(asStableId(input.entityId, 'query entity id'));
      candidates = entity ? [entity] : [];
      scanned = entity ? 1 : 0;
    } else {
      const orderedIds = this.entityIdsById();
      const matched: GameEntity[] = [];
      const scanBudget = Math.min(10_000, Math.max(1_000, input.limit * 20));
      let index = offset;
      for (; index < orderedIds.length && scanned < scanBudget && matched.length < input.limit; index += 1) {
        const entity = this.entities.get(orderedIds[index]!)!;
        scanned += 1;
        if (input.sceneId && entity.sceneId !== input.sceneId) continue;
        if (input.componentType && !entity.componentIds.some((id) => this.components.get(id)?.type === input.componentType)) continue;
        matched.push(entity);
      }
      candidates = matched;
      const entities = candidates.map(freezeEntity);
      const componentIds = new Set(entities.flatMap((entity) => [...entity.componentIds]));
      const components = [...componentIds].map((id) => this.components.get(id)).filter((value): value is GameComponentInstanceV2 => Boolean(value)).sort(compareById);
      const next = index < orderedIds.length ? encodeCursor(index) : null;
      return Object.freeze({ schemaVersion: 2, documentId: this.id, revision: this.currentRevision, entities: Object.freeze(entities), components: Object.freeze(components), nextCursor: next, scanned });
    }
    const entities = candidates.slice(offset, offset + input.limit).map(freezeEntity);
    const componentIds = new Set(entities.flatMap((entity) => [...entity.componentIds]));
    const components = [...componentIds].map((id) => this.components.get(id)).filter((value): value is GameComponentInstanceV2 => Boolean(value)).sort(compareById);
    const next = offset + entities.length < candidates.length ? encodeCursor(offset + entities.length) : null;
    return Object.freeze({ schemaVersion: 2, documentId: this.id, revision: this.currentRevision, entities: Object.freeze(entities), components: Object.freeze(components), nextCursor: next, scanned });
  }

  component(id: StableId): GameComponentInstanceV2 | null { return this.components.get(id) ?? null; }
  entity(id: StableId): GameEntity | null { return this.entities.get(id) ?? null; }
  componentOwner(id: StableId): StableId | null { const value = this.componentOwners.get(id); return value ? asStableId(value, 'component owner') : null; }
  primarySceneId(): StableId { const scene = [...this.scenes.values()].sort(compareById)[0]; if (!scene) throw new GameDocumentError('document.scene-missing', 'GameDocument has no scene.'); return asStableId(scene.id, 'scene id'); }
  scriptsSnapshot(): readonly GameScript[] { return Object.freeze([...this.scripts.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)).map(freezeScript)); }

  export(savedRevision = this.currentSavedRevision): GameDocumentV2 {
    return Object.freeze({
      schemaVersion: 2, id: this.id, revision: this.currentRevision, savedRevision,
      scenes: Object.freeze([...this.scenes.values()].sort(compareById).map(freezeScene)),
      entities: Object.freeze([...this.entities.values()].sort(compareById).map(freezeEntity)),
      components: Object.freeze([...this.components.values()].sort(compareById)),
      scripts: Object.freeze([...this.scripts.values()].sort(compareById).map(freezeScript)),
      assets: Object.freeze([...this.assets.values()].sort(compareById).map(freezeAsset)),
      settings: this.settingsSnapshot(), migration: this.migration,
    });
  }

  private mutate(operation: GameDocumentOperationV2): Readonly<{ inverse: GameDocumentOperationV2; projectionWork: number }> {
    switch (operation.op) {
      case 'scene.add': {
        const scene = freezeScene(operation.scene); if (this.scenes.has(scene.id)) duplicate('scene', scene.id); this.scenes.set(scene.id, scene);
        return { inverse: { op: 'scene.remove', sceneId: scene.id }, projectionWork: 1 };
      }
      case 'scene.remove': {
        const scene = required(this.scenes, asStableId(operation.sceneId, 'scene id'), 'scene'); this.scenes.delete(scene.id);
        return { inverse: { op: 'scene.add', scene }, projectionWork: 1 };
      }
      case 'entity.add': {
        const entity = freezeEntity(operation.entity); if (this.entities.has(entity.id)) duplicate('entity', entity.id); required(this.scenes, entity.sceneId, 'scene');
        this.entities.set(entity.id, entity); this.orderedEntityIds = null; this.updateRoot(entity.sceneId, entity.id, entity.parentId === null);
        return { inverse: { op: 'entity.remove', entityId: entity.id }, projectionWork: 1 };
      }
      case 'entity.update': {
        const id = asStableId(operation.entityId, 'entity id'); const previous = required(this.entities, id, 'entity');
        exactPatch(operation.patch, ['name', 'parentId', 'order']);
        const next = freezeEntity({ ...previous, ...operation.patch });
        if (next.sceneId !== previous.sceneId) throw new GameDocumentError('document.entity-scene-immutable', 'Entity sceneId is immutable.');
        this.entities.set(id, next);
        if (previous.parentId !== next.parentId) { this.updateRoot(previous.sceneId, id, false); this.updateRoot(next.sceneId, id, next.parentId === null); }
        const patch: { name?: string; parentId?: string | null; order?: number } = {};
        if (Object.hasOwn(operation.patch, 'name')) patch.name = previous.name;
        if (Object.hasOwn(operation.patch, 'parentId')) patch.parentId = previous.parentId;
        if (Object.hasOwn(operation.patch, 'order')) patch.order = previous.order;
        return { inverse: { op: 'entity.update', entityId: id, patch }, projectionWork: 1 };
      }
      case 'entity.remove': {
        const id = asStableId(operation.entityId, 'entity id'); const entity = required(this.entities, id, 'entity'); this.entities.delete(id); this.orderedEntityIds = null; this.updateRoot(entity.sceneId, id, false);
        return { inverse: { op: 'entity.add', entity }, projectionWork: 1 };
      }
      case 'component.add': {
        const entityId = asStableId(operation.entityId, 'entity id'); const entity = required(this.entities, entityId, 'entity');
        const component = this.registry.validate(operation.component); if (this.components.has(component.id)) duplicate('component', component.id);
        this.components.set(component.id, component); this.entities.set(entityId, freezeEntity({ ...entity, componentIds: [...entity.componentIds, component.id] }));
        return { inverse: { op: 'component.remove', entityId, componentId: component.id }, projectionWork: 1 };
      }
      case 'component.remove': {
        const entityId = asStableId(operation.entityId, 'entity id'); const entity = required(this.entities, entityId, 'entity'); const componentId = asStableId(operation.componentId, 'component id');
        const component = required(this.components, componentId, 'component'); if (!entity.componentIds.includes(componentId)) throw new GameDocumentError('document.component-owner-mismatch', `Entity ${entityId} does not own ${componentId}.`);
        this.components.delete(componentId); this.entities.set(entityId, freezeEntity({ ...entity, componentIds: entity.componentIds.filter((id) => id !== componentId) }));
        return { inverse: { op: 'component.add', entityId, component }, projectionWork: 1 };
      }
      case 'component.replace': {
        const component = this.registry.validate(operation.component); const previous = required(this.components, component.id, 'component'); this.components.set(component.id, component);
        return { inverse: { op: 'component.replace', component: previous }, projectionWork: 1 };
      }
      case 'component.patch': {
        const componentId = asStableId(operation.componentId, 'component id'); const previous = required(this.components, componentId, 'component');
        const result = setPath(previous.value as JsonObject, operation.path, operation.value, false);
        const next = this.registry.validate({ ...previous, value: result.value }); this.components.set(componentId, next);
        return { inverse: result.existed ? { op: 'component.patch', componentId, path: [...operation.path], value: result.previous! } : { op: 'component.unset', componentId, path: [...operation.path] }, projectionWork: 1 };
      }
      case 'component.unset': {
        const componentId = asStableId(operation.componentId, 'component id'); const previous = required(this.components, componentId, 'component');
        const result = unsetPath(previous.value as JsonObject, operation.path); if (!result.existed) throw new GameDocumentError('document.component-path-missing', 'Cannot unset a missing component path.');
        const next = this.registry.validate({ ...previous, value: result.value }); this.components.set(componentId, next);
        return { inverse: { op: 'component.patch', componentId, path: [...operation.path], value: result.previous! }, projectionWork: 1 };
      }
      case 'script.upsert': {
        const script = freezeScript(operation.script); const previous = this.scripts.get(script.id); this.scripts.set(script.id, script);
        return { inverse: previous ? { op: 'script.upsert', script: previous } : { op: 'script.remove', scriptId: script.id }, projectionWork: 1 };
      }
      case 'script.remove': {
        const script = required(this.scripts, asStableId(operation.scriptId, 'script id'), 'script'); this.scripts.delete(script.id);
        return { inverse: { op: 'script.upsert', script }, projectionWork: 1 };
      }
      case 'asset.upsert': {
        const asset = freezeAsset(operation.asset); const previous = this.assets.get(asset.id); this.assets.set(asset.id, asset);
        return { inverse: previous ? { op: 'asset.upsert', asset: previous } : { op: 'asset.remove', assetId: asset.id }, projectionWork: 1 };
      }
      case 'asset.remove': {
        const asset = required(this.assets, asStableId(operation.assetId, 'asset id'), 'asset'); this.assets.delete(asset.id);
        return { inverse: { op: 'asset.upsert', asset }, projectionWork: 1 };
      }
      case 'setting.set': {
        assertSettingKey(operation.key); const existed = this.settings.has(operation.key); const previous = this.settings.get(operation.key); this.settings.set(operation.key, cloneJson(operation.value));
        return { inverse: existed ? { op: 'setting.set', key: operation.key, value: previous! } : { op: 'setting.remove', key: operation.key }, projectionWork: 0 };
      }
      case 'setting.remove': {
        assertSettingKey(operation.key); if (!this.settings.has(operation.key)) throw new GameDocumentError('document.setting-missing', `Setting ${operation.key} does not exist.`); const previous = this.settings.get(operation.key)!; this.settings.delete(operation.key);
        return { inverse: { op: 'setting.set', key: operation.key, value: previous }, projectionWork: 0 };
      }
    }
  }

  private updateRoot(sceneId: string, entityId: string, add: boolean): void {
    const scene = required(this.scenes, sceneId, 'scene'); const roots = scene.rootEntityIds.filter((id) => id !== entityId); if (add) roots.push(entityId);
    this.scenes.set(sceneId, freezeScene({ ...scene, rootEntityIds: roots }));
  }

  private entityIdsById(): readonly string[] {
    if (!this.orderedEntityIds) this.orderedEntityIds = Object.freeze([...this.entities.keys()].sort((left, right) => left.localeCompare(right)));
    return this.orderedEntityIds;
  }

  private validateRelationships(): void {
    const owners = new Map<string, string>();
    const rootsByScene = new Map([...this.scenes.values()].map((scene) => [scene.id, new Set(scene.rootEntityIds)]));
    for (const scene of this.scenes.values()) for (const rootId of scene.rootEntityIds) { const entity = required(this.entities, rootId, 'root entity'); if (entity.sceneId !== scene.id || entity.parentId !== null) throw new GameDocumentError('document.scene-root-invalid', `Scene ${scene.id} has invalid root ${rootId}.`); }
    for (const entity of this.entities.values()) {
      required(this.scenes, entity.sceneId, 'scene');
      if (entity.parentId === null && !rootsByScene.get(entity.sceneId)!.has(entity.id)) throw new GameDocumentError('document.scene-root-missing', `Root entity ${entity.id} is not registered by scene ${entity.sceneId}.`);
      if (entity.parentId) { const parent = required(this.entities, entity.parentId, 'parent entity'); if (parent.sceneId !== entity.sceneId) throw new GameDocumentError('document.parent-cross-scene', `Entity ${entity.id} cannot parent across scenes.`); }
      for (const componentId of entity.componentIds) { required(this.components, componentId, 'component'); if (owners.has(componentId)) throw new GameDocumentError('document.component-owner-duplicate', `Component ${componentId} has multiple owners.`); owners.set(componentId, entity.id); }
    }
    for (const componentId of this.components.keys()) if (!owners.has(componentId)) throw new GameDocumentError('document.component-orphan', `Component ${componentId} has no entity owner.`);
    for (const script of this.scripts.values()) required(this.entities, script.entityId, 'script entity');
    for (const entity of this.entities.values()) {
      const visited = new Set<string>([entity.id]); let cursor = entity.parentId;
      while (cursor) { if (visited.has(cursor)) throw new GameDocumentError('document.parent-cycle', `Entity parent cycle includes ${cursor}.`); visited.add(cursor); cursor = required(this.entities, cursor, 'parent entity').parentId; }
    }
    this.componentOwners.clear(); for (const [componentId, entityId] of owners) this.componentOwners.set(componentId, entityId);
  }
}

export class GameDocumentError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'GameDocumentError'; } }

export function parseGameDocumentV2(value: unknown, registry: ComponentRegistry): GameDocumentV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.id !== 'string' || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.savedRevision) || !Array.isArray(value.scenes) || !Array.isArray(value.entities) || !Array.isArray(value.components) || !Array.isArray(value.scripts) || !Array.isArray(value.assets) || !isRecord(value.settings) || !isRecord(value.migration)) throw new GameDocumentError('document.schema-invalid', 'GameDocument v2 envelope is invalid.');
  exactKeys(value, ['schemaVersion', 'id', 'revision', 'savedRevision', 'scenes', 'entities', 'components', 'scripts', 'assets', 'settings', 'migration'], 'GameDocument');
  const document = deepFreeze({ ...value, id: asStableId(value.id, 'document id') }) as unknown as GameDocumentV2;
  return new GameDocumentStore(document.id as StableId, document, registry).export(document.savedRevision);
}

function freezeScene(value: Scene): Scene { exactKeys(value as unknown as Record<string, unknown>, ['id', 'name', 'rootEntityIds'], 'scene'); const id = asStableId(value.id, 'scene id'); if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128 || !Array.isArray(value.rootEntityIds)) throw new GameDocumentError('document.scene-invalid', `Scene ${id} is invalid.`); const roots = value.rootEntityIds.map((item) => asStableId(item, 'root entity id')); if (new Set(roots).size !== roots.length) throw new GameDocumentError('document.scene-root-duplicate', `Scene ${id} has duplicate roots.`); return Object.freeze({ id, name: value.name, rootEntityIds: Object.freeze(roots) }); }
function freezeEntity(value: GameEntity): GameEntity { exactKeys(value as unknown as Record<string, unknown>, ['id', 'sceneId', 'name', 'parentId', 'order', 'componentIds'], 'entity'); const id = asStableId(value.id, 'entity id'); const sceneId = asStableId(value.sceneId, 'scene id'); const parentId = value.parentId === null ? null : asStableId(value.parentId, 'parent entity id'); if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128 || !Number.isSafeInteger(value.order) || value.order < 0 || !Array.isArray(value.componentIds)) throw new GameDocumentError('document.entity-invalid', `Entity ${id} is invalid.`); const components = value.componentIds.map((item) => asStableId(item, 'component id')); if (new Set(components).size !== components.length) throw new GameDocumentError('document.entity-component-duplicate', `Entity ${id} contains duplicate components.`); return Object.freeze({ id, sceneId, name: value.name, parentId, order: value.order, componentIds: Object.freeze(components) }); }
function freezeScript(value: GameScript): GameScript { exactKeys(value as unknown as Record<string, unknown>, ['id', 'entityId', 'name', 'sourcePath', 'source', 'textRevision', 'enabled', 'order', 'capabilities', 'digest'], 'script'); const id = asStableId(value.id, 'script id'); const entityId = asStableId(value.entityId, 'script entity id'); if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128 || typeof value.sourcePath !== 'string' || !value.sourcePath || value.sourcePath.length > 512 || value.sourcePath.includes('..') || typeof value.source !== 'string' || value.source.length > 65_536 || !Number.isSafeInteger(value.textRevision) || value.textRevision < 0 || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.order) || value.order < 0 || !Array.isArray(value.capabilities) || !value.capabilities.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 64) || new Set(value.capabilities).size !== value.capabilities.length || value.digest !== `sha256:${sha256(value.source)}`) throw new GameDocumentError('document.script-invalid', `Script ${id} is invalid.`); return deepFreeze({ ...value, id, entityId, capabilities: [...value.capabilities] }) as GameScript; }
function freezeAsset(value: GameAsset): GameAsset { exactKeys(value as unknown as Record<string, unknown>, ['id', 'kind', 'digest', 'source'], 'asset'); const id = asStableId(value.id, 'asset id'); if (typeof value.kind !== 'string' || !value.kind || !/^sha256:[a-f0-9]{64}$/u.test(value.digest) || !['builtin', 'project', 'imported'].includes(value.source)) throw new GameDocumentError('document.asset-invalid', `Asset ${id} is invalid.`); return Object.freeze({ id, kind: value.kind, digest: value.digest, source: value.source }); }
function freezeMigration(value: GameDocumentV2['migration']): GameDocumentV2['migration'] { if (!value) throw new GameDocumentError('document.migration-invalid', 'Migration metadata is invalid.'); exactKeys(value as unknown as Record<string, unknown>, ['fromVersion', 'migratedAt', 'sourceDigest'], 'migration'); if ((value.fromVersion !== null && (!Number.isSafeInteger(value.fromVersion) || value.fromVersion < 1)) || (value.migratedAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value.migratedAt)) || (value.sourceDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(value.sourceDigest))) throw new GameDocumentError('document.migration-invalid', 'Migration metadata is invalid.'); return Object.freeze({ ...value }); }
function freezeOperation(value: GameDocumentOperationV2): GameDocumentOperationV2 { return deepFreeze(cloneJson(value) as unknown as GameDocumentOperationV2); }
function freezeObject(value: Record<string, JsonValue>): JsonObject { return deepFreeze(value); }
function compareById<T extends { readonly id: string }>(left: T, right: T): number { return left.id.localeCompare(right.id); }
function required<T>(map: ReadonlyMap<string, T>, id: string, label: string): T { const value = map.get(id); if (!value) throw new GameDocumentError(`document.${label.replaceAll(' ', '-')}-missing`, `${label} ${id} does not exist.`); return value; }
function insertUnique<T>(map: Map<string, T>, id: string, value: T, label: string): void { if (map.has(id)) duplicate(label, id); map.set(id, value); }
function duplicate(label: string, id: string): never { throw new GameDocumentError(`document.${label}-duplicate`, `${label} ${id} already exists.`); }
function revision(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new GameDocumentError('document.revision-invalid', `${label} is invalid.`); return value; }
function exactPatch(value: unknown, allowed: readonly string[]): void { if (!isRecord(value)) throw new GameDocumentError('document.patch-invalid', 'Entity patch must be an object.'); const set = new Set(allowed); for (const key of Object.keys(value)) if (!set.has(key)) throw new GameDocumentError('document.patch-field-unknown', `Entity patch field ${key} is unknown.`); if (Object.keys(value).length === 0) throw new GameDocumentError('document.patch-empty', 'Entity patch cannot be empty.'); }
function exactKeys(value: unknown, allowed: readonly string[], label: string): void { if (!isRecord(value)) throw new GameDocumentError('document.schema-invalid', `${label} must be an object.`); const set = new Set(allowed); for (const key of Object.keys(value)) if (!set.has(key)) throw new GameDocumentError('document.unknown-field', `${label} contains unknown field ${key}.`); }
function assertSettingKey(key: string): void { if (!/^[a-z][a-z0-9.-]{1,63}$/u.test(key)) throw new GameDocumentError('document.setting-key-invalid', `Invalid project setting key ${key}.`); }
function encodeCursor(offset: number): string { return Buffer.from(String(offset), 'utf8').toString('base64url'); }
function decodeCursor(value?: string): number { if (!value) return 0; const decoded = Number(Buffer.from(value, 'base64url').toString('utf8')); if (!Number.isSafeInteger(decoded) || decoded < 0) throw new GameDocumentError('document.query-cursor-invalid', 'Query cursor is invalid.'); return decoded; }
function jsonBytes(value: unknown): number { return Buffer.byteLength(canonicalStringify(value as JsonValue)); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function cloneJson(value: unknown): JsonValue { if (Array.isArray(value)) return value.map(cloneJson); if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)])); if (value === null || typeof value === 'boolean' || typeof value === 'string') return value; if (typeof value === 'number' && Number.isFinite(value)) return value; throw new GameDocumentError('document.json-invalid', 'Document data must be finite JSON.'); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }

function setPath(root: JsonObject, path: readonly string[], value: JsonValue, allowEmpty: boolean): Readonly<{ value: JsonObject; existed: boolean; previous?: JsonValue }> {
  validatePath(path, allowEmpty); const next = cloneJson(root) as Record<string, JsonValue>; let cursor = next; let source: Record<string, JsonValue> = root as Record<string, JsonValue>;
  for (let index = 0; index < path.length - 1; index += 1) { const key = path[index]!; const sourceChild = source[key]; if (!isRecord(sourceChild)) throw new GameDocumentError('document.component-path-invalid', `Component path ${path.join('.')} is invalid.`); const child = cloneJson(sourceChild) as Record<string, JsonValue>; cursor[key] = child; cursor = child; source = sourceChild as Record<string, JsonValue>; }
  const key = path.at(-1)!; const existed = Object.hasOwn(source, key); const previous = existed ? cloneJson(source[key]) : undefined; cursor[key] = cloneJson(value); return { value: deepFreeze(next), existed, ...(previous === undefined ? {} : { previous }) };
}
function unsetPath(root: JsonObject, path: readonly string[]): Readonly<{ value: JsonObject; existed: boolean; previous?: JsonValue }> { const result = setPath(root, path, null, false); const next = cloneJson(result.value) as Record<string, JsonValue>; let cursor = next; for (let index = 0; index < path.length - 1; index += 1) cursor = cursor[path[index]!] as Record<string, JsonValue>; delete cursor[path.at(-1)!]; return { value: deepFreeze(next), existed: result.existed, ...(result.previous === undefined ? {} : { previous: result.previous }) }; }
function validatePath(path: readonly string[], allowEmpty: boolean): void { if ((!allowEmpty && path.length < 1) || path.length > 16 || path.some((key) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key))) throw new GameDocumentError('document.component-path-invalid', 'Component path is invalid.'); }
function isStructuralOperation(operation: GameDocumentOperationV2): boolean { return operation.op === 'scene.add' || operation.op === 'scene.remove' || operation.op === 'entity.add' || operation.op === 'entity.update' || operation.op === 'entity.remove' || operation.op === 'component.add' || operation.op === 'component.remove' || operation.op === 'script.upsert' || operation.op === 'script.remove'; }
