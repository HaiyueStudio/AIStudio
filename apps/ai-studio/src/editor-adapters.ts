import { randomUUID } from 'node:crypto';
import { asStableId, type JsonObject, type JsonValue } from '@haiyue/ai-studio-contracts';
import type { ProjectWorkspace, SceneSelectionService } from '@haiyue/ai-studio-editor-plugins';
import { ProjectResourceCatalog } from '@haiyue/ai-studio-editor-plugins/resources';
import type { GameAuthoringToolService } from '@haiyue/ai-studio-game-authoring-tools';
import type { ProjectBehaviorPorts, ProjectEditorPorts } from '@haiyue/ai-studio-agent-orchestration';
import { parseBehaviorContract } from '@haiyue/ai-studio-script-preview';

/** Composition of existing service ports and bounded public read models. No
 * project state, approval decision, journal or mutation coordinator lives here. */
export function createWorkspaceEditorPorts(options: Readonly<{
  workspace: ProjectWorkspace; selection: SceneSelectionService; behavior: ProjectBehaviorPorts;
  tools: GameAuthoringToolService; approve: ProjectEditorPorts['approve']; playId: () => string | null;
}>): ProjectEditorPorts {
  const { workspace, selection, behavior } = options;
  return {
    nextId: randomUUID,
    current: () => { const p = workspace.snapshot(); return p.document ? { projectId: p.document.projectId, documentId: p.document.documentId,
      revision: p.document.revision, storageKey: p.projectRoot, selectionRevision: selection.snapshot().revision } : null; },
    advancedSource: epoch => {
      const snapshot = workspace.snapshot(), selected = selection.snapshot(), game = snapshot.document ? workspace.gameSnapshot() : null;
      const ref = (id: string) => ({ kind: 'scene-entity', id, documentId: game!.id });
      return { epoch, document: game ? { id: game.id, revision: game.revision, entities: game.entities, components: game.components } : null,
        definitions: workspace.componentRegistry.snapshot().definitions,
        selection: { revision: selected.revision, items: game ? selected.entityIds.map(ref) : [], active: game && selected.activeEntityId ? ref(selected.activeEntityId) : null },
        history: snapshot.history, projection: null, playId: options.playId(), observation: null, observationValue: null, observationEpoch: null, observationDocumentId: null };
    },
    select: id => selection.select(id ? asStableId(id) : null, 'inspector'),
    history: (direction, revision) => workspace[direction](revision),
    tools: options.tools, approve: options.approve,
    async resources(request, signal) {
      const initial = behavior.validateSource(await behavior.readSource(signal));
      signal.throwIfAborted();
      let bindingKey = '', cachedBinding: ReturnType<typeof behavior.bindSource> | null = null;
      const catalog = new ProjectResourceCatalog({ workspace,
        binding: () => {
          const document = workspace.gameSnapshot(), registry = workspace.componentRegistry.snapshot();
          const key = JSON.stringify([document.id, document.revision, registry.digest]);
          if (bindingKey !== key || !cachedBinding) {
            cachedBinding = behavior.bindSource({ ...initial, document, registry: { ...initial.registry, definitions: registry.definitions } }); bindingKey = key;
          }
          return cachedBinding;
        },
        validateEntry: input => parseBehaviorContract('resource-catalog-entry', input),
        validateLocation: behavior.validateLocation,
        dependencies: signal => request('asset.dependencies', {}, signal),
        request: (id, args, _binding, signal) => request(id, args, signal),
      }, { reuseQueries: true });
      return {
        async query(query, signal) {
          const page = await catalog.query({ ...query, projectOnly: true }, signal), selected = selection.snapshot();
          const target = selected.activeEntityId ? workspace.gameSnapshot().entities.find(e => e.id === selected.activeEntityId) : null;
          return { binding: page.binding as unknown as JsonObject | null, data: {
            projectKey: null, viewToken: null, state: page.binding ? 'ready' as const : 'empty' as const, total: page.total,
            nextCursor: page.nextCursor, categories: page.categories, diagnostics: page.diagnostics,
            target: target ? { entityId: target.id, label: target.name } : null,
            items: page.items.map(item => ({ entry: item.entry, health: item.health, diagnostics: item.diagnostics,
              metadata: item.asset ? [
                { label: '项目内文件', value: item.asset.projectPath }, { label: '格式', value: item.asset.mimeType },
                { label: '许可', value: item.asset.license }, { label: '来源', value: item.asset.provenance },
                { label: '宽度', value: String(item.asset.width) }, { label: '高度', value: String(item.asset.height) },
                { label: '文件字节', value: String(item.asset.byteLength) }, { label: '解码预算', value: String(item.asset.decodedBytes) },
              ] : [], configuration: item.configuration === null ? null : JSON.stringify(item.configuration, null, 2),
              locations: item.locations.map(({ ref, label, field }) => ({ ref, label, field })), target: item.target, assignments: item.assignments })),
          } };
        },
        execute: async (input, signal) => json(await catalog.execute(input, signal)),
        importAsset: async (input, signal) => json(await catalog.importAsset(input, signal)),
        locateUsage: input => json(catalog.locateUsage(input)), cancel: () => catalog.cancel(), dispose: () => catalog.dispose(),
      };
    },
  };
}
function json(input: unknown): JsonObject { return input as JsonObject; }
