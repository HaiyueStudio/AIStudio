import {
  asStableId,
  type GameDocumentDeltaV2,
  type GameDocumentOperationV2,
  type GameDocumentV2,
  type JsonObject,
  type JsonValue,
  type M13Digest,
  type M13StableId,
  type SceneDiffV1,
  type StableId,
} from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const DEFAULT_RETAINED_DELTAS = 2_048;
const CAMERA_SETTING = 'studio.camera.main';
const ALL_PROJECTIONS = Object.freeze(['hierarchy', 'components', 'scripts', 'assets', 'camera', 'render', 'settings'] as const);
const PRIVATE_SETTING_KEYS = new Set(['script.resources', 'studio.prefabs.v1', 'studio.assemblies.v1']);

export type SceneContextProjection = typeof ALL_PROJECTIONS[number];

export interface SceneContextScope {
  readonly sceneId?: StableId;
  readonly entityIds?: readonly StableId[];
  readonly componentTypes?: readonly StableId[];
}

export interface SceneQueryInput {
  readonly revision?: number;
  readonly scope?: SceneContextScope;
  readonly projection?: readonly SceneContextProjection[];
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SceneQueryItem {
  readonly kind: 'entity' | 'component' | 'script' | 'asset' | 'camera' | 'render-setting' | 'setting';
  readonly id: StableId;
  readonly value: JsonObject;
}

export interface SceneQueryResult {
  readonly schemaVersion: 1;
  readonly documentId: StableId;
  readonly revision: number;
  readonly retainedFromRevision: number;
  readonly projection: readonly SceneContextProjection[];
  readonly items: readonly SceneQueryItem[];
  readonly totalItems: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly digest: M13Digest;
  readonly snapshotDigest: M13Digest;
}

export interface SceneDiffInput {
  readonly fromRevision: number;
  readonly toRevision?: number;
  readonly scope?: SceneContextScope;
  readonly projection?: readonly SceneContextProjection[];
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SceneDiffResult {
  readonly schemaVersion: 1;
  readonly diff: SceneDiffV1;
  readonly retainedFromRevision: number;
  readonly targetSnapshotDigest: M13Digest;
  readonly totalChanges: number;
  readonly projection: readonly SceneContextProjection[];
}

export interface SceneRevisionRecordInput {
  readonly delta: GameDocumentDeltaV2;
  readonly target: GameDocumentV2;
  readonly provenanceOpIds?: readonly StableId[];
}

interface RevisionRecord {
  readonly delta: GameDocumentDeltaV2;
  readonly provenanceOpIds: readonly StableId[];
}

interface CursorPayload {
  readonly version: 1;
  readonly kind: 'scene-query' | 'scene-diff';
  readonly documentId: StableId;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly fingerprint: string;
  readonly offset: number;
}

type DiffEntry =
  | Readonly<{ kind: 'added-entity'; value: M13StableId }>
  | Readonly<{ kind: 'removed-entity'; value: M13StableId }>
  | Readonly<{ kind: 'changed-entity'; value: SceneDiffV1['changedEntities'][number] }>
  | Readonly<{ kind: 'reordered-entity'; value: M13StableId }>
  | Readonly<{ kind: 'component-patch'; value: SceneDiffV1['componentPatches'][number] }>
  | Readonly<{ kind: 'script-change'; value: SceneDiffV1['scriptChanges'][number] }>
  | Readonly<{ kind: 'asset-change'; value: SceneDiffV1['assetChanges'][number] }>
  | Readonly<{ kind: 'camera-change'; value: SceneDiffV1['cameraChanges'][number] }>
  | Readonly<{ kind: 'render-change'; value: SceneDiffV1['renderChanges'][number] }>
  | Readonly<{ kind: 'setting-change'; value: string }>
  | Readonly<{ kind: 'tombstone'; value: M13StableId }>;

export class SceneContextError extends Error {
  constructor(readonly code: string, message: string, readonly recoverable: boolean) { super(message); this.name = 'SceneContextError'; }
}

/**
 * Project-owned revision index. It retains one immutable base snapshot plus bounded
 * Document deltas, so Scene reads never inspect the live Engine World.
 */
export class SceneContextRuntime {
  private base: GameDocumentV2 | null = null;
  private records: RevisionRecord[] = [];

  constructor(private readonly maxRetainedDeltas = DEFAULT_RETAINED_DELTAS) {
    if (!Number.isSafeInteger(maxRetainedDeltas) || maxRetainedDeltas < 1 || maxRetainedDeltas > 100_000) throw new TypeError('Scene retained delta limit is invalid.');
  }

  reset(snapshot: GameDocumentV2 | null): void {
    this.base = snapshot ? freezeDocument(snapshot) : null;
    this.records = [];
  }

  record(input: SceneRevisionRecordInput): void {
    const target = freezeDocument(input.target);
    if (!this.base || this.base.id !== target.id || this.latestRevision() !== input.delta.beforeRevision
      || input.delta.documentId !== target.id || input.delta.afterRevision !== target.revision) {
      this.reset(target);
      return;
    }
    try {
      const replayed = applyOperations(this.atRevision(input.delta.beforeRevision), input.delta.operations, input.delta.afterRevision);
      if (digestValue(replayed as unknown as JsonValue) !== digestValue(target as unknown as JsonValue)) {
        this.reset(target);
        return;
      }
    } catch {
      this.reset(target);
      return;
    }
    this.records.push(Object.freeze({ delta: freezeDelta(input.delta), provenanceOpIds: freezeIds(input.provenanceOpIds ?? []) }));
    while (this.records.length > this.maxRetainedDeltas) {
      const oldest = this.records.shift()!;
      this.base = applyOperations(this.base, oldest.delta.operations, oldest.delta.afterRevision);
    }
  }

  query(input: SceneQueryInput = {}): SceneQueryResult {
    const current = this.requireCurrent();
    const revision = normalizedRevision(input.revision ?? current.revision, 'query revision');
    const snapshot = this.atRevision(revision);
    const projection = normalizeProjection(input.projection);
    const scope = normalizeScope(input.scope);
    const items = queryItems(snapshot, scope, projection);
    const fingerprint = digestValue({ scope: scope as unknown as JsonValue, projection: projection as unknown as JsonValue });
    const documentId = asStableId(snapshot.id);
    const offset = cursorOffset(input.cursor, { kind: 'scene-query', documentId, fromRevision: revision, toRevision: revision, fingerprint });
    const limit = normalizeLimit(input.limit);
    const page = Object.freeze(items.slice(offset, offset + limit));
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < items.length ? encodeCursor({ version: 1, kind: 'scene-query', documentId, fromRevision: revision, toRevision: revision, fingerprint, offset: nextOffset }) : null;
    return deepFreeze({
      schemaVersion: 1,
      documentId,
      revision,
      retainedFromRevision: this.retainedFromRevision(),
      projection,
      items: page,
      totalItems: items.length,
      truncated: nextCursor !== null,
      nextCursor,
      digest: digestValue(items as unknown as JsonValue),
      snapshotDigest: safeSnapshotDigest(snapshot),
    });
  }

  diff(input: SceneDiffInput): SceneDiffResult {
    const current = this.requireCurrent();
    const fromRevision = normalizedRevision(input.fromRevision, 'diff base revision');
    const toRevision = normalizedRevision(input.toRevision ?? current.revision, 'diff target revision');
    if (fromRevision > toRevision) throw new SceneContextError('scene.diff-range-invalid', 'Scene diff base revision cannot exceed target revision.', false);
    const before = this.atRevision(fromRevision);
    const after = this.atRevision(toRevision);
    const projection = normalizeProjection(input.projection);
    const scope = normalizeScope(input.scope);
    const complete = calculateDiff(before, after, this.recordsForRange(fromRevision, toRevision), scope, projection);
    const entries = flattenDiff(complete);
    const fingerprint = digestValue({ scope: scope as unknown as JsonValue, projection: projection as unknown as JsonValue });
    const documentId = asStableId(after.id);
    const offset = cursorOffset(input.cursor, { kind: 'scene-diff', documentId, fromRevision, toRevision, fingerprint });
    const limit = normalizeLimit(input.limit);
    const pageEntries = entries.slice(offset, offset + limit);
    const nextOffset = offset + pageEntries.length;
    const nextCursor = nextOffset < entries.length ? encodeCursor({ version: 1, kind: 'scene-diff', documentId, fromRevision, toRevision, fingerprint, offset: nextOffset }) : null;
    const page = pageDiff(complete, pageEntries, nextCursor);
    return deepFreeze({ schemaVersion: 1, diff: page, retainedFromRevision: this.retainedFromRevision(), targetSnapshotDigest: safeSnapshotDigest(after), totalChanges: entries.length, projection });
  }

  retainedFromRevision(): number { return this.base?.revision ?? 0; }
  latestRevision(): number { return this.records.at(-1)?.delta.afterRevision ?? this.base?.revision ?? 0; }

  private requireCurrent(): GameDocumentV2 {
    if (!this.base) throw new SceneContextError('scene.document-missing', 'No project document is open.', true);
    return this.atRevision(this.latestRevision());
  }

  private atRevision(revision: number): GameDocumentV2 {
    if (!this.base) throw new SceneContextError('scene.document-missing', 'No project document is open.', true);
    if (revision < this.base.revision) throw new SceneContextError('scene.history-pruned', `Scene revision ${revision} predates retained revision ${this.base.revision}; request a bounded snapshot and resume from it.`, true);
    const latest = this.latestRevision();
    if (revision > latest) throw new SceneContextError('scene.revision-future', `Scene revision ${revision} is newer than current revision ${latest}.`, true);
    let snapshot = this.base;
    for (const record of this.records) {
      if (record.delta.afterRevision > revision) break;
      if (record.delta.beforeRevision !== snapshot.revision) throw new SceneContextError('scene.revision-gap', `Scene history has a gap after revision ${snapshot.revision}.`, true);
      snapshot = applyOperations(snapshot, record.delta.operations, record.delta.afterRevision);
    }
    if (snapshot.revision !== revision) throw new SceneContextError('scene.revision-gap', `Scene revision ${revision} is unavailable in retained history.`, true);
    return snapshot;
  }

  private recordsForRange(fromRevision: number, toRevision: number): readonly RevisionRecord[] {
    return Object.freeze(this.records.filter((record) => record.delta.beforeRevision >= fromRevision && record.delta.afterRevision <= toRevision));
  }
}

function queryItems(snapshot: GameDocumentV2, scope: SceneContextScope, projection: readonly SceneContextProjection[]): readonly SceneQueryItem[] {
  const entityIds = selectedEntityIds(snapshot, scope);
  const selectedComponents = snapshot.components.filter((component) => entityIds.has(componentOwner(snapshot, component.id) ?? '') && (!scope.componentTypes || scope.componentTypes.includes(asStableId(component.type))));
  const items: SceneQueryItem[] = [];
  if (projection.includes('hierarchy')) for (const entity of snapshot.entities.filter((item) => entityIds.has(item.id)).sort(compareByOrder)) items.push(item('entity', asStableId(entity.id), {
    sceneId: entity.sceneId, name: entity.name, parentId: entity.parentId, order: entity.order,
    componentIds: Object.freeze(entity.componentIds.filter((id) => selectedComponents.some((component) => component.id === id))),
  }));
  if (projection.includes('components')) for (const component of selectedComponents.sort(compareById)) items.push(item('component', asStableId(component.id), {
    entityId: componentOwner(snapshot, component.id), type: component.type, version: component.version, enabled: component.enabled, value: component.value,
  }));
  if (projection.includes('scripts')) for (const script of snapshot.scripts.filter((entry) => entityIds.has(entry.entityId)).sort(compareById)) items.push(item('script', asStableId(script.id), {
    entityId: script.entityId, name: script.name, sourcePath: script.sourcePath, textRevision: script.textRevision, enabled: script.enabled, order: script.order, capabilities: script.capabilities, digest: script.digest,
  }));
  if (projection.includes('assets')) for (const asset of [...snapshot.assets].sort(compareById)) items.push(item('asset', asStableId(asset.id), { kind: asset.kind, digest: asset.digest, source: asset.source }));
  const settings = Object.entries(snapshot.settings).sort(([left], [right]) => left.localeCompare(right));
  if (projection.includes('camera') && Object.hasOwn(snapshot.settings, CAMERA_SETTING)) items.push(item('camera', asStableId('camera:main'), { key: CAMERA_SETTING, value: snapshot.settings[CAMERA_SETTING]! }));
  if (projection.includes('render')) for (const [key, value] of settings.filter(([key]) => isRenderSetting(key))) items.push(item('render-setting', settingId('render-setting', key), { key, value }));
  if (projection.includes('settings')) for (const [key, value] of settings.filter(([key]) => key !== CAMERA_SETTING && !isRenderSetting(key) && !PRIVATE_SETTING_KEYS.has(key))) items.push(item('setting', settingId('setting', key), { key, value }));
  return Object.freeze(items);
}

function calculateDiff(before: GameDocumentV2, after: GameDocumentV2, records: readonly RevisionRecord[], scope: SceneContextScope, projection: readonly SceneContextProjection[]): SceneDiffV1 {
  const beforeEntityIds = selectedEntityIds(before, scope); const afterEntityIds = selectedEntityIds(after, scope); const entityIds = new Set([...beforeEntityIds, ...afterEntityIds]);
  const oldEntities = byId(before.entities); const newEntities = byId(after.entities);
  const addedEntityIds = projection.includes('hierarchy') ? [...afterEntityIds].filter((id) => !oldEntities.has(id)).sort() : [];
  const removedEntityIds = projection.includes('hierarchy') ? [...beforeEntityIds].filter((id) => !newEntities.has(id)).sort() : [];
  const changedEntities: SceneDiffV1['changedEntities'][number][] = []; const reorderedEntityIds: M13StableId[] = [];
  if (projection.includes('hierarchy')) for (const id of [...entityIds].sort()) {
    const previous = oldEntities.get(id); const current = newEntities.get(id); if (!previous || !current) continue;
    const paths = diffPaths(entityProjection(previous), entityProjection(current)); if (paths.length) changedEntities.push(Object.freeze({ entityId: id as M13StableId, paths }));
    if (previous.order !== current.order) reorderedEntityIds.push(id as M13StableId);
  }
  const oldComponents = byId(before.components); const newComponents = byId(after.components); const componentPatches: SceneDiffV1['componentPatches'][number][] = [];
  if (projection.includes('components')) for (const [id, current] of [...newComponents].sort(([left], [right]) => left.localeCompare(right))) {
    const owner = componentOwner(after, id); if (!owner || !entityIds.has(owner) || (scope.componentTypes && !scope.componentTypes.includes(asStableId(current.type)))) continue;
    const previous = oldComponents.get(id); const paths = previous ? diffPaths(componentProjection(previous), componentProjection(current)) : Object.freeze(['$added']);
    if (paths.length) componentPatches.push(Object.freeze({ componentId: id as M13StableId, entityId: owner as M13StableId, paths, digest: digestValue(componentProjection(current) as unknown as JsonValue) }));
  }
  const scriptChanges = projection.includes('scripts') ? resourceChanges(before.scripts.filter((item) => entityIds.has(item.entityId)), after.scripts.filter((item) => entityIds.has(item.entityId)), 'scriptId') : [];
  const assetChanges: SceneDiffV1['assetChanges'][number][] = projection.includes('assets') ? [...resourceChanges(before.assets, after.assets, 'assetId')] : [];
  if (projection.includes('assets')) {
    const oldDependencies = assetDependencies(before, entityIds); const newDependencies = assetDependencies(after, entityIds); const assets = byId(after.assets);
    for (const assetId of [...new Set([...oldDependencies.keys(), ...newDependencies.keys()])].sort()) {
      if (canonicalStringify([...(oldDependencies.get(assetId) ?? [])].sort() as unknown as JsonValue) === canonicalStringify([...(newDependencies.get(assetId) ?? [])].sort() as unknown as JsonValue) || assetChanges.some((entry) => entry.assetId === assetId)) continue;
      const asset = assets.get(assetId); assetChanges.push(Object.freeze({ assetId: assetId as M13StableId, change: asset ? 'updated' : 'removed', digest: asset?.digest as M13Digest ?? null }));
    }
  }
  const cameraChanges: SceneDiffV1['cameraChanges'][number][] = [];
  if (projection.includes('camera')) pushSettingChange(cameraChanges, before.settings[CAMERA_SETTING], after.settings[CAMERA_SETTING], asStableId('camera:main'), 'cameraId');
  if (projection.includes('camera')) for (const componentId of [...new Set([...oldComponents.keys(), ...newComponents.keys()])].sort()) {
    const previous = oldComponents.get(componentId); const current = newComponents.get(componentId); const component = current ?? previous;
    if (!component || !component.type.startsWith('haiyue.camera.')) continue;
    const owner = componentOwner(after, componentId) ?? componentOwner(before, componentId); if (!owner || !entityIds.has(owner)) continue;
    if (previous && current && canonicalStringify(componentProjection(previous) as unknown as JsonValue) === canonicalStringify(componentProjection(current) as unknown as JsonValue)) continue;
    cameraChanges.push(Object.freeze({ cameraId: componentId as M13StableId, change: !previous ? 'added' : !current ? 'removed' : 'updated', paths: diffPaths(previous ? componentProjection(previous) : null, current ? componentProjection(current) : null), digest: current ? digestValue(componentProjection(current) as unknown as JsonValue) : null }));
  }
  const renderChanges: SceneDiffV1['renderChanges'][number][] = [];
  if (projection.includes('render')) {
    const keys = new Set([...Object.keys(before.settings).filter(isRenderSetting), ...Object.keys(after.settings).filter(isRenderSetting)]);
    for (const key of [...keys].sort()) pushSettingChange(renderChanges, before.settings[key], after.settings[key], settingId('render', key), 'scopeId');
    for (const componentId of [...new Set([...oldComponents.keys(), ...newComponents.keys()])].sort()) {
      const previous = oldComponents.get(componentId); const current = newComponents.get(componentId); const component = current ?? previous;
      if (!component || !isRenderComponent(component.type)) continue;
      const owner = componentOwner(after, componentId) ?? componentOwner(before, componentId); if (!owner || !entityIds.has(owner)) continue;
      if (previous && current && canonicalStringify(componentProjection(previous) as unknown as JsonValue) === canonicalStringify(componentProjection(current) as unknown as JsonValue)) continue;
      renderChanges.push(Object.freeze({ scopeId: owner as M13StableId, change: !previous ? 'added' : !current ? 'removed' : 'updated', paths: diffPaths(previous ? componentProjection(previous) : null, current ? componentProjection(current) : null), digest: current ? digestValue(componentProjection(current) as unknown as JsonValue) : null }));
    }
  }
  const settingsChanged = projection.includes('settings') ? changedSettingKeys(before.settings, after.settings).filter((key) => key !== CAMERA_SETTING && !isRenderSetting(key) && !PRIVATE_SETTING_KEYS.has(key)) : [];
  const removedComponentIds = projection.includes('components') ? [...oldComponents.keys()].filter((id) => !newComponents.has(id) && entityIds.has(componentOwner(before, id) ?? '')) : [];
  const tombstoneIds = freezeIds([...removedEntityIds, ...removedComponentIds, ...scriptChanges.filter((entry) => entry.change === 'removed').map((entry) => entry.scriptId), ...assetChanges.filter((entry) => entry.change === 'removed').map((entry) => entry.assetId)]);
  const body = {
    schemaVersion: 1 as const, documentId: after.id as M13StableId, fromRevision: before.revision, toRevision: after.revision,
    transactionIds: freezeIds(records.map((record) => record.delta.transactionId)) as readonly M13StableId[],
    addedEntityIds: Object.freeze(addedEntityIds) as readonly M13StableId[], removedEntityIds: Object.freeze(removedEntityIds) as readonly M13StableId[],
    changedEntities: Object.freeze(changedEntities), reorderedEntityIds: Object.freeze(reorderedEntityIds), componentPatches: Object.freeze(componentPatches),
    scriptChanges: Object.freeze(scriptChanges), assetChanges: Object.freeze(assetChanges), cameraChanges: Object.freeze(cameraChanges), renderChanges: Object.freeze(renderChanges),
    settingsChanged: Object.freeze(settingsChanged), tombstoneIds: tombstoneIds as readonly M13StableId[], provenanceOpIds: freezeIds(records.flatMap((record) => [...record.provenanceOpIds])) as readonly M13StableId[],
  };
  return deepFreeze({ ...body, truncated: false, nextCursor: null, digest: digestValue(body as unknown as JsonValue) });
}

function flattenDiff(diff: SceneDiffV1): readonly DiffEntry[] {
  return Object.freeze([
    ...diff.addedEntityIds.map((value) => Object.freeze({ kind: 'added-entity' as const, value })),
    ...diff.removedEntityIds.map((value) => Object.freeze({ kind: 'removed-entity' as const, value })),
    ...diff.changedEntities.map((value) => Object.freeze({ kind: 'changed-entity' as const, value })),
    ...diff.reorderedEntityIds.map((value) => Object.freeze({ kind: 'reordered-entity' as const, value })),
    ...diff.componentPatches.map((value) => Object.freeze({ kind: 'component-patch' as const, value })),
    ...diff.scriptChanges.map((value) => Object.freeze({ kind: 'script-change' as const, value })),
    ...diff.assetChanges.map((value) => Object.freeze({ kind: 'asset-change' as const, value })),
    ...diff.cameraChanges.map((value) => Object.freeze({ kind: 'camera-change' as const, value })),
    ...diff.renderChanges.map((value) => Object.freeze({ kind: 'render-change' as const, value })),
    ...diff.settingsChanged.map((value) => Object.freeze({ kind: 'setting-change' as const, value })),
    ...diff.tombstoneIds.map((value) => Object.freeze({ kind: 'tombstone' as const, value })),
  ]);
}

function pageDiff(complete: SceneDiffV1, entries: readonly DiffEntry[], nextCursor: string | null): SceneDiffV1 {
  const values = (kind: DiffEntry['kind']): readonly DiffEntry[] => entries.filter((entry) => entry.kind === kind);
  return deepFreeze({
    ...complete,
    addedEntityIds: values('added-entity').map((entry) => entry.value as M13StableId),
    removedEntityIds: values('removed-entity').map((entry) => entry.value as M13StableId),
    changedEntities: values('changed-entity').map((entry) => entry.value as SceneDiffV1['changedEntities'][number]),
    reorderedEntityIds: values('reordered-entity').map((entry) => entry.value as M13StableId),
    componentPatches: values('component-patch').map((entry) => entry.value as SceneDiffV1['componentPatches'][number]),
    scriptChanges: values('script-change').map((entry) => entry.value as SceneDiffV1['scriptChanges'][number]),
    assetChanges: values('asset-change').map((entry) => entry.value as SceneDiffV1['assetChanges'][number]),
    cameraChanges: values('camera-change').map((entry) => entry.value as SceneDiffV1['cameraChanges'][number]),
    renderChanges: values('render-change').map((entry) => entry.value as SceneDiffV1['renderChanges'][number]),
    settingsChanged: values('setting-change').map((entry) => entry.value as string),
    tombstoneIds: values('tombstone').map((entry) => entry.value as M13StableId),
    truncated: nextCursor !== null, nextCursor,
  });
}

function applyOperations(snapshot: GameDocumentV2, operations: readonly GameDocumentOperationV2[], revision: number): GameDocumentV2 {
  const scenes = new Map(snapshot.scenes.map((entry) => [entry.id, cloneJson(entry) as unknown as GameDocumentV2['scenes'][number]]));
  const entities = new Map(snapshot.entities.map((entry) => [entry.id, cloneJson(entry) as unknown as GameDocumentV2['entities'][number]]));
  const components = new Map(snapshot.components.map((entry) => [entry.id, cloneJson(entry) as unknown as GameDocumentV2['components'][number]]));
  const scripts = new Map(snapshot.scripts.map((entry) => [entry.id, cloneJson(entry) as unknown as GameDocumentV2['scripts'][number]]));
  const assets = new Map(snapshot.assets.map((entry) => [entry.id, cloneJson(entry) as unknown as GameDocumentV2['assets'][number]]));
  const settings: Record<string, JsonValue> = cloneJson(snapshot.settings) as Record<string, JsonValue>;
  const updateRoot = (sceneId: string, entityId: string, add: boolean): void => {
    const scene = scenes.get(sceneId); if (!scene) throw new Error(`Scene ${sceneId} is missing while replaying a Scene delta.`);
    const roots = scene.rootEntityIds.filter((id) => id !== entityId); if (add) roots.push(entityId);
    scenes.set(sceneId, { ...scene, rootEntityIds: Object.freeze(roots) });
  };
  for (const operation of operations) switch (operation.op) {
    case 'scene.add': scenes.set(operation.scene.id, cloneJson(operation.scene) as unknown as GameDocumentV2['scenes'][number]); break;
    case 'scene.remove': scenes.delete(operation.sceneId); break;
    case 'entity.add': { const entity = cloneJson(operation.entity) as unknown as GameDocumentV2['entities'][number]; entities.set(entity.id, entity); if (entity.parentId === null) updateRoot(entity.sceneId, entity.id, true); break; }
    case 'entity.update': { const previous = entities.get(operation.entityId); if (previous) { const current = { ...previous, ...operation.patch }; entities.set(operation.entityId, current); if (previous.parentId !== current.parentId) { updateRoot(previous.sceneId, previous.id, false); if (current.parentId === null) updateRoot(current.sceneId, current.id, true); } } break; }
    case 'entity.remove': { const entity = entities.get(operation.entityId); if (entity) { entities.delete(operation.entityId); updateRoot(entity.sceneId, entity.id, false); } break; }
    case 'component.add': { components.set(operation.component.id, cloneJson(operation.component) as unknown as GameDocumentV2['components'][number]); const entity = entities.get(operation.entityId); if (entity) entities.set(entity.id, { ...entity, componentIds: Object.freeze([...entity.componentIds, operation.component.id]) }); break; }
    case 'component.remove': { components.delete(operation.componentId); const entity = entities.get(operation.entityId); if (entity) entities.set(entity.id, { ...entity, componentIds: Object.freeze(entity.componentIds.filter((id) => id !== operation.componentId)) }); break; }
    case 'component.replace': components.set(operation.component.id, cloneJson(operation.component) as unknown as GameDocumentV2['components'][number]); break;
    case 'component.patch': { const component = components.get(operation.componentId); if (component) components.set(component.id, { ...component, value: setJsonPath(component.value, operation.path, operation.value, false) }); break; }
    case 'component.unset': { const component = components.get(operation.componentId); if (component) components.set(component.id, { ...component, value: setJsonPath(component.value, operation.path, undefined, true) }); break; }
    case 'script.upsert': scripts.set(operation.script.id, cloneJson(operation.script) as unknown as GameDocumentV2['scripts'][number]); break;
    case 'script.remove': scripts.delete(operation.scriptId); break;
    case 'asset.upsert': assets.set(operation.asset.id, cloneJson(operation.asset) as unknown as GameDocumentV2['assets'][number]); break;
    case 'asset.remove': assets.delete(operation.assetId); break;
    case 'setting.set': settings[operation.key] = cloneJson(operation.value); break;
    case 'setting.remove': delete settings[operation.key]; break;
  }
  return freezeDocument({
    ...snapshot,
    revision,
    scenes: [...scenes.values()].sort(compareById),
    entities: [...entities.values()].sort(compareById),
    components: [...components.values()].sort(compareById),
    scripts: [...scripts.values()].sort(compareById),
    assets: [...assets.values()].sort(compareById),
    settings,
  });
}

function selectedEntityIds(snapshot: GameDocumentV2, scope: SceneContextScope): Set<string> {
  const requested = scope.entityIds ? new Set(scope.entityIds) : null;
  const matches = snapshot.entities.filter((entity) => (!scope.sceneId || entity.sceneId === scope.sceneId) && (!requested || requested.has(asStableId(entity.id))) && (!scope.componentTypes || scope.componentTypes.some((type) => entity.componentIds.some((id) => String(snapshot.components.find((component) => component.id === id)?.type) === String(type)))));
  return new Set(matches.map((entity) => entity.id));
}

function resourceChanges<T extends Readonly<{ id: string; digest: string }>, K extends 'scriptId' | 'assetId'>(before: readonly T[], after: readonly T[], idKey: K): readonly (K extends 'scriptId' ? SceneDiffV1['scriptChanges'][number] : SceneDiffV1['assetChanges'][number])[] {
  const previous = byId(before); const current = byId(after); const result: Array<Record<string, unknown>> = [];
  for (const id of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
    const oldValue = previous.get(id); const newValue = current.get(id); if (oldValue && newValue && canonicalStringify(oldValue as unknown as JsonValue) === canonicalStringify(newValue as unknown as JsonValue)) continue;
    result.push(Object.freeze({ [idKey]: id, change: !oldValue ? 'added' : !newValue ? 'removed' : 'updated', digest: newValue?.digest ?? null }));
  }
  return Object.freeze(result) as never;
}

function pushSettingChange<T extends { readonly change: 'added' | 'updated' | 'removed'; readonly paths: readonly string[]; readonly digest: M13Digest | null }>(target: T[], before: JsonValue | undefined, after: JsonValue | undefined, id: StableId, idKey: 'cameraId' | 'scopeId'): void {
  if (canonicalStringify(before ?? null) === canonicalStringify(after ?? null)) return;
  target.push(Object.freeze({ [idKey]: id, change: before === undefined ? 'added' : after === undefined ? 'removed' : 'updated', paths: diffPaths(before ?? null, after ?? null), digest: after === undefined ? null : digestValue(after) }) as unknown as T);
}

function changedSettingKeys(before: JsonObject, after: JsonObject): string[] { return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => canonicalStringify(before[key] ?? null) !== canonicalStringify(after[key] ?? null)).sort(); }
function entityProjection(value: GameDocumentV2['entities'][number]): JsonObject { return { name: value.name, parentId: value.parentId, order: value.order, sceneId: value.sceneId, componentIds: value.componentIds }; }
function componentProjection(value: GameDocumentV2['components'][number]): JsonObject { return { type: value.type, version: value.version, enabled: value.enabled, value: value.value }; }
function assetDependencies(snapshot: GameDocumentV2, entityIds: ReadonlySet<string>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const component of snapshot.components) {
    const owner = componentOwner(snapshot, component.id); if (!owner || !entityIds.has(owner)) continue;
    collectAssetReferences(component.value, `${owner}/${component.id}`, result);
  }
  return result;
}
function collectAssetReferences(value: JsonValue, path: string, result: Map<string, Set<string>>): void {
  if (typeof value === 'string' && value.startsWith('asset:')) { const id = asStableId(value); const paths = result.get(id) ?? new Set<string>(); paths.add(path); result.set(id, paths); return; }
  if (Array.isArray(value)) { value.forEach((entry, index) => collectAssetReferences(entry, `${path}/${index}`, result)); return; }
  if (isRecord(value)) for (const [key, entry] of Object.entries(value)) collectAssetReferences(entry as JsonValue, `${path}/${key}`, result);
}
function componentOwner(snapshot: GameDocumentV2, componentId: string): StableId | null { const value = snapshot.entities.find((entity) => entity.componentIds.includes(componentId))?.id; return value ? asStableId(value) : null; }
function safeSnapshotDigest(snapshot: GameDocumentV2): M13Digest { return digestValue({ ...snapshot, scripts: snapshot.scripts.map(({ source: _source, ...script }) => script) } as unknown as JsonValue); }
function isRenderComponent(type: string): boolean { return type.startsWith('haiyue.render.') || type.startsWith('haiyue.light.'); }
function isRenderSetting(key: string): boolean { return key.startsWith('studio.render.') || key.startsWith('studio.postprocess.'); }
function settingId(prefix: string, key: string): StableId { return asStableId(`${prefix}:${sha256(key).slice(0, 24)}`); }
function item(kind: SceneQueryItem['kind'], id: StableId, value: JsonObject): SceneQueryItem { return deepFreeze({ kind, id, value }); }
function byId<T extends Readonly<{ id: string }>>(values: readonly T[]): Map<string, T> { return new Map(values.map((value) => [value.id, value])); }
function compareById<T extends Readonly<{ id: string }>>(left: T, right: T): number { return left.id.localeCompare(right.id); }
function compareByOrder<T extends Readonly<{ order: number; id: string }>>(left: T, right: T): number { return left.order - right.order || left.id.localeCompare(right.id); }

function normalizeProjection(value: readonly SceneContextProjection[] | undefined): readonly SceneContextProjection[] {
  const requested = value ?? ALL_PROJECTIONS;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > ALL_PROJECTIONS.length || requested.some((entry) => !ALL_PROJECTIONS.includes(entry)) || new Set(requested).size !== requested.length) throw new SceneContextError('scene.projection-invalid', 'Scene projection is invalid.', false);
  return Object.freeze(ALL_PROJECTIONS.filter((entry) => requested.includes(entry)));
}
function normalizeScope(value: SceneContextScope | undefined): SceneContextScope {
  if (!value) return Object.freeze({});
  const entityIds = value.entityIds ? freezeIds(value.entityIds) : undefined; const componentTypes = value.componentTypes ? freezeIds(value.componentTypes) : undefined;
  if ((entityIds?.length ?? 0) > 1_000 || (componentTypes?.length ?? 0) > 128) throw new SceneContextError('scene.scope-invalid', 'Scene scope exceeds bounded limits.', false);
  return Object.freeze({ ...(value.sceneId ? { sceneId: asStableId(value.sceneId, 'scene scope id') } : {}), ...(entityIds ? { entityIds } : {}), ...(componentTypes ? { componentTypes } : {}) });
}
function normalizeLimit(value: number | undefined): number { const result = value ?? DEFAULT_LIMIT; if (!Number.isSafeInteger(result) || result < 1 || result > MAX_LIMIT) throw new SceneContextError('scene.limit-invalid', `Scene result limit must be 1-${MAX_LIMIT}.`, false); return result; }
function normalizedRevision(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new SceneContextError('scene.revision-invalid', `${label} is invalid.`, false); return value; }

function cursorOffset(cursor: string | undefined, expected: Omit<CursorPayload, 'version' | 'offset'>): number {
  if (!cursor) return 0; const value = decodeCursor(cursor);
  if (value.kind !== expected.kind || value.documentId !== expected.documentId || value.fromRevision !== expected.fromRevision || value.toRevision !== expected.toRevision || value.fingerprint !== expected.fingerprint) throw new SceneContextError('scene.cursor-stale', 'Scene cursor does not match the current query or revision range.', true);
  return value.offset;
}
function encodeCursor(value: CursorPayload): string { const body = Buffer.from(canonicalStringify(value as unknown as JsonValue)).toString('base64url'); return `${body}.${sha256(body).slice(0, 24)}`; }
function decodeCursor(value: string): CursorPayload {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2_048) throw new SceneContextError('scene.cursor-invalid', 'Scene cursor is invalid.', true);
  const [body, signature, extra] = value.split('.'); if (!body || !signature || extra || signature !== sha256(body).slice(0, 24)) throw new SceneContextError('scene.cursor-invalid', 'Scene cursor failed integrity validation.', true);
  let parsed: unknown; try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new SceneContextError('scene.cursor-invalid', 'Scene cursor payload is invalid.', true); }
  if (!isRecord(parsed) || parsed.version !== 1 || !['scene-query', 'scene-diff'].includes(String(parsed.kind)) || typeof parsed.documentId !== 'string' || !Number.isSafeInteger(parsed.fromRevision) || !Number.isSafeInteger(parsed.toRevision) || typeof parsed.fingerprint !== 'string' || !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0) throw new SceneContextError('scene.cursor-invalid', 'Scene cursor fields are invalid.', true);
  return Object.freeze({ version: 1, kind: parsed.kind as CursorPayload['kind'], documentId: asStableId(parsed.documentId), fromRevision: parsed.fromRevision as number, toRevision: parsed.toRevision as number, fingerprint: parsed.fingerprint, offset: parsed.offset as number });
}

function diffPaths(before: unknown, after: unknown, prefix = ''): readonly string[] {
  if (canonicalStringify((before ?? null) as JsonValue) === canonicalStringify((after ?? null) as JsonValue)) return Object.freeze([]);
  if (isRecord(before) && isRecord(after)) {
    const result: string[] = []; for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) result.push(...diffPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
    return Object.freeze(result.slice(0, 1_024));
  }
  return Object.freeze([prefix || '$']);
}
function setJsonPath(source: JsonObject, path: readonly string[], value: JsonValue | undefined, remove: boolean): JsonObject {
  const root = cloneJson(source) as Record<string, JsonValue>; let current = root;
  for (let index = 0; index < path.length - 1; index += 1) { const key = path[index]!; const child = current[key]; if (!isRecord(child)) current[key] = {}; current = current[key] as Record<string, JsonValue>; }
  const key = path.at(-1)!; if (remove) delete current[key]; else current[key] = cloneJson(value);
  return current;
}
function freezeDocument(value: GameDocumentV2): GameDocumentV2 { return deepFreeze(cloneJson(value) as unknown as GameDocumentV2); }
function freezeDelta(value: GameDocumentDeltaV2): GameDocumentDeltaV2 { return deepFreeze(cloneJson(value) as unknown as GameDocumentDeltaV2); }
function freezeIds<T extends string>(values: readonly T[]): readonly T[] { return Object.freeze([...new Set(values.map((value) => asStableId(value)))].sort()) as unknown as readonly T[]; }
function digestValue(value: JsonValue): M13Digest { return `sha256:${sha256(canonicalStringify(value))}` as M13Digest; }
function cloneJson(value: unknown): JsonValue { if (Array.isArray(value)) return value.map(cloneJson); if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)])); if (value === undefined) return null; if (value === null || typeof value === 'string' || typeof value === 'boolean') return value; if (typeof value === 'number' && Number.isFinite(value)) return value; throw new TypeError('Scene context value is not JSON.'); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
