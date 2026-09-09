import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EditorDocumentHost, EditorHistoryService, EditorProjectSessionState, EditorTaskCoordinator } from '@haiyue/editor-platform';
import { PromptContextRuntime } from '@haiyue/ai-studio-agent-runtime';
import { ProjectWorkspace, RecentProjectStore } from '@haiyue/ai-studio-editor-plugins';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

test('desktop composition sends one bounded Scene baseline and exact revision deltas without script text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g05-app-')); const projectRoot = path.join(root, 'project');
  const operationLog = await OperationLog.open({ rootDirectory: path.join(root, 'log'), appVersion: 'g05-app', flushPolicy: 'always' });
  const resources = { documents: new EditorDocumentHost(), history: new EditorHistoryService(), tasks: new EditorTaskCoordinator(), projectSession: new EditorProjectSessionState(), operationLog, recentProjects: new RecentProjectStore(root) };
  const workspace = new ProjectWorkspace(resources); const context = new PromptContextRuntime(operationLog);
  try {
    await mkdir(projectRoot, { recursive: true });
    await workspace.newProject(projectRoot, 'G05 app integration');
    const tools = [{ id: 'scene.query', description: 'Read bounded exact Scene context.', inputSchema: { type: 'object' } }];
    const firstProject = projectContext(workspace); const first = await context.prepare({ conversationKey: 'conversation:g05-app', backendId: 'backend:g05-app', taskId: 'task:g05-app-1', request: 'Inspect the project.', tools, project: firstProject });
    assert.match(first.prompt, /"kind":"project-manifest"/u); assert.match(first.prompt, /"scene"/u);
    await context.commit({ conversationKey: 'conversation:g05-app', backendId: 'backend:g05-app', taskId: 'task:g05-app-1', tools, sessionId: 'session:g05-app', turnId: 'turn:g05-app-1', projectId: firstProject.projectId, goals: [], decisions: [], toolFacts: [], acceptance: [], blockers: [] });
    await workspace.executeBatch({ id: 'command:g05-app-add', label: 'Add exact entity', baseRevision: 1, operations: [{ op: 'entity.add', entity: { id: 'entity:g05-app', sceneId: workspace.primarySceneId(), name: 'Exact Entity', parentId: null, order: 0, componentIds: [] } }] });
    const second = await context.prepare({ conversationKey: 'conversation:g05-app', backendId: 'backend:g05-app', taskId: 'task:g05-app-2', request: 'Continue from the revision delta.', tools, project: projectContext(workspace) });
    assert.match(second.prompt, /"kind":"document-delta"/u); assert.match(second.prompt, /"fromRevision":1/u); assert.match(second.prompt, /"toRevision":2/u); assert.match(second.prompt, /entity:g05-app/u);
    assert.doesNotMatch(second.prompt, /script source/u);
  } finally {
    await workspace.dispose(); resources.tasks.dispose(); await resources.documents.dispose(); resources.history.dispose(); resources.projectSession.dispose(); await operationLog.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function projectContext(workspace) {
  const project = workspace.snapshot().document;
  return { projectId: project.projectId, documentId: project.documentId, revision: project.revision, manifest: { schemaVersion: 1, project: { id: project.projectId, documentId: project.documentId, name: project.name, revision: project.revision, savedRevision: project.savedRevision, dirty: project.dirty, counts: project.counts, registryDigest: project.registryDigest } }, exact: {
    query: ({ revision, request }) => workspace.queryScene({ ...request, revision }),
    diff: ({ fromRevision, toRevision, request }) => workspace.diffScene({ ...request, fromRevision, toRevision }),
  } };
}
