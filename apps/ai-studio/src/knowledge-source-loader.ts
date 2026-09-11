import { asStableId, type ComponentDefinitionV2, type JsonValue, type M13StableId, type StableId } from '@haiyue/ai-studio-contracts';
import { type ContextProjectSnapshot, type KnowledgeRetrievalRuntime } from '@haiyue/ai-studio-agent-runtime';
import { CONTROLLED_ASSET_CATALOG_SETTING_KEY, ControlledAssetCatalog, type ProjectWorkspace } from '@haiyue/ai-studio-editor-plugins';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';

const ENGINE_PERMISSION = asStableId('knowledge:engine-local') as M13StableId;
const ENGINE_PACKAGE_VERSION = '0.1.0';
const ACTIVE_PROJECT_SOURCE = asStableId('knowledge-source:active-project') as M13StableId;
const ACTIVE_ASSET_SOURCE = asStableId('knowledge-source:active-assets') as M13StableId;

interface ReviewedEngineGuide {
  readonly id: string;
  readonly capabilityIds: readonly string[];
  readonly title: string;
  readonly text: string;
  readonly sourceKind?: 'engine-doc' | 'verified-example';
}

/** Reviewed, genre-neutral authoring knowledge. These guides explain engine contracts;
 * they deliberately do not contain game-specific prompt patches. */
const ENGINE_GUIDES: readonly ReviewedEngineGuide[] = Object.freeze([
  Object.freeze({
    id: 'camera-framing', capabilityIds: ['camera.2d', 'camera.3d', 'camera.follow'], title: 'Camera framing and projection',
    text: 'Use a persisted gameplay camera as the shared authoring and Play authority. Inspect the current camera before editing it. Orthographic projection is appropriate when parallel board edges must remain parallel; perspective is appropriate when depth cues matter. A straight top-down 3D camera has 90 degrees elevation. camera.set orthographicSize is the full visible vertical world span; horizontal span also depends on aspect. Input conversion must still use engine picking rather than duplicating these projection formulas. Frame or follow an explicit target and verify the result with a Play screenshot.',
  }),
  Object.freeze({
    id: 'input-actions', capabilityIds: ['input.keyboard', 'interaction.pointer'], title: 'Keyboard, pointer and touch input',
    text: 'Map keyboard and pointer input to named gameplay actions. A pressed action is a one-tick transition while held input remains active across ticks. pointerEvents() x/y are canvas-normalized 0..1 coordinates with top-left origin, x right and y down; they are neither world coordinates nor camera-local coordinates. For scene placement, configure haiyue.interaction.pointer on the target surface, enable down or click, and consume api.input.interactions() filtered by type and stable entityId. hit.point is world [x,y,z], including camera projection, aspect and pose. Convert it to the logical grid using the same origin, axes and spacing as rendering; transformed boards require world-to-board conversion. Never hardcode a screen-to-world multiplier or rebuild camera rays in game scripts. Meshes can occlude the target; configure decorative blockers as penetrable when appropriate. Define down, move, up, cancel and invalid gesture behavior. Verify center and corner hits after resize and camera movement, for both orthographic and perspective projections, using authoritative grid observations and rendered placement.',
  }),
  Object.freeze({
    id: 'fixed-step-physics', capabilityIds: ['simulation.fixed-step', 'physics.2d', 'physics.3d', 'physics.raycast'], title: 'Fixed-step simulation and physics',
    text: 'Gameplay simulation and physics advance on fixed ticks. Persist world settings, body and collider components before using runtime physics operations. Separate authoritative state from presentation. Validate movement, collision or trigger transitions with deterministic stepping, physics queries and gameplay observations rather than relying on elapsed wall time.',
  }),
  Object.freeze({
    id: 'play-evidence', capabilityIds: ['play.inspect', 'play.capture', 'task.evaluate'], title: 'Play verification evidence',
    sourceKind: 'verified-example',
    text: 'A successful preview start is not acceptance evidence. Exercise the authored gameplay trigger, step the fixed simulation, inspect authoritative gameplay state, capture the rendered frame and evaluate the task against persisted observations. Keep stable trigger and observation identifiers so failures can be replayed and repaired.',
  }),
  Object.freeze({
    id: 'presentation-effects', capabilityIds: ['lighting', 'postprocess', 'particles.2d', 'particles.3d', 'audio.playback'], title: 'Presentation, effects and audio',
    text: 'Treat lighting, post-processing, particles, animation, HUD and audio as explicit versioned components. Add only supported component schemas from the registry, keep runtime ownership unambiguous, and verify structural state together with a screenshot or inspection artifact.',
  }),
]);

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
    for (const guide of ENGINE_GUIDES) await this.knowledge.upsert({
      sourceId: asStableId(`knowledge-guide:${guide.id}`), source: `engine://guide/${guide.id}@${ENGINE_PACKAGE_VERSION}`,
      sourceKind: guide.sourceKind ?? 'engine-doc', text: `${guide.title}\n\n${guide.text}`, mediaType: 'text/markdown',
      packageVersion: ENGINE_PACKAGE_VERSION, projectRevision: null, permissionScope: ENGINE_PERMISSION,
      capabilityIds: guide.capabilityIds.map((id) => asStableId(id)), claimKeys: [], relatedSourceIds: [], authorized: true, verified: true,
    }, signal);
    this.builtinsReady = true;
  }

  private async indexComponent(definition: ComponentDefinitionV2, signal?: AbortSignal): Promise<void> {
    const key = `${definition.type}@${definition.version}`;
    const projection = Object.freeze({
      schemaVersion: definition.schemaVersion, type: definition.type, version: definition.version, capability: definition.capability,
      effect: definition.effect, risk: definition.risk, label: definition.editor.label, category: definition.editor.category,
      runtimeAdapter: definition.runtimeAdapter, valueSchema: definition.valueSchema, defaults: definition.defaults,
    });
    await this.knowledge.upsert({
      sourceId: componentSourceId(key), source: `engine://component/${encodeURIComponent(definition.type)}@${definition.version}`,
      sourceKind: 'component-schema', text: canonicalStringify(projection as unknown as JsonValue), mediaType: 'application/json',
      packageVersion: ENGINE_PACKAGE_VERSION, projectRevision: null, permissionScope: ENGINE_PERMISSION,
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
