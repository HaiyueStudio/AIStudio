import { asStableId, type StudioPluginDefinition } from '@haiyue/ai-studio-contracts';
import { HarnessApiKeyBackend, CodexAppServerBackend } from '@haiyue/ai-studio-agent-backends';
import { createAgentRuntimePlugin } from '@haiyue/ai-studio-agent-runtime';
import { createGameAuthoringToolsPlugin, type GamePreviewControl } from '@haiyue/ai-studio-game-authoring-tools';
import { createPinnedHarnessAgentTransport } from '@haiyue/ai-studio-harness-bridge/agent';

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
  readonly preview: GamePreviewControl;
  readonly resolveDeepSeekApiKey: () => Promise<string | null>;
  readonly clearDeepSeekApiKey: () => Promise<void>;
  readonly codexLoginMode?: 'browser' | 'device-code';
}

export function createPocAgentGameAuthoringPlugins(options: PocAgentGameAuthoringProfileOptions): readonly StudioPluginDefinition<any>[] {
  const tools = createGameAuthoringToolsPlugin({ preview: options.preview });
  const agent = createAgentRuntimePlugin({
    createBackends: async () => {
      if (options.backend === 'codex-app-server') {
        return Object.freeze([new CodexAppServerBackend({ loginMode: options.codexLoginMode ?? 'browser' })]);
      }
      const transport = await createPinnedHarnessAgentTransport({ resolveApiKey: options.resolveDeepSeekApiKey });
      return Object.freeze([new HarnessApiKeyBackend({ transport, clearApiKey: options.clearDeepSeekApiKey })]);
    },
  });
  return Object.freeze([tools, agent]);
}
