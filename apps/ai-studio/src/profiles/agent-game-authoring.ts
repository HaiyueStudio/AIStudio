import { asStableId, type StudioPluginDefinition } from '@haiyue/ai-studio-contracts';
import { HarnessApiKeyBackend, CodexAppServerBackend } from '@haiyue/ai-studio-agent-backends';
import { createAgentRuntimePlugin } from '@haiyue/ai-studio-agent-runtime';
import { createGameAuthoringToolsPlugin, type GamePreviewControl, type GameBehaviorSource, type CanvasTextureRenderer, type EngineDocumentation } from '@haiyue/ai-studio-game-authoring-tools';
import { createPinnedHarnessAgentTransport, createHarnessExtendedTools, type HarnessExtendedToolOptions } from '@haiyue/ai-studio-harness-bridge/agent';
import { operationLogServiceToken, type OperationLog } from '@haiyue/ai-studio-operation-log';

export interface PocEditorProfile {
  readonly id: 'poc-editor-harness' | 'poc-editor-codex';
  readonly backend: 'harness-api-key' | 'codex-app-server';
  readonly auth: 'api-key' | 'chatgpt';
}

export const POC_EDITOR_PROFILES: Readonly<Record<PocEditorProfile['id'], PocEditorProfile>> = Object.freeze({
  'poc-editor-harness': Object.freeze({ id: 'poc-editor-harness', backend: 'harness-api-key', auth: 'api-key' }),
  'poc-editor-codex': Object.freeze({ id: 'poc-editor-codex', backend: 'codex-app-server', auth: 'chatgpt' }),
});

export const POC_COMMON_PLUGIN_IDS = Object.freeze([
  'studio.editor-foundations', 'studio.operation-log.plugin', 'studio.project-workspace.plugin', 'studio.workspace-layout.plugin',
  'studio.scene.plugin', 'studio.hierarchy.plugin', 'studio.selection.plugin', 'studio.transform.plugin', 'studio.viewport.plugin',
  'studio.script-preview.plugin', 'studio.game-authoring-tools.plugin', 'studio.agent-runtime.plugin', 'studio.electron-ipc.plugin',
].map((id) => asStableId(id)));

export function selectPocEditorProfile(value: string | undefined): PocEditorProfile {
  return value === 'poc-editor-harness' ? POC_EDITOR_PROFILES['poc-editor-harness'] : POC_EDITOR_PROFILES['poc-editor-codex'];
}

export interface PocAgentGameAuthoringProfileOptions {
  readonly backend: PocEditorProfile['backend'];
  readonly officialTools?: import('@haiyue/ai-studio-contracts').OfficialToolProviderV1;
  readonly extendedTools?: Omit<HarnessExtendedToolOptions, 'storeArtifact'>;
  readonly preview: GamePreviewControl;
  readonly textureRenderer?: CanvasTextureRenderer;
  readonly documentation?: EngineDocumentation;
  readonly resolveDeepSeekApiKey: () => Promise<string | null>;
  readonly clearDeepSeekApiKey: () => Promise<void>;
  readonly codexLoginMode?: 'browser' | 'device-code';
  readonly behaviorSource?: GameBehaviorSource;
  readonly harnessMaxParallelToolCalls?: 1 | 2 | 3 | 4;
  readonly harnessContextWindow?: number;
  readonly compactContext?: boolean;
  readonly batchTextWrites?: boolean;
}

export function createPocAgentGameAuthoringPlugins(options: PocAgentGameAuthoringProfileOptions): readonly StudioPluginDefinition<any>[] {
  if (options.officialTools && options.extendedTools) throw new Error('Configure one official tool provider.');
  let artifactLog: OperationLog | undefined;
  const officialTools = options.officialTools ?? (options.backend === 'harness-api-key' && options.extendedTools ? createHarnessExtendedTools({ ...options.extendedTools, async storeArtifact(value, call, signal) {
    signal.throwIfAborted();
    if (!artifactLog) throw new Error('official.artifact-store-unavailable');
    const artifact = await artifactLog.putArtifact(value, { schemaVersion: 'official-node-output/1' });
    signal.throwIfAborted();
    await artifactLog.append({ kind: 'tool/official-artifact', severity: 'info', source: asStableId('studio.official-tools'), correlation: { sessionId: call.sessionId, turnId: call.turnId, toolCallId: call.callId }, payload: { toolId: call.toolId, artifactId: artifact.id }, artifactRefs: [artifact.id] }, { signal });
    return { id: artifact.id, digest: artifact.digest, bytes: artifact.bytes };
  } }) : undefined);
  const tools = createGameAuthoringToolsPlugin({ officialTools, preview: options.preview, documentation: options.documentation, textureRenderer: options.textureRenderer, behaviorSource: options.behaviorSource });
  const agent = createAgentRuntimePlugin({
    compactContext: options.compactContext,
    batchTextWrites: options.batchTextWrites,
    createBackends: async (context) => {
      if (options.backend === 'codex-app-server') {
        return Object.freeze([new CodexAppServerBackend({ loginMode: options.codexLoginMode ?? 'browser' })]);
      }
      artifactLog = context.services.get(operationLogServiceToken).log;
      const transport = await createPinnedHarnessAgentTransport({ officialTools, owner: context, resolveApiKey: options.resolveDeepSeekApiKey, maxParallelToolCalls: options.harnessMaxParallelToolCalls, contextWindow: options.harnessContextWindow });
      return Object.freeze([new HarnessApiKeyBackend({ transport, clearApiKey: options.clearDeepSeekApiKey })]);
    },
  });
  return Object.freeze([tools, agent]);
}
