import type { ComponentDefinitionV2, GameDocumentV2, JsonObject, JsonValue, ResourceCatalogEntryV1, ResourceKnowledgeV1, ResourceReferenceV1 } from '@haiyue/ai-studio-contracts';
import { CONTROLLED_ASSET_CATALOG_SETTING_KEY, ControlledAssetCatalog, type ControlledAssetManifestEntry } from '../catalog.js';
import { SCENE_GEOMETRY_KINDS, SCENE_LIGHT_KINDS, SCENE_MATERIAL_KINDS } from '../../scene-authoring.js';
import type { AssetAssignmentUsage, ResourceCatalogBinding, ResourceCatalogItem, ResourceCatalogPorts, ResourceUsageLocation } from './types.js';
import { checked, digest, equal, fail, freeze, id, publicText, publicValue, record, shape, text } from './values.js';

type InstanceRef = Extract<ResourceReferenceV1, { kind: 'instance' }>;
export interface ResourceSource {
  readonly binding: ResourceCatalogBinding;
  /** Internal storage owner only, never part of renderer state or persisted identity. */
  readonly projectRoot: string | null;
  readonly document: GameDocumentV2;
  readonly definitions: readonly ComponentDefinitionV2[];
  readonly catalog: ControlledAssetCatalog | null;
  readonly diagnostics: readonly string[];
}
export interface ResourceDependencyProjection {
  readonly complete: boolean;
  readonly reason: string;
  readonly references: readonly Readonly<{ assetId: string; location: ResourceUsageLocation }>[];
}
export interface TemplateOperation { readonly toolId: 'entity.create' | 'material.set' | 'component.configure'; readonly args: JsonObject; }
export interface ResourceRow { readonly item: ResourceCatalogItem; readonly template: TemplateOperation | null; readonly scriptId: string | null; }
export const UNKNOWN_DEPENDENCIES: ResourceDependencyProjection = freeze({ complete: false, reason: '尚未取得完整的资源引用查询。', references: [] });
const unknown = (reason: string) => freeze({ status: 'unknown' as const, reason });
const known = <T>(items: readonly T[]): ResourceKnowledgeV1<T> => freeze({ status: 'known', items });
const inapplicable = (reason: string) => freeze({ status: 'inapplicable' as const, reason });
const entryId = (value: unknown): string => `resource:${digest(value).slice(7, 39)}`;

export function resourceSource(ports: ResourceCatalogPorts): ResourceSource | null {
  const workspace = ports.workspace.snapshot();
  if (!workspace.document || workspace.disposed) return null;
  const document = ports.workspace.gameSnapshot(), source = ports.binding(), registry = ports.workspace.componentRegistry.snapshot();
  if (source.schemaVersion !== 1 || source.projectId !== workspace.document.projectId || source.documentId !== document.id || source.documentRevision !== document.revision
    || source.registry.digest !== registry.digest || !/^\d+\.\d+\.\d+$/u.test(source.registry.version) || !/^sha256:[a-f0-9]{64}$/u.test(source.digest)) fail('source-stale');
  if (document.entities.length > 10_000 || document.scripts.length > 200 || document.components.length > 50_000) fail('source-budget');
  const binding = freeze({ projectId: source.projectId, documentId: source.documentId, documentRevision: source.documentRevision,
    registryVersion: source.registry.version, registryDigest: source.registry.digest, digest: source.digest });
  let catalog: ControlledAssetCatalog | null = null;
  const diagnostics: string[] = [];
  try { catalog = ControlledAssetCatalog.fromManifest(document.settings[CONTROLLED_ASSET_CATALOG_SETTING_KEY]); }
  catch { diagnostics.push('资产清单无效，文件资产操作已停用；项目实例仍可查看。'); }
  if (catalog?.manifest().some(asset => !document.assets.some(reference => reference.id === asset.id))) diagnostics.push('资产清单含有未登记到文档的条目。');
  return { binding, projectRoot: workspace.projectRoot, document, definitions: registry.definitions, catalog, diagnostics };
}

/** Consume the existing asset.dependencies result, preserving its bounded scope. */
export function dependenciesFrom(value: unknown, source: ResourceSource): ResourceDependencyProjection {
  const input = shape(checked(value), ['documentId', 'revision', 'references', 'count', 'truncated']);
  if (input.documentId !== source.document.id || input.revision !== source.document.revision || !Array.isArray(input.references)
    || input.references.length > 500 || input.count !== input.references.length || typeof input.truncated !== 'boolean') fail('dependencies-invalid');
  const owners = new Map(source.document.entities.flatMap(entity => entity.componentIds.map(componentId => [componentId, entity] as const)));
  const references = input.references.map(value => {
    const row = shape(value, ['assetId', 'entityId', 'componentId', 'componentType', 'path']);
    const assetId = id(row.assetId), entityId = id(row.entityId), componentId = id(row.componentId), componentType = id(row.componentType);
    if (!assetId.startsWith('asset:') || typeof row.path !== 'string' || row.path.length > 2048) fail('dependencies-invalid');
    const owner = owners.get(componentId), component = source.document.components.find(item => item.id === componentId);
    if (!owner || owner.id !== entityId || !component || component.type !== componentType) fail('dependencies-invalid');
    // Paths come from the existing component reference query. Re-resolve them to
    // prevent a forged query result from inventing a use site.
    const field = row.path;
    if (pointerValue(component.value as JsonValue, field) !== assetId) fail('dependencies-invalid');
    return freeze({ assetId, location: { ref: instanceRef(source, entityId, componentId), label: publicText(owner.name), componentType, field } });
  });
  const opaqueSettings = Object.entries(source.document.settings).some(([key, value]) => key !== CONTROLLED_ASSET_CATALOG_SETTING_KEY && containsAssetReference(value));
  const complete = !input.truncated && source.document.scripts.length === 0 && !opaqueSettings;
  return freeze({ complete, references, reason: input.truncated ? '组件资源引用超过查询上限，不能据此判定未使用。'
    : source.document.scripts.length ? '项目包含脚本；组件引用已列出，动态使用仍未知。'
      : opaqueSettings ? '项目配置中还存在资源引用，组件查询不能证明完整使用集合。' : '' });
}

export function buildResourceRows(source: ResourceSource, dependencies: ResourceDependencyProjection, ports: ResourceCatalogPorts,
  health: ReadonlyMap<string, Readonly<{ health: ResourceCatalogItem['health']; diagnostic: string }>>): readonly ResourceRow[] {
  const rows: ResourceRow[] = [], { document } = source;
  const definitions = new Map(source.definitions.map(definition => [`${definition.type}@${definition.version}`, definition]));
  const components = new Map(document.components.map(component => [component.id, component]));
  const assetRefs = new Map(document.assets.map(asset => [asset.id, asset]));
  const make = (entry: unknown, detail: Omit<ResourceCatalogItem, 'entry'>, template: TemplateOperation | null = null, scriptId: string | null = null): void => {
    rows.push(freeze({ item: { entry: ports.validateEntry(entry), ...detail }, template, scriptId }));
  };
  const base = (key: unknown, category: string, label: string) => ({ schemaVersion: 1, catalogEntryId: entryId(key), category, label: publicText(label) || '未命名资源', artifactId: null });
  const detail = (configuration: JsonValue | null = null): Omit<ResourceCatalogItem, 'entry'> => ({ health: 'registered', diagnostics: [], locations: [], asset: null, configuration: configuration === null ? null : publicValue(configuration), target: 'none', assignments: [] });
  for (const asset of document.assets) {
    let manifest: ControlledAssetManifestEntry | null = null;
    try { manifest = source.catalog?.get(asset.id) ?? null; } catch { /* Missing identity is displayed below. */ }
    const mismatch = !manifest || manifest.digest !== asset.digest || manifest.kind !== asset.kind;
    const storedHealth = health.get(asset.id), available = !mismatch && (!storedHealth || !['missing', 'invalid', 'unavailable'].includes(storedHealth.health));
    const locations = uniqueLocations(dependencies.references.filter(row => row.assetId === asset.id).map(row => row.location));
    const usageRefs = [...new Map(locations.map(location => [digest(location.ref), location.ref])).values()];
    const usage = dependencies.complete ? known(usageRefs) : unknown(dependencies.reason);
    const environment = manifest?.kind === 'texture' && (manifest.mimeType === 'image/ktx2' || (manifest.width !== null && manifest.height !== null && manifest.width === manifest.height * 2));
    make({ ...base({ kind: 'asset', id: asset.id }, environment ? 'Lighting' : categoryForAsset(asset.kind), manifest?.projectPath ?? asset.id),
      kind: 'asset', source: 'controlled-manifest', status: available ? 'available' : 'unavailable', ref: { kind: 'asset', assetId: asset.id, digest: asset.digest, source: asset.source },
      dependencies: unknown('文件内部依赖尚未核验；此处仅列出项目中的使用位置。'), usage, unused: usage.status === 'known' ? usage.items.length ? 'no' : 'yes' : 'unknown',
      intents: available ? ['resource.locate', 'asset.inspect', 'asset.assign'] : [] },
    { ...detail(), asset: manifest ? publicValue(manifest as unknown as JsonValue) as unknown as ControlledAssetManifestEntry : null, locations,
      health: mismatch ? 'invalid' : storedHealth?.health ?? 'registered', diagnostics: mismatch ? ['文档引用与受控资产清单不一致。'] : storedHealth?.diagnostic ? [storedHealth.diagnostic] : [],
      target: 'entity', assignments: manifest && available ? assignments(manifest, source.catalog!) : [] });
  }
  for (const entity of document.entities) {
    const owned = entity.componentIds.flatMap(componentId => components.get(componentId) ?? []);
    const entityCategory = owned.some(component => categoryForComponent(component.type) === 'Lighting') ? 'Lighting'
      : owned.some(component => component.type === 'haiyue.render.geometry') ? 'Geometry' : 'Scene';
    const uses = dependencies.references.filter(row => row.location.ref.entityId === entity.id);
    const dependencyInfo = referencedAssets(uses.map(row => row.assetId), assetRefs, dependencies.complete, dependencies.reason);
    make({ ...base({ kind: 'instance', projectId: source.binding.projectId, entityId: entity.id }, entityCategory, entity.name), kind: 'instance', source: 'document', status: 'available',
      ref: instanceRef(source, entity.id, null), dependencies: dependencyInfo, usage: inapplicable('场景实例不能作为未使用文件资产清理。'), unused: 'inapplicable', intents: ['resource.locate', 'instance.inspect'] },
    { ...detail({ entityId: entity.id, sceneId: entity.sceneId, parentId: entity.parentId, componentCount: entity.componentIds.length }), health: 'verified', diagnostics: missingReferences(uses.map(row => row.assetId), assetRefs) });
    for (const component of owned) {
      const definition = definitions.get(`${component.type}@${component.version}`), locations = uses.filter(row => row.location.ref.componentId === component.id);
      make({ ...base({ kind: 'instance', projectId: source.binding.projectId, entityId: entity.id, componentId: component.id }, categoryForComponent(component.type, definition?.editor.category), `${entity.name} · ${definition?.editor.label ?? component.type}`),
        kind: 'instance', source: 'document', status: definition ? 'available' : 'unavailable', ref: instanceRef(source, entity.id, component.id),
        dependencies: referencedAssets(locations.map(row => row.assetId), assetRefs, dependencies.complete, dependencies.reason), usage: inapplicable('组件实例不适用未使用资产筛选。'), unused: 'inapplicable', intents: definition ? ['resource.locate', 'instance.inspect'] : [] },
      { ...detail({ type: component.type, version: component.version, enabled: component.enabled, value: component.value }), health: definition ? 'verified' : 'unavailable', diagnostics: definition ? missingReferences(locations.map(row => row.assetId), assetRefs) : ['组件版本未注册。'] });
    }
  }
  for (const script of document.scripts) {
    make({ ...base({ kind: 'instance', projectId: source.binding.projectId, scriptId: script.id }, 'Script', script.name), kind: 'instance', source: 'document', status: 'available',
      ref: instanceRef(source, script.entityId, null), dependencies: unknown('脚本的动态资源使用不能由组件引用查询证明。'), usage: inapplicable('项目脚本实例不是可清理的文件资产。'), unused: 'inapplicable', intents: ['resource.locate', 'instance.inspect'] },
    { ...detail({ scriptId: script.id, sourcePath: script.sourcePath, digest: script.digest, enabled: script.enabled, order: script.order }), health: 'verified' }, null, script.id);
  }
  for (const definition of source.definitions) {
    for (const defaults of templateVariants(definition)) {
      const available = definition.serializable && !containsUnboundReference(defaults), operation = templateOperation(definition, defaults);
      const suffix = definition.type === 'haiyue.render.geometry' ? ` · ${String(defaults.kind)}` : definition.type === 'haiyue.render.material' ? ` · ${String(defaults.material)}` : '';
      make({ ...base({ kind: 'template', type: definition.type, version: definition.version, defaults }, categoryForComponent(definition.type, definition.editor.category), `${definition.editor.label}${suffix}`), kind: 'template', source: 'registry', status: available ? 'available' : 'unavailable',
        ref: { kind: 'template', templateId: definition.type, registryVersion: source.binding.registryVersion, defaultsDigest: digest(defaults) }, dependencies: containsAssetReference(defaults) ? unknown('模板需要先指定有效的资源引用。') : known([]),
        usage: unknown('当前项目没有持久化模板创建来源，不能从相似组件反推实例。'), unused: 'inapplicable', intents: available ? ['resource.locate', 'template.create'] : [] },
      { ...detail(defaults), health: available ? 'verified' : 'unavailable', diagnostics: available ? [] : ['默认配置包含未绑定引用或尚不支持持久化，请使用已有受控配置入口。'], target: operation.toolId === 'entity.create' ? 'none' : 'entity' }, operation);
    }
  }
  // Current G02 contracts explicitly allow unsupported preset descriptors. These
  // are availability notices tied to real registered schemas, never saved values.
  const presetCategories = new Set<string>();
  for (const definition of source.definitions) {
    const category = categoryForComponent(definition.type, definition.editor.category);
    if (presetCategories.has(category)) continue;
    presetCategories.add(category);
    make({ ...base({ kind: 'preset', category, schemaId: definition.type }, category, `${definition.editor.label} · 配置预设尚不可用`), kind: 'preset', source: 'unsupported', status: 'unavailable',
      ref: { kind: 'preset', presetId: `preset:unsupported-${digest(definition.type).slice(7, 31)}`, schemaId: definition.type, schemaVersion: definition.version, valueDigest: digest({}) },
      dependencies: unknown('尚无持久化配置预设记录。'), usage: unknown('尚无持久化预设使用绑定。'), unused: 'inapplicable', intents: [] },
    { ...detail(), health: 'unavailable', diagnostics: ['尚无通用配置预设的持久化格式。现有 prefab 工作流仍由原服务管理。'] });
  }
  if (rows.length > 64_000) fail('source-budget');
  return freeze(rows.sort((a, b) => a.item.entry.catalogEntryId.localeCompare(b.item.entry.catalogEntryId, 'en')));
}

export function instanceRef(source: ResourceSource, entityId: string, componentId: string | null): InstanceRef {
  return freeze({ kind: 'instance', projectId: source.binding.projectId, entityId, documentRevision: source.document.revision, componentId });
}
function categoryForAsset(kind: string): string { return ({ texture: 'Texture', model: 'Model', audio: 'Audio', animation: 'Animation' } as Record<string, string>)[kind] ?? 'Other'; }
function categoryForComponent(type: string, fallback = 'Scene'): string {
  if (type.startsWith('haiyue.light.')) return 'Lighting';
  if (type === 'haiyue.render.geometry') return 'Geometry';
  if (type.startsWith('haiyue.material.') || type === 'haiyue.render.material') return 'Material';
  if (type.startsWith('haiyue.script.')) return 'Script';
  if (type.startsWith('haiyue.animation.')) return 'Animation';
  if (type.startsWith('haiyue.audio.')) return 'Audio';
  if (type.startsWith('haiyue.model.')) return 'Model';
  return publicText(fallback).slice(0, 64);
}
function templateVariants(definition: ComponentDefinitionV2): readonly JsonObject[] {
  const key = definition.type === 'haiyue.render.geometry' ? 'kind' : definition.type === 'haiyue.render.material' ? 'material' : null;
  if (!key) return [definition.defaults];
  const properties = definition.valueSchema.properties, property = record(properties) ? properties[key] : null;
  const values = record(property) && Array.isArray(property.enum) ? property.enum : [];
  return values.filter((value): value is string => typeof value === 'string' && (key === 'kind' ? SCENE_GEOMETRY_KINDS : SCENE_MATERIAL_KINDS as readonly string[]).includes(value as never))
    .map(value => freeze({ ...definition.defaults, [key]: value }));
}
function templateOperation(definition: ComponentDefinitionV2, defaults: JsonObject): TemplateOperation {
  if (definition.type === 'haiyue.render.geometry') return { toolId: 'entity.create', args: { kind: defaults.kind! } };
  const lightKind = `${definition.type.slice('haiyue.light.'.length)}-light`;
  if (definition.type.startsWith('haiyue.light.') && (SCENE_LIGHT_KINDS as readonly string[]).includes(lightKind)) return { toolId: 'entity.create', args: { kind: lightKind } };
  if (definition.type === 'haiyue.render.material') return { toolId: 'material.set', args: { material: defaults.material!, color: defaults.color! } };
  return { toolId: 'component.configure', args: { action: 'upsert', type: definition.type, version: definition.version, patch: defaults } };
}
function assignments(asset: ControlledAssetManifestEntry, catalog: ControlledAssetCatalog): readonly AssetAssignmentUsage[] {
  const candidates: AssetAssignmentUsage[] = asset.kind === 'texture' ? ['texture.base-color', 'texture.metallic-roughness', 'texture.normal', 'texture.occlusion', 'texture.emissive', 'texture.environment-diffuse', 'texture.environment-specular'] : [asset.kind];
  return candidates.filter(usage => { try { catalog.assignment(asset.id, usage); return true; } catch { return false; } });
}
function containsUnboundReference(value: JsonValue): boolean {
  if (typeof value === 'string') return /^(asset|script|entity):unbound$/u.test(value);
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsUnboundReference));
}
function containsAssetReference(value: JsonValue): boolean {
  if (typeof value === 'string') return value.startsWith('asset:');
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsAssetReference));
}
function uniqueLocations(values: readonly ResourceUsageLocation[]): readonly ResourceUsageLocation[] {
  const result = new Map<string, ResourceUsageLocation>(); for (const value of values) result.set(digest({ ref: value.ref, field: value.field }), value); return [...result.values()];
}
function referencedAssets(ids: readonly string[], assets: ReadonlyMap<string, GameDocumentV2['assets'][number]>, complete: boolean, reason: string): ResourceKnowledgeV1<ResourceReferenceV1> {
  const unique = [...new Set(ids)], missing = unique.some(id => !assets.has(id));
  if (!complete || missing || unique.length > 1000) return unknown(missing ? '组件引用了未登记的资源。' : reason || '依赖集合不完整。');
  return known(unique.map(id => { const asset = assets.get(id)!; return { kind: 'asset' as const, assetId: asset.id, digest: asset.digest, source: asset.source }; }));
}
function missingReferences(ids: readonly string[], assets: ReadonlyMap<string, unknown>): readonly string[] { return ids.some(id => !assets.has(id)) ? ['组件引用了未登记的资源。'] : []; }
function pointerValue(value: JsonValue, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  const parts = pointer.slice(1).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  let current: unknown = value;
  for (const part of parts) { if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined; current = (current as Record<string, unknown>)[part]; }
  return current;
}
