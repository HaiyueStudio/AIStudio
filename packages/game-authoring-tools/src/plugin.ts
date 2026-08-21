import { asStableId, createStudioServiceToken, defineStudioPlugin, type JsonObject, type StableId, type StudioPluginDefinition } from '@haiyue/ai-studio-contracts';
import { projectWorkspaceServiceToken, sceneAuthoringToken } from '@haiyue/ai-studio-editor-plugins';
import { diagnosticsQueryServiceToken, operationLogServiceToken } from '@haiyue/ai-studio-operation-log';
import { scriptPreviewServiceToken } from '@haiyue/ai-studio-script-preview';
import { GAME_AUTHORING_TOOL_DEFINITIONS } from './definitions.js';
import { GameAuthoringToolRuntime } from './runtime.js';
import type { GamePreviewControl, GameToolApproval, GameToolApprovalResolution, GameToolCall, GameToolPreparation, GameToolResult, GameToolRuntimeSnapshot } from './types.js';

export interface GameAuthoringToolService {
  definitions(): ReturnType<GameAuthoringToolRuntime['definitions']>;
  snapshot(): GameToolRuntimeSnapshot;
  prepare(call: GameToolCall, signal?: AbortSignal): Promise<GameToolPreparation>;
  approval(id: StableId): GameToolApproval | undefined;
  decide(id: StableId, decision: GameToolApprovalResolution): Promise<GameToolApproval>;
  execute(preparationId: StableId, signal?: AbortSignal): Promise<GameToolResult>;
  cancel(callId: StableId): Promise<void>;
}

export interface GameAuthoringToolsPluginOptions { readonly preview: GamePreviewControl; }

export const gameAuthoringToolServiceToken = createStudioServiceToken<GameAuthoringToolService>('studio.game-authoring-tools');
export const gameAuthoringToolContributionKind = asStableId('studio.contribution.agent-tool');

export function createGameAuthoringToolsPlugin(options: GameAuthoringToolsPluginOptions): StudioPluginDefinition<JsonObject> {
  return defineStudioPlugin({
    manifest: {
      schemaVersion: 1, id: asStableId('studio.game-authoring-tools.plugin'), version: '0.0.0', apiVersion: '1.0',
      required: [
        { id: asStableId('studio.project-workspace'), version: '1.0.0' },
        { id: asStableId('studio.scene-authoring'), version: '1.0.0' },
        { id: asStableId('studio.script-preview'), version: '1.0.0' },
        { id: asStableId('studio.operation-log'), version: '1.0.0' },
      ], optional: [], provides: [{ id: asStableId('studio.game-authoring-tools'), version: '1.0.0' }],
      contributions: [gameAuthoringToolContributionKind], activationPolicy: 'required',
    },
    validateConfig(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) throw new TypeError('Game authoring tools config must be empty.');
      return Object.freeze({});
    },
    activate(context) {
      const runtime = new GameAuthoringToolRuntime({
        workspace: context.services.get(projectWorkspaceServiceToken), scene: context.services.get(sceneAuthoringToken),
        scripts: context.services.get(scriptPreviewServiceToken), diagnostics: context.services.get(diagnosticsQueryServiceToken),
        operationLog: context.services.get(operationLogServiceToken).log, preview: options.preview,
      });
      const service: GameAuthoringToolService = Object.freeze({
        definitions: runtime.definitions.bind(runtime), snapshot: runtime.snapshot.bind(runtime), prepare: runtime.prepare.bind(runtime),
        approval: runtime.approval.bind(runtime), decide: runtime.decide.bind(runtime), execute: runtime.execute.bind(runtime), cancel: runtime.cancel.bind(runtime),
      });
      context.services.provide(gameAuthoringToolServiceToken, service);
      for (const definition of GAME_AUTHORING_TOOL_DEFINITIONS) context.contributions.register({ id: definition.id, kind: gameAuthoringToolContributionKind, value: definition, priority: 100 });
      context.effects.own('game-authoring-tools.dispose', () => runtime.dispose());
    },
  });
}
