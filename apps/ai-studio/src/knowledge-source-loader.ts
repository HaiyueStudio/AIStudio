import { loadEngineDocumentation } from './engine-documentation.js';
import { asStableId, type ComponentDefinitionV2, type JsonValue, type M13StableId, type StableId } from '@haiyue/ai-studio-contracts';
import { type ContextProjectSnapshot, type KnowledgeRetrievalRuntime } from '@haiyue/ai-studio-agent-runtime';
import { CONTROLLED_ASSET_CATALOG_SETTING_KEY, ControlledAssetCatalog, type ProjectWorkspace } from '@haiyue/ai-studio-editor-plugins';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';

const ENGINE_PERMISSION = asStableId('knowledge:engine-local') as M13StableId;

const ACTIVE_PROJECT_SOURCE = asStableId('knowledge-source:active-project') as M13StableId;
const ACTIVE_ASSET_SOURCE = asStableId('knowledge-source:active-assets') as M13StableId;

/** Bridges authoritative local registries/project metadata into the content-hash index.
 * Script text and binary asset bodies are never indexed. */
export class StudioKnowledgeSourceLoader {
  private builtinsReady = false;

  constructor(private readonly knowledge: KnowledgeRetrievalRuntime, private readonly workspace: ProjectWorkspace) {}

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.knowledge.initialize();
    await this.refreshBuiltins(signal);
  }

  async refresh(project: ContextProjectSnapshot | null, signal?: AbortSignal): Promise<void> {
    await this.initialize(signal);
    if (!project) {
      await this.knowledge.tombstone(ACTIVE_PROJECT_SOURCE, 'project-closed', signal);
      await this.knowledge.tombstone(ACTIVE_ASSET_SOURCE, 'project-closed', signal);
      return;
    }
    const document = this.workspace.gameSnapshot();
    if (document.id !== project.documentId || document.revision !== project.revision) throw new Error('Knowledge refresh observed a project revision mismatch; exact context remains authoritative.');
    const registry = this.workspace.componentRegistry.snapshot();
    const definitions = new Map(registry.definitions.map((definition) => [`${definition.type}@${definition.version}`, definition]));
    const componentTypes = [...new Set(document.components.map((component) => `${component.type}@${component.version}`))].sort();
    const componentSourceIds = componentTypes.map((key) => componentSourceId(key));
    const capabilityIds = componentTypes.flatMap((key) => {
      const definition = definitions.get(key);
      return definition ? [asStableId(definition.capability) as M13StableId] : [];
    });
    const permissionScope = projectPermission(project.projectId);
    const projectProjection = Object.freeze({
      schemaVersion: 1,
      project: Object.freeze({ id: project.projectId, documentId: project.documentId, revision: project.revision }),
      scenes: document.scenes.map((scene) => Object.freeze({ id: scene.id, name: scene.name })),
      entities: document.entities.map((entity) => Object.freeze({ id: entity.id, name: entity.name, parentId: entity.parentId })),
      componentTypes,
      settingKeys: Object.keys(document.settings).sort(),
      scripts: document.scripts.map((script) => Object.freeze({ id: script.id, entityId: script.entityId, name: script.name, capabilities: script.capabilities, digest: script.digest })),
    });
    await this.knowledge.upsert({
      sourceId: ACTIVE_PROJECT_SOURCE,
      source: `project://${encodeURIComponent(project.projectId)}/metadata@${project.revision}`,
      sourceKind: 'project-doc',
      text: canonicalStringify(projectProjection as unknown as JsonValue),
      mediaType: 'application/json', packageVersion: null, projectRevision: project.revision, permissionScope,
      capabilityIds: Object.freeze([...new Set(capabilityIds)]), claimKeys: Object.freeze([`project:${project.projectId}:revision`]),
      relatedSourceIds: Object.freeze(componentSourceIds), authorized: true, verified: true,
    }, signal);

    const assets = projectAssets(document.settings[CONTROLLED_ASSET_CATALOG_SETTING_KEY], document.assets);
    if (assets.length === 0) await this.knowledge.tombstone(ACTIVE_ASSET_SOURCE, 'project-assets-empty', signal);
    else await this.knowledge.upsert({
      sourceId: ACTIVE_ASSET_SOURCE,
      source: `project://${encodeURIComponent(project.projectId)}/asset-metadata@${project.revision}`,
      sourceKind: 'asset-metadata', text: canonicalStringify(assets as unknown as JsonValue), mediaType: 'application/json',
      packageVersion: null, projectRevision: project.revision, permissionScope, capabilityIds: [asStableId('asset.import')],
      claimKeys: Object.freeze([`project:${project.projectId}:assets`]), relatedSourceIds: [ACTIVE_PROJECT_SOURCE], authorized: true, verified: true,
    }, signal);
  }

  private async refreshBuiltins(signal?: AbortSignal): Promise<void> {
    if (this.builtinsReady) return;
    for (const definition of this.workspace.componentRegistry.snapshot().definitions) await this.indexComponent(definition, signal);
    const docs = await loadEngineDocumentation();
    for (const guide of docs.bundle.entries.filter(entry => entry.source.startsWith('studio-guide:'))) await this.knowledge.upsert({
      sourceId: asStableId(`knowledge-guide:${guide.source.slice('studio-guide:'.length)}`), source: `engine://guide/${guide.source.slice('studio-guide:'.length)}@${docs.bundle.binding.engineVersion}`,
      sourceKind: 'engine-doc', text: `${guide.title}\n\n${guide.blocks.join('\n\n')}`, mediaType: 'text/markdown',
      packageVersion: docs.bundle.binding.engineVersion, projectRevision: null, permissionScope: ENGINE_PERMISSION,
      capabilityIds: guide.capabilityIds.map(id => asStableId(id)), claimKeys: [], relatedSourceIds: [], authorized: true, verified: true,
    }, signal);
    this.builtinsReady = true;
  }

  private async indexComponent(definition: ComponentDefinitionV2, signal?: AbortSignal): Promise<void> {
    const docs = await loadEngineDocumentation();
    const key = `${definition.type}@${definition.version}`;
    const projection = Object.freeze({
      schemaVersion: definition.schemaVersion, type: definition.type, version: definition.version, capability: definition.capability,
      effect: definition.effect, risk: definition.risk, label: definition.editor.label, category: definition.editor.category,
      runtimeAdapter: definition.runtimeAdapter, valueSchema: definition.valueSchema, defaults: definition.defaults,
    });
    await this.knowledge.upsert({
      sourceId: componentSourceId(key), source: `engine://component/${encodeURIComponent(definition.type)}@${definition.version}`,
      sourceKind: 'component-schema', text: canonicalStringify(projection as unknown as JsonValue), mediaType: 'application/json',
      packageVersion: docs.bundle.binding.engineVersion, projectRevision: null, permissionScope: ENGINE_PERMISSION,
      capabilityIds: [asStableId(definition.capability)], claimKeys: [`component:${sha256(key).slice(0, 32)}`], relatedSourceIds: [], authorized: true, verified: true,
    }, signal);
  }
}

function componentSourceId(key: string): M13StableId { return asStableId(`knowledge-component:${sha256(key).slice(0, 32)}`); }
function projectPermission(projectId: StableId): M13StableId { return asStableId(`knowledge:project:${sha256(projectId).slice(0, 24)}`); }

function projectAssets(setting: JsonValue | undefined, fallback: readonly Readonly<{ id: string; kind: string; digest: string; source: string }>[]): readonly JsonValue[] {
  try {
    const controlled = ControlledAssetCatalog.fromManifest(setting).manifest();
    if (controlled.length) return controlled as unknown as readonly JsonValue[];
  } catch { /* Invalid project metadata is excluded from retrieval and remains visible through exact diagnostics. */ }
  return Object.freeze(fallback.map((asset) => Object.freeze({ id: asset.id, kind: asset.kind, digest: asset.digest, source: asset.source })) as unknown as JsonValue[]);
}
