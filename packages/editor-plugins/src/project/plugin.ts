import { tmpdir } from 'node:os';
import {
  asStableId,
  createStudioServiceToken,
  defineStudioPlugin,
  type JsonObject,
  type StudioPluginDefinition,
} from '@haiyue/ai-studio-contracts';
import { editorFoundationTokens } from '@haiyue/ai-studio-kernel';
import { operationLogServiceToken } from '@haiyue/ai-studio-operation-log';
import { RecentProjectStore } from './repository.js';
import { ProjectWorkspace } from '../history/workspace.js';
import { componentRegistryServiceToken } from '../components/registry.js';

export const projectWorkspaceServiceToken = createStudioServiceToken<ProjectWorkspace>('studio.project-workspace');

type ProjectPluginConfig = JsonObject & Readonly<{ userDataRoot: string }>;

export function createProjectWorkspacePlugin(): StudioPluginDefinition<ProjectPluginConfig> {
  return defineStudioPlugin({
    manifest: {
      schemaVersion: 1,
      id: asStableId('studio.project-workspace.plugin'),
      version: '0.0.0',
      apiVersion: '1.0',
      required: [
        { id: asStableId('editor.document'), version: '0.1.0' },
        { id: asStableId('editor.history'), version: '0.1.0' },
        { id: asStableId('editor.tasks'), version: '0.1.0' },
        { id: asStableId('editor.project-session'), version: '0.1.0' },
        { id: asStableId('studio.operation-log'), version: '1.0.0' },
      ],
      optional: [],
      provides: [
        { id: asStableId('studio.project-workspace'), version: '1.0.0' },
        { id: asStableId('studio.component-registry'), version: '2.0.0' },
      ],
      contributions: [],
      activationPolicy: 'required',
    },
    validateConfig(value): ProjectPluginConfig {
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).userDataRoot !== 'string') {
        throw new TypeError('Project workspace config requires userDataRoot.');
      }
      return Object.freeze({ userDataRoot: (value as Record<string, string>).userDataRoot }) as ProjectPluginConfig;
    },
    activate(context, config) {
      const operationLog = context.services.get(operationLogServiceToken).log;
      const workspace = new ProjectWorkspace({
        documents: context.services.get(editorFoundationTokens.documents),
        history: context.services.get(editorFoundationTokens.history),
        tasks: context.services.get(editorFoundationTokens.tasks),
        projectSession: context.services.get(editorFoundationTokens.projectSession),
        operationLog,
        recentProjects: new RecentProjectStore(config.userDataRoot || tmpdir()),
      });
      context.effects.own('project-workspace.dispose', () => workspace.dispose());
      context.services.provide(projectWorkspaceServiceToken, workspace);
      context.services.provide(componentRegistryServiceToken, workspace.componentRegistry);
    },
  });
}
