import type { ResourceCatalogEntryV1 } from '@haiyue/ai-studio-contracts';
import { CONTROLLED_ASSET_CATALOG_SETTING_KEY, ControlledAssetCatalog } from '@haiyue/ai-studio-editor-plugins/assets';
import { prepareBehaviorInput } from './binding.js';
import { BehaviorContractError, behaviorDigest, freezeProjection } from './canonical.js';
import { parseBehaviorContract } from './validation.js';

/** Bounded read projection; file asset metadata and budget authority remain in ControlledAssetCatalog. */
export function projectBehaviorResources(input: unknown): readonly ResourceCatalogEntryV1[] {
  const prepared = prepareBehaviorInput(input), document = prepared.document;
  const controlled = ControlledAssetCatalog.fromManifest(document.settings[CONTROLLED_ASSET_CATALOG_SETTING_KEY]);
  const entries: ResourceCatalogEntryV1[] = [];
  const unknown = { status: 'unknown', reason: 'Usage and dependency analysis has not established a complete set.' };
  for (const asset of document.assets) {
    const original = controlled.get(asset.id);
    if (!original) continue;
    if (original.digest !== asset.digest || original.kind !== asset.kind) throw new BehaviorContractError('behavior.asset-manifest-mismatch');
    entries.push(parseBehaviorContract('resource-catalog-entry', { schemaVersion: 1, catalogEntryId: `resource:${behaviorDigest({ kind: 'asset', id: asset.id }).slice(7, 39)}`, kind: 'asset', category: original.kind, label: original.projectPath,
      status: 'available', source: 'controlled-manifest', artifactId: null, ref: { kind: 'asset', assetId: original.id, digest: original.digest, source: asset.source }, dependencies: unknown, usage: unknown, unused: 'unknown', intents: ['resource.locate', 'asset.inspect', 'asset.assign'] }));
  }
  for (const entity of document.entities) {
    entries.push(parseBehaviorContract('resource-catalog-entry', { schemaVersion: 1, catalogEntryId: `resource:${behaviorDigest({ kind: 'instance', projectId: prepared.projectId, entityId: entity.id }).slice(7, 39)}`, kind: 'instance', category: 'Scene', label: entity.name,
      status: 'available', source: 'document', artifactId: null, ref: { kind: 'instance', projectId: prepared.projectId, entityId: entity.id, documentRevision: document.revision, componentId: null }, dependencies: unknown, usage: { status: 'inapplicable', reason: 'A scene instance is a location, not an unused file asset.' }, unused: 'inapplicable', intents: ['resource.locate', 'instance.inspect'] }));
  }
  for (const definition of prepared.registry.definitions) {
    entries.push(parseBehaviorContract('resource-catalog-entry', { schemaVersion: 1, catalogEntryId: `resource:${behaviorDigest({ kind: 'template', id: definition.type, version: definition.version }).slice(7, 39)}`, kind: 'template', category: definition.editor.category, label: definition.editor.label,
      status: 'unavailable', source: 'registry', artifactId: null, ref: { kind: 'template', templateId: definition.type, registryVersion: prepared.registry.version, defaultsDigest: behaviorDigest(definition.defaults) }, dependencies: unknown, usage: unknown, unused: 'inapplicable', intents: [] }));
  }
  // No persisted preset format exists yet; an in-memory value is never emitted as an available preset.
  if (entries.length > 12000) throw new BehaviorContractError('behavior.resource-budget');
  return freezeProjection(entries.sort((a, b) => a.catalogEntryId < b.catalogEntryId ? -1 : 1));
}
