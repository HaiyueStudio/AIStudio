import { roundedBoxParameters } from '@haiyue/ai-studio-editor-plugins/render';
import { asStableId, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import type { OperationLog, BehaviorArtifactKind } from '@haiyue/ai-studio-operation-log';
import { projectLogQuery } from '@haiyue/ai-studio-operation-log/project-query';
import { validateConversationIntent, type LogQueryIntent } from '@haiyue/ai-studio-shell';
import type { ScriptPreviewStudioService, PreviewPlan } from '@haiyue/ai-studio-script-preview';
import type {
  ProjectWorkspace,
  SceneAuthoringService,
  SceneSelectionService,
  SceneEntityKind,
  SceneMaterialColor,
  SelectionIntentSource,
  TransformSnapshot,
} from '@haiyue/ai-studio-editor-plugins';
import type { AgentPreviewBroker } from './agent-preview-broker.js';
import type { DesktopNotificationService } from './desktop-notifications.js';
import { parseNotificationPreferences } from './notification-settings.js';
import type { ProjectBehaviorController, ProjectConversationController, ProjectEditorController, StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';

export const STUDIO_IPC_CHANNEL = 'studio:request' as const;
export const STUDIO_IPC_CANCEL_CHANNEL = 'studio:cancel' as const;
export const STUDIO_CONVERSATION_CHANGED_CHANNEL = 'studio:conversation-changed' as const;
export const STUDIO_IPC_SCHEMA_VERSION = 1 as const;

export type StudioIpcMethod =
  | 'app/status'
  | 'notifications/get' | 'notifications/set' | 'notifications/test' | 'notifications/target'
  | 'project/new'
  | 'project/open'
  | 'project/save'
  | 'project/snapshot'
  | 'project/command'
  | 'history/undo'
  | 'history/redo'
  | 'project/close'
  | 'project/reopen'
  | 'scene/snapshot'
  | 'asset/read'
  | 'scene/create'
  | 'scene/select'
  | 'scene/transform'
  | 'scene/material'
  | 'viewport/report'
  | 'script/snapshot'
  | 'script/propose'
  | 'script/commit'
  | 'preview/prepare'
  | 'preview/authorize'
  | 'preview/consume'
  | 'preview/report'
  | 'preview/agent-command'
  | 'preview/agent-result'
  | 'behavior/snapshot' | 'behavior/refresh' | 'behavior/explain' | 'behavior/locate'
  | 'behavior/history' | 'behavior/read' | 'behavior/capture' | 'behavior/cancel' | 'behavior/related'
  | 'editor/advanced' | 'editor/advanced-intent' | 'editor/resources' | 'editor/resource-intent' | 'editor/resource-import' | 'editor/cancel'
  | 'conversation/replay'
  | 'conversation/intent'
  | 'conversation/history'
  | 'conversation/history-detail'
  | 'logs/query'
  | 'logs/export';

export interface StudioIpcRequest {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly correlationId: StableId;
  readonly channel: StudioIpcMethod;
  readonly payload: JsonObject;
}

export interface StudioIpcResponse {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly correlationId: StableId;
  readonly ok: boolean;
  readonly payload: JsonObject;
}

export interface StudioIpcRouterOptions {
  readonly notifications?: DesktopNotificationService;
  readonly workspace: ProjectWorkspace;
  readonly scene: SceneAuthoringService;
  readonly selection: SceneSelectionService;
  readonly scripts: ScriptPreviewStudioService;
  readonly operationLog: OperationLog;
  readonly conversation: Pick<StudioConversationHost, 'dispatch' | 'replay' | 'cancelPending'> & Partial<Pick<ProjectConversationController, 'prepareProjectChange' | 'syncProject' | 'queryHistory' | 'readHistory'>>;
  readonly agentPreview: AgentPreviewBroker;
  readonly behavior?: ProjectBehaviorController;
  readonly editor?: ProjectEditorController;
  readonly bugBundleRoot: string;
  readonly versions: Readonly<{ app: string; schema: string; upstream: Readonly<Record<string, string>> }>;
  readonly selectProjectRoot: (purpose: 'open' | 'save') => Promise<string | null>;
  readonly smoke?: boolean;
}

export class StudioIpcRouter {
  private readonly active = new Map<string, AbortController>();
  private generation = 0;
  private disposed = false;
  constructor(private readonly options: StudioIpcRouterOptions) {}

  async handle(value: unknown): Promise<StudioIpcResponse> {
    let request: StudioIpcRequest;
    try { request = validateStudioIpcRequest(value); }
    catch (cause) { return failure('request:invalid', 'correlation:invalid', 'ipc-schema-rejected', errorMessage(cause)); }
    if (this.disposed) return failure(request.id, request.correlationId, 'ipc-router-disposed', 'Desktop request router is disposed.');
    const controller = new AbortController();
    const generation = this.generation;
    const document = this.options.workspace.snapshot().document;
    const requestCorrelation = { commandId: request.id, ...(document ? { projectId: document.projectId, documentId: document.documentId } : {}) };
    this.active.set(request.id, controller);
    try {
      await this.options.operationLog.append({
        kind: 'ipc/requested', severity: 'info', source: asStableId('studio.electron'),
        correlation: requestCorrelation, payload: { channel: request.channel, correlationId: request.correlationId },
      }, { signal: controller.signal });
      const payload = await this.dispatch(request, controller.signal, document?.projectId);
      if (request.channel === 'logs/query' || request.channel === 'logs/export') projectLogQuery({ limit: 1, traverseCorrelation: false, projectId: document?.projectId }, this.options.workspace.snapshot().document?.projectId);
      if (this.disposed || generation !== this.generation || controller.signal.aborted) {
        return failure(request.id, request.correlationId, 'ipc-cancelled', 'Desktop request was cancelled before response delivery.');
      }
      await this.options.operationLog.append({
        kind: 'ipc/completed', severity: 'info', source: asStableId('studio.electron'),
        correlation: requestCorrelation, payload: { channel: request.channel },
      });
      return Object.freeze({ schemaVersion: 1, id: request.id, correlationId: request.correlationId, ok: true, payload });
    } catch (cause) {
      await this.options.operationLog.append({
        kind: 'ipc/failed', severity: 'error', source: asStableId('studio.electron'),
        correlation: requestCorrelation, payload: { channel: request.channel, code: errorCode(cause), message: errorMessage(cause) },
      }).catch(() => {});
      return failure(request.id, request.correlationId, errorCode(cause), errorMessage(cause));
    } finally {
      this.active.delete(request.id);
    }
  }

  cancel(requestId: unknown): void {
    if (typeof requestId !== 'string') return;
    this.active.get(requestId)?.abort(new Error('Renderer cancelled request.'));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending();
  }

  cancelPending(): void {
    this.generation += 1;
    for (const controller of this.active.values()) controller.abort(new Error('Renderer or window owner disposed.'));
    this.active.clear();
    this.options.workspace.cancelAll();
    this.options.conversation.cancelPending();
    this.options.agentPreview.cancelPending();
    this.options.behavior?.cancel();
    this.options.editor?.cancel();
  }

  get activeCount(): number { return this.active.size; }

  private async dispatch(request: StudioIpcRequest, signal: AbortSignal, projectId?: StableId): Promise<JsonObject> {
    if (request.channel === 'logs/query' || request.channel === 'logs/export') projectLogQuery({ limit: 1, traverseCorrelation: false, projectId }, this.options.workspace.snapshot().document?.projectId);
    switch (request.channel) {
      case 'notifications/get': return toJson(this.options.notifications?.snapshot() ?? { supported: false, preferences: null, delivery: 'unsupported' });
      case 'notifications/set': {
        if (!this.options.notifications) throw new IpcDiagnosticError('notifications.unavailable', 'Desktop notifications are unavailable.');
        return toJson(await this.options.notifications.configure(request.payload.preferences));
      }
      case 'notifications/test': {
        if (!this.options.notifications) throw new IpcDiagnosticError('notifications.unavailable', 'Desktop notifications are unavailable.');
        return toJson(this.options.notifications.test());
      }
      case 'notifications/target': return toJson({ target: this.options.notifications?.takeTarget() ?? null });
      case 'app/status':
        return toJson({ ...this.options.workspace.snapshot(), smoke: this.options.smoke === true });
      case 'project/snapshot': return toJson(this.options.workspace.snapshot());
      case 'project/new': {
        return toJson(await this.replaceProject('Project replaced by a new project.', () => this.options.workspace.newProject(null, request.payload.name as string)));
      }
      case 'project/open': {
        const root = await this.options.selectProjectRoot('open');
        if (!root) throw new IpcDiagnosticError('project-selection-cancelled', 'Project open was cancelled.');
        return toJson(await this.replaceProject('Project replaced by an opened project.', () => this.options.workspace.openProject(root)));
      }
      case 'project/save': {
        if (this.options.workspace.snapshot().projectRoot) return toJson(await this.options.workspace.save());
        const root = await this.options.selectProjectRoot('save');
        if (!root) throw new IpcDiagnosticError('project-selection-cancelled', 'Project save was cancelled.');
        const saved = await this.options.workspace.saveAs(root);
        await this.options.conversation.syncProject?.();
        return toJson(saved);
      }
      case 'project/command': return toJson(await this.options.workspace.execute({
        id: request.payload.commandId as StableId,
        label: request.payload.label as string,
        baseRevision: request.payload.baseRevision as number,
        key: request.payload.key as string,
        value: request.payload.value as JsonValue,
      }, signal));
      case 'history/undo': return toJson(await this.options.workspace.undo(request.payload.baseRevision as number));
      case 'history/redo': return toJson(await this.options.workspace.redo(request.payload.baseRevision as number));
      case 'project/close': await this.replaceProject('Project closed.', () => this.options.workspace.closeProject()); return Object.freeze({ closed: true });
      case 'project/reopen': return toJson(await this.replaceProject('Project reopened.', () => this.options.workspace.reopen()));
      case 'scene/snapshot': return toJson(this.options.scene.snapshot());
      case 'asset/read': {
        const assetId = request.payload.assetId as StableId;
        const entry = this.options.scene.snapshot().assets.find((item) => item.id === assetId);
        if (!entry) throw new IpcDiagnosticError('asset-not-found', `Asset ${assetId} is not in the current controlled manifest.`);
        const bytes = await this.options.workspace.readControlledAsset(entry.projectPath, entry.byteLength, signal);
        if (bytes.byteLength !== entry.byteLength || `sha256:${await sha256Bytes(bytes)}` !== entry.digest) throw new IpcDiagnosticError('asset-integrity-failed', `Asset ${assetId} no longer matches its controlled manifest.`);
        const current = this.options.scene.snapshot().assets.find((item) => item.id === assetId);
        if (!current || current.digest !== entry.digest || current.projectPath !== entry.projectPath) throw new IpcDiagnosticError('asset-manifest-changed', `Asset ${assetId} changed while it was being read; restart Play.`);
        return Object.freeze({ assetId: entry.id, kind: entry.kind, mimeType: entry.mimeType, digest: entry.digest, byteLength: entry.byteLength, base64: Buffer.from(bytes).toString('base64') });
      }
      case 'scene/create': return toJson(await this.options.scene.createEntity({
        commandId: request.payload.commandId as StableId,
        baseRevision: request.payload.baseRevision as number,
        kind: request.payload.kind as SceneEntityKind,
        ...roundedBoxParameters(request.payload.kind, request.payload),
        name: request.payload.name as string | undefined,
        parentId: request.payload.parentId as StableId | null | undefined,
        material: request.payload.material as never,
        color: request.payload.color as SceneMaterialColor | undefined,
      }, signal));
      case 'scene/select': return toJson(await this.options.selection.select(
        request.payload.entityId as StableId | null,
        request.payload.source as SelectionIntentSource,
        request.correlationId,
      ));
      case 'scene/transform': return toJson(await this.options.scene.setTransform({
        commandId: request.payload.commandId as StableId,
        baseRevision: request.payload.baseRevision as number,
        entityId: request.payload.entityId as StableId,
        transform: request.payload.transform as unknown as TransformSnapshot,
      }, signal));
      case 'scene/material': return toJson(await this.options.scene.setMaterial({
        commandId: request.payload.commandId as StableId,
        baseRevision: request.payload.baseRevision as number,
        entityId: request.payload.entityId as StableId,
        material: request.payload.material as never,
        color: request.payload.color as SceneMaterialColor | undefined,
      }, signal));
      case 'viewport/report': {
        const event = request.payload.event as ViewportReportEvent;
        await this.options.operationLog.append({
          kind: `viewport/${event}`, severity: event === 'ready' || event === 'rendered' ? 'info' : 'error',
          source: asStableId('studio.viewport.renderer'), correlation: {
            projectId, commandId: request.id,
            entityId: request.payload.entityId as StableId | undefined,
          },
          payload: { message: request.payload.message as string, sceneRevision: request.payload.sceneRevision as number },
        });
        return Object.freeze({ recorded: true });
      }
      case 'script/snapshot': return toJson(this.options.scripts.snapshot());
      case 'script/propose': return toJson(await this.options.scripts.proposeEdit({
        entityId: request.payload.entityId as StableId,
        text: request.payload.text as string,
        baseRevision: request.payload.baseRevision as number,
        capabilities: request.payload.capabilities as never,
      }));
      case 'script/commit': return toJson(await this.options.scripts.commitProposal(
        request.payload.proposalId as StableId,
        request.payload.commandId as StableId,
        signal,
      ));
      case 'preview/prepare': {
        const scriptIds = request.payload.scriptIds as readonly StableId[] | undefined;
        const plan = await this.options.scripts.prepare(scriptIds ? { scriptIds } : undefined);
        return toJson({
          ...plan,
          scripts: plan.scripts.map(({ emittedText: _emittedText, ...script }) => script),
        });
      }
      case 'preview/authorize': {
        const grant = await this.options.scripts.decide(request.payload.planId as StableId, request.payload.approved as boolean);
        return grant ? toJson(grant) : Object.freeze({ denied: true });
      }
      case 'preview/consume': return this.observedPlan(this.options.scripts.consume(request.payload.grantId as StableId), request, signal);
      case 'preview/report': {
        const event = request.payload.event as string;
        if (event === 'stopped' || event === 'cleanup-complete') this.options.agentPreview.observeStopped(request.payload.previewId as StableId | undefined);
        await this.options.operationLog.append({
          kind: `preview/${event}`, severity: event === 'runtime-error' ? 'error' : 'info', source: asStableId('studio.preview.renderer'),
          correlation: { projectId, previewId: request.payload.previewId as StableId | undefined, entityId: request.payload.entityId as StableId | undefined },
          payload: { message: request.payload.message as string, disposableCount: request.payload.disposableCount as number },
        });
        return Object.freeze({ recorded: true });
      }
      case 'preview/agent-command': {
        const value = this.options.agentPreview.command(), command = value.command as JsonObject | undefined;
        if (value.pending !== true || command?.kind !== 'start' || !command.plan) return value;
        const plan = await this.observedPlan(command.plan as unknown as PreviewPlan, request, signal);
        if ((this.options.agentPreview.command().command as JsonObject | undefined)?.id !== command.id) throw new Error('behavior.play-stale');
        return toJson({ ...value, command: { ...command, plan } });
      }
      case 'preview/agent-result': {
        const commandId = request.payload.commandId as StableId;
        if (request.payload.ok === true) this.options.agentPreview.resolve(commandId, request.payload.snapshot);
        else this.options.agentPreview.reject(commandId, request.payload.message as string);
        return Object.freeze({ recorded: true });
      }
      case 'conversation/replay': return toJson(this.options.conversation.replay());
      case 'editor/advanced': return toJson(this.requireEditor().snapshotAdvanced());
      case 'editor/advanced-intent': return this.requireEditor().dispatchAdvanced(request.payload.intent, signal);
      case 'editor/resources': return toJson(await this.requireEditor().queryResources(request.payload, signal));
      case 'editor/resource-intent': return this.requireEditor().dispatchResource(request.payload.intent, signal);
      case 'editor/resource-import': return this.requireEditor().importResource(request.payload.viewToken, request.payload.details as JsonObject, signal);
      case 'editor/cancel': this.requireEditor().cancel(); return { cancelled: true };
      case 'behavior/snapshot': return toJson(this.requireBehavior().snapshot());
      case 'behavior/refresh': {
        await this.options.conversation.syncProject?.();
        return toJson(await this.requireBehavior().refresh(signal));
      }
      case 'behavior/explain': return toJson(await this.requireBehavior().explain(request.payload as unknown as Parameters<ProjectBehaviorController['explain']>[0], signal));
      case 'behavior/locate': return toJson(await this.requireBehavior().locateNode(request.payload.manifestDigest as string, request.payload.nodeId as string, signal));
      case 'behavior/related': {
        await this.options.conversation.syncProject?.();
        return toJson(await this.requireBehavior().related(request.payload.manifestDigest as string, request.payload.nodeId as string, request.payload.cursor as string | undefined, signal));
      }
      case 'behavior/history': {
        await this.options.conversation.syncProject?.();
        return toJson(await this.requireBehavior().history(request.payload as unknown as Parameters<ProjectBehaviorController['history']>[0]));
      }
      case 'behavior/read': {
        await this.options.conversation.syncProject?.();
        return toJson(await this.requireBehavior().readArtifact(request.payload.kind as BehaviorArtifactKind, request.payload.artifactId as string, signal));
      }
      case 'behavior/capture': return toJson(await this.requireBehavior().capturePlay(request.payload.capture, signal));
      case 'behavior/cancel': this.requireBehavior().cancel(); return Object.freeze({ cancelled: true });
      case 'conversation/intent': await this.options.conversation.dispatch(request.payload.intent, signal); return Object.freeze({ accepted: true });
      case 'conversation/history': {
        if (!this.options.conversation.queryHistory) throw new Error('项目执行记录不可用。');
        return toJson(await this.options.conversation.queryHistory(request.payload.projectId as StableId | null, { ...(typeof request.payload.cursor === 'string' ? { cursor: request.payload.cursor } : {}), ...(typeof request.payload.limit === 'number' ? { limit: request.payload.limit } : {}) }));
      }
      case 'conversation/history-detail': {
        if (!this.options.conversation.readHistory) throw new Error('项目执行记录不可用。');
        return toJson(await this.options.conversation.readHistory(request.payload.projectId as StableId, request.payload.id as StableId));
      }
      case 'logs/query': return toJson(await this.options.operationLog.logViewer(projectLogQuery(logQuery(request.payload.query), projectId)));
      case 'logs/export': return toJson(await this.options.operationLog.exportBugBundle({
        destinationRoot: this.options.bugBundleRoot,
        query: projectLogQuery(logQuery(request.payload.query), projectId),
        versions: this.options.versions,
      }));
    }
  }

  private async replaceProject<T>(reason: string, action: () => Promise<T>): Promise<T> {
    this.cancelProjectAgentState(reason);
    await this.options.conversation.prepareProjectChange?.();
    try { return await action(); }
    finally { this.options.behavior?.syncProject(); await this.options.conversation.syncProject?.(); }
  }

  private cancelProjectAgentState(reason: string): void {
    this.options.editor?.replaceProject();
    this.options.conversation.cancelPending(reason);
    this.options.agentPreview.cancelPending();
    this.options.behavior?.cancel();
  }
  private requireBehavior(): ProjectBehaviorController {
    const behavior = this.options.behavior; if (!behavior) throw new Error('behavior.service-unavailable');
    behavior.syncProject(); return behavior;
  }
  private requireEditor(): ProjectEditorController {
    if (!this.options.editor) throw new Error('editor.service-unavailable');
    return this.options.editor;
  }
  private async observedPlan(plan: PreviewPlan, request: StudioIpcRequest, signal: AbortSignal): Promise<JsonObject> {
    if (!this.options.behavior) return toJson(plan);
    try {
      await this.options.conversation.syncProject?.();
      const behavior = await this.options.behavior.preparePlay(plan, { taskId: request.correlationId, turnId: request.id }, signal);
      return toJson({ ...plan, behavior });
    } catch {
      if (signal.aborted) throw new Error('behavior.cancelled');
      // Observation failure is visible and cannot change the approved program or
      // prevent an otherwise supported Play from using its existing runtime.
      return toJson({ ...plan, behavior: null, behaviorDiagnostic: 'behavior.observation-unavailable' });
    }
  }
}

export function validateStudioIpcRequest(value: unknown): StudioIpcRequest {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.correlationId !== 'string'
    || typeof value.channel !== 'string' || !isRecord(value.payload)) {
    throw new IpcDiagnosticError('ipc-schema-rejected', 'IPC request envelope is invalid.');
  }
  const channel = value.channel as StudioIpcMethod;
  if (!allowedChannels.has(channel)) throw new IpcDiagnosticError('ipc-channel-rejected', `IPC channel ${value.channel} is not allowed.`);
  const payload = value.payload as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (channel === 'notifications/set') { requireShape(payload, keys, ['preferences'], { preferences: 'json' }); parseNotificationPreferences(payload.preferences); }
  else if (channel === 'project/new') requireShape(payload, keys, ['name'], { name: 'string' });
  else if (channel === 'project/command') requireShape(payload, keys, ['commandId', 'label', 'baseRevision', 'key', 'value'], {
    commandId: 'string', label: 'string', baseRevision: 'number', key: 'string', value: 'json',
  });
  else if (channel === 'history/undo' || channel === 'history/redo') requireShape(payload, keys, ['baseRevision'], { baseRevision: 'number' });
  else if (channel === 'asset/read') {
    requireShape(payload, keys, ['assetId'], { assetId: 'string' });
    if (!/^asset:[a-f0-9]{24}$/u.test(String(payload.assetId))) throw new IpcDiagnosticError('ipc-payload-rejected', 'asset/read assetId is invalid.');
  }
  else if (channel === 'scene/create') {
    try { roundedBoxParameters(payload.kind, payload); } catch (cause) { throw new IpcDiagnosticError('ipc-payload-rejected', (cause as Error).message); }
    requireAllowedShape(payload, keys, ['commandId', 'baseRevision', 'kind'], ['name', 'parentId', 'material', 'color', 'radius', 'segments']);
    if (typeof payload.commandId !== 'string' || typeof payload.baseRevision !== 'number' || !sceneEntityKinds.has(String(payload.kind))
      || (payload.name !== undefined && typeof payload.name !== 'string')
      || (payload.material !== undefined && !sceneMaterialKinds.has(String(payload.material)))
      || !validMaterialColor(payload.color)
      || ((payload.material !== undefined || payload.color !== undefined) && !sceneGeometryKinds.has(String(payload.kind)))
      || (payload.parentId !== undefined && payload.parentId !== null && typeof payload.parentId !== 'string')) {
      throw new IpcDiagnosticError('ipc-payload-rejected', 'scene/create payload is invalid.');
    }
  }
  else if (channel === 'scene/select') {
    requireShape(payload, keys, ['entityId', 'source'], { entityId: 'json', source: 'string' });
    if ((payload.entityId !== null && typeof payload.entityId !== 'string') || !selectionSources.has(payload.source as SelectionIntentSource)) {
      throw new IpcDiagnosticError('ipc-payload-rejected', 'scene/select payload is invalid.');
    }
  }
  else if (channel === 'scene/transform') {
    requireShape(payload, keys, ['commandId', 'baseRevision', 'entityId', 'transform'], {
      commandId: 'string', baseRevision: 'number', entityId: 'string', transform: 'json',
    });
  }
  else if (channel === 'scene/material') {
    requireAllowedShape(payload, keys, ['commandId', 'baseRevision', 'entityId', 'material'], ['color']);
    if (typeof payload.commandId !== 'string' || typeof payload.baseRevision !== 'number' || typeof payload.entityId !== 'string'
      || !sceneMaterialKinds.has(String(payload.material)) || !validMaterialColor(payload.color)) throw new IpcDiagnosticError('ipc-payload-rejected', 'scene/material payload is invalid.');
  }
  else if (channel === 'viewport/report') {
    requireAllowedShape(payload, keys, ['event', 'message', 'sceneRevision'], ['entityId']);
    if (typeof payload.event !== 'string' || typeof payload.message !== 'string' || typeof payload.sceneRevision !== 'number'
      || (payload.entityId !== undefined && typeof payload.entityId !== 'string')
      || !viewportReportEvents.has(payload.event as ViewportReportEvent)) {
      throw new IpcDiagnosticError('ipc-payload-rejected', 'viewport/report event is invalid.');
    }
  }
  else if (channel === 'script/propose') {
    requireAllowedShape(payload, keys, ['entityId', 'text', 'baseRevision'], ['capabilities']);
    if (typeof payload.entityId !== 'string' || typeof payload.text !== 'string' || payload.text.length > 100_000
      || typeof payload.baseRevision !== 'number' || !validCapabilities(payload.capabilities)) {
      throw new IpcDiagnosticError('ipc-payload-rejected', 'script/propose payload is invalid.');
    }
  }
  else if (channel === 'script/commit') requireShape(payload, keys, ['proposalId', 'commandId'], { proposalId: 'string', commandId: 'string' });
  else if (channel === 'preview/prepare') {
    requireAllowedShape(payload, keys, [], ['scriptIds']);
    if (payload.scriptIds !== undefined && (!Array.isArray(payload.scriptIds) || payload.scriptIds.length < 1 || payload.scriptIds.length > 128
      || payload.scriptIds.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 256)
      || new Set(payload.scriptIds).size !== payload.scriptIds.length)) {
      throw new IpcDiagnosticError('ipc-payload-rejected', 'preview/prepare scriptIds must contain 1-128 unique ids.');
    }
  }
  else if (channel === 'preview/authorize') {
    requireShape(payload, keys, ['planId', 'approved'], { planId: 'string', approved: 'json' });
    if (typeof payload.approved !== 'boolean') throw new IpcDiagnosticError('ipc-payload-rejected', 'preview/authorize decision is invalid.');
  }
  else if (channel === 'preview/consume') requireShape(payload, keys, ['grantId'], { grantId: 'string' });
  else if (channel === 'preview/report') {
    requireAllowedShape(payload, keys, ['event', 'message', 'disposableCount'], ['previewId', 'entityId']);
    if (!previewReportEvents.has(payload.event as string) || typeof payload.message !== 'string' || payload.message.length > 2_000
      || typeof payload.disposableCount !== 'number' || !Number.isSafeInteger(payload.disposableCount) || payload.disposableCount < 0
      || (payload.previewId !== undefined && typeof payload.previewId !== 'string') || (payload.entityId !== undefined && typeof payload.entityId !== 'string')) {
      throw new IpcDiagnosticError('ipc-payload-rejected', 'preview/report payload is invalid.');
    }
  }
  else if (channel === 'preview/agent-result') {
    requireAllowedShape(payload, keys, ['commandId', 'ok'], ['snapshot', 'message']);
    if (typeof payload.commandId !== 'string' || typeof payload.ok !== 'boolean'
      || (payload.ok === true && !isRecord(payload.snapshot))
      || (payload.ok === false && (typeof payload.message !== 'string' || payload.message.length > 2_000))) {
      throw new IpcDiagnosticError('ipc-payload-rejected', 'preview/agent-result payload is invalid.');
    }
  }
  else if (channel === 'editor/advanced-intent' || channel === 'editor/resource-intent') {
    requireShape(payload, keys, ['intent'], { intent: 'json' });
    if (!isRecord(payload.intent)) throw new IpcDiagnosticError('ipc-payload-rejected', 'Editor intent is invalid.');
  }
  else if (channel === 'editor/resources') {
    requireAllowedShape(payload, keys, [], ['text', 'category', 'kind', 'status', 'unused', 'cursor', 'limit']);
  }
  else if (channel === 'editor/resource-import') {
    requireShape(payload, keys, ['viewToken', 'details'], { viewToken: 'string', details: 'json' });
    if (!isRecord(payload.details)) throw new IpcDiagnosticError('ipc-payload-rejected', 'Resource import details are invalid.');
  }
  else if (channel === 'behavior/explain') {
    requireAllowedShape(payload, keys, ['manifestDigest','nodeIds','language'], []);
    if (!behaviorDigest(payload.manifestDigest) || !Array.isArray(payload.nodeIds) || payload.nodeIds.length < 1 || payload.nodeIds.length > 100 || !payload.nodeIds.every(behaviorId) || new Set(payload.nodeIds).size !== payload.nodeIds.length || !['en','zh-CN'].includes(String(payload.language))) throw new IpcDiagnosticError('ipc-payload-rejected', 'Behavior explanation request is invalid.');
  }
  else if (channel === 'behavior/locate' || channel === 'behavior/related') {
    requireAllowedShape(payload, keys, ['manifestDigest','nodeId'], channel === 'behavior/related' ? ['cursor'] : []);
    if (payload.cursor !== undefined && (typeof payload.cursor !== 'string' || payload.cursor.length > 1024)) throw new IpcDiagnosticError('ipc-payload-rejected', 'Behavior cursor is invalid.');
    if (!behaviorDigest(payload.manifestDigest) || !behaviorId(payload.nodeId)) throw new IpcDiagnosticError('ipc-payload-rejected', 'Behavior location request is invalid.');
  }
  else if (channel === 'behavior/history') {
    requireAllowedShape(payload, keys, [], ['kind','cursor','limit']);
    if ((payload.kind !== undefined && !['manifest','explanation','trace'].includes(String(payload.kind))) || (payload.cursor !== undefined && (typeof payload.cursor !== 'string' || payload.cursor.length > 1024)) || (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || Number(payload.limit) < 1 || Number(payload.limit) > 100))) throw new IpcDiagnosticError('ipc-payload-rejected', 'Behavior history request is invalid.');
  }
  else if (channel === 'behavior/read') {
    requireAllowedShape(payload, keys, ['kind','artifactId'], []);
    if (!['manifest','explanation','trace'].includes(String(payload.kind)) || typeof payload.artifactId !== 'string' || !/^artifact:sha256:[a-f0-9]{64}$/u.test(payload.artifactId)) throw new IpcDiagnosticError('ipc-payload-rejected', 'Behavior artifact request is invalid.');
  }
  else if (channel === 'behavior/capture') {
    requireAllowedShape(payload, keys, ['capture'], []);
    if (!isRecord(payload.capture)) throw new IpcDiagnosticError('ipc-payload-rejected', 'Behavior capture request is invalid.');
  }
  else if (channel === 'conversation/intent') {
    requireShape(payload, keys, ['intent'], { intent: 'json' });
    validateConversationIntent(payload.intent);
  }
  else if (channel === 'conversation/history') {
    requireAllowedShape(payload, keys, ['projectId'], ['cursor', 'limit']);
    if (payload.projectId !== null) { if (typeof payload.projectId !== 'string') throw new IpcDiagnosticError('ipc-payload-rejected', 'History project id is invalid.'); asStableId(payload.projectId, 'history project id'); }
    if (payload.cursor !== undefined && (typeof payload.cursor !== 'string' || payload.cursor.length > 1024)) throw new IpcDiagnosticError('ipc-payload-rejected', 'History cursor is invalid.');
    if (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || Number(payload.limit) < 1 || Number(payload.limit) > 100)) throw new IpcDiagnosticError('ipc-payload-rejected', 'History page size is invalid.');
  }
  else if (channel === 'conversation/history-detail') {
    requireShape(payload, keys, ['projectId', 'id'], { projectId: 'string', id: 'string' });
    asStableId(payload.projectId as string, 'history project id'); asStableId(payload.id as string, 'history record id');
  }
  else if (channel === 'logs/query' || channel === 'logs/export') {
    requireShape(payload, keys, ['query'], { query: 'json' });
    logQuery(payload.query);
  }
  else if (keys.length > 0) throw new IpcDiagnosticError('ipc-payload-rejected', `${channel} does not accept payload fields.`);
  return Object.freeze({
    schemaVersion: 1,
    id: asStableId(value.id, 'IPC request id'),
    correlationId: asStableId(value.correlationId, 'IPC correlation id'),
    channel,
    payload: Object.freeze(payload as JsonObject),
  });
}

export class IpcDiagnosticError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'IpcDiagnosticError'; }
}

const allowedChannels = new Set<StudioIpcMethod>([
  'notifications/get', 'notifications/set', 'notifications/test', 'notifications/target',
  'app/status', 'project/new', 'project/open', 'project/save', 'project/snapshot',
  'project/command', 'history/undo', 'history/redo', 'project/close', 'project/reopen',
  'scene/snapshot', 'asset/read', 'scene/create', 'scene/select', 'scene/transform', 'scene/material', 'viewport/report',
  'script/snapshot', 'script/propose', 'script/commit', 'preview/prepare', 'preview/authorize', 'preview/consume', 'preview/report',
  'preview/agent-command', 'preview/agent-result', 'conversation/replay', 'conversation/intent', 'conversation/history', 'conversation/history-detail', 'logs/query', 'logs/export',
  'behavior/snapshot', 'behavior/refresh', 'behavior/explain', 'behavior/locate', 'behavior/history', 'behavior/read', 'behavior/capture', 'behavior/cancel', 'behavior/related',
  'editor/advanced', 'editor/advanced-intent', 'editor/resources', 'editor/resource-intent', 'editor/resource-import', 'editor/cancel',
]);
const behaviorDigest = (value: unknown): boolean => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const behaviorId = (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value);

type ViewportReportEvent = 'ready' | 'rendered' | 'device-lost' | 'failed' | 'picking-failed';
const viewportReportEvents = new Set<ViewportReportEvent>(['ready', 'rendered', 'device-lost', 'failed', 'picking-failed']);
const selectionSources = new Set<SelectionIntentSource>(['hierarchy', 'viewport', 'inspector', 'system']);
const sceneEntityKinds = new Set(['empty', 'cube', 'rounded-box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron', 'directional-light', 'point-light', 'ambient-light']);
const sceneGeometryKinds = new Set(['cube', 'rounded-box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron']);
const sceneMaterialKinds = new Set(['basic', 'pbr', 'blinn-phong', 'normal']);
const previewReportEvents = new Set(['started', 'stopped', 'paused', 'resumed', 'hot-reloaded', 'runtime-error', 'cleanup-complete']);
const scriptCapabilities = new Set(['read', 'scene', 'asset', 'input', 'physics', 'debug']);

function requireShape(payload: Record<string, unknown>, keys: readonly string[], required: readonly string[], types: Readonly<Record<string, 'string' | 'number' | 'json'>>): void {
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(payload, key))) throw new IpcDiagnosticError('ipc-payload-rejected', 'IPC payload fields are invalid.');
  for (const [key, type] of Object.entries(types)) {
    if (type === 'json') { assertJson(payload[key]); continue; }
    if (typeof payload[key] !== type) throw new IpcDiagnosticError('ipc-payload-rejected', `IPC payload ${key} must be ${type}.`);
  }
}

function requireAllowedShape(payload: Record<string, unknown>, keys: readonly string[], required: readonly string[], optional: readonly string[]): void {
  if (required.some((key) => !Object.hasOwn(payload, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new IpcDiagnosticError('ipc-payload-rejected', 'IPC payload fields are invalid.');
  }
}

function validCapabilities(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string' && scriptCapabilities.has(item)));
}

function validMaterialColor(value: unknown): value is SceneMaterialColor | undefined {
  return value === undefined || (Array.isArray(value) && value.length === 4
    && value.every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1));
}

function assertJson(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(assertJson); return; }
  if (isRecord(value) && Object.values(value).every((member) => { try { assertJson(member); return true; } catch { return false; } })) return;
  throw new IpcDiagnosticError('ipc-payload-rejected', 'IPC value must be bounded JSON data.');
}

function logQuery(value: unknown): LogQueryIntent {
  return (validateConversationIntent(Object.freeze({ type: 'logs/export-bug-bundle', query: value })) as Extract<ReturnType<typeof validateConversationIntent>, { type: 'logs/export-bug-bundle' }>).query;
}

function failure(id: string, correlationId: string, code: string, message: string): StudioIpcResponse {
  return Object.freeze({ schemaVersion: 1, id: safeId(id), correlationId: safeId(correlationId), ok: false, payload: Object.freeze({ diagnostic: Object.freeze({ code, severity: 'error', message }) }) });
}
function safeId(value: string): StableId { try { return asStableId(value); } catch { return asStableId('request:invalid'); } }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function toJson(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
function errorCode(value: unknown): string { return value instanceof IpcDiagnosticError ? value.code : value instanceof Error && 'code' in value ? String((value as Error & { code: unknown }).code) : 'ipc-operation-failed'; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
async function sha256Bytes(value: Uint8Array): Promise<string> { const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer; const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)); return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
