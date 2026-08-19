import { asStableId, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import type { OperationLog } from '@haiyue/ai-studio-operation-log';
import { validateConversationIntent, type LogQueryIntent } from '@haiyue/ai-studio-shell';
import type { ScriptPreviewStudioService } from '@haiyue/ai-studio-script-preview';
import type {
  ProjectWorkspace,
  SceneAuthoringService,
  SceneSelectionService,
  SceneEntityKind,
  SelectionIntentSource,
  TransformSnapshot,
} from '@haiyue/ai-studio-editor-plugins';
import type { AgentPreviewBroker } from './agent-preview-broker.js';
import type { StudioConversationHost } from './conversation-host.js';

export const STUDIO_IPC_CHANNEL = 'studio:request' as const;
export const STUDIO_IPC_CANCEL_CHANNEL = 'studio:cancel' as const;
export const STUDIO_IPC_SCHEMA_VERSION = 1 as const;

export type StudioIpcMethod =
  | 'app/status'
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
  | 'scene/create'
  | 'scene/select'
  | 'scene/transform'
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
  | 'conversation/replay'
  | 'conversation/intent'
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
  readonly workspace: ProjectWorkspace;
  readonly scene: SceneAuthoringService;
  readonly selection: SceneSelectionService;
  readonly scripts: ScriptPreviewStudioService;
  readonly operationLog: OperationLog;
  readonly conversation: StudioConversationHost;
  readonly agentPreview: AgentPreviewBroker;
  readonly bugBundleRoot: string;
  readonly versions: Readonly<{ app: string; schema: string; upstream: Readonly<Record<string, string>> }>;
  readonly selectProjectRoot: (purpose: 'new' | 'open') => Promise<string | null>;
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
    this.active.set(request.id, controller);
    try {
      await this.options.operationLog.append({
        kind: 'ipc/requested', severity: 'info', source: asStableId('studio.electron'),
        correlation: { commandId: request.id }, payload: { channel: request.channel, correlationId: request.correlationId },
      }, { signal: controller.signal });
      const payload = await this.dispatch(request, controller.signal);
      if (this.disposed || generation !== this.generation || controller.signal.aborted) {
        return failure(request.id, request.correlationId, 'ipc-cancelled', 'Desktop request was cancelled before response delivery.');
      }
      await this.options.operationLog.append({
        kind: 'ipc/completed', severity: 'info', source: asStableId('studio.electron'),
        correlation: { commandId: request.id }, payload: { channel: request.channel },
      });
      return Object.freeze({ schemaVersion: 1, id: request.id, correlationId: request.correlationId, ok: true, payload });
    } catch (cause) {
      await this.options.operationLog.append({
        kind: 'ipc/failed', severity: 'error', source: asStableId('studio.electron'),
        correlation: { commandId: request.id }, payload: { channel: request.channel, code: errorCode(cause), message: errorMessage(cause) },
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
  }

  get activeCount(): number { return this.active.size; }

  private async dispatch(request: StudioIpcRequest, signal: AbortSignal): Promise<JsonObject> {
    switch (request.channel) {
      case 'app/status':
        return toJson({ ...this.options.workspace.snapshot(), smoke: this.options.smoke === true });
      case 'project/snapshot': return toJson(this.options.workspace.snapshot());
      case 'project/new': {
        const root = await this.options.selectProjectRoot('new');
        if (!root) throw new IpcDiagnosticError('project-selection-cancelled', 'Project creation was cancelled.');
        return toJson(await this.options.workspace.newProject(root, request.payload.name as string));
      }
      case 'project/open': {
        const root = await this.options.selectProjectRoot('open');
        if (!root) throw new IpcDiagnosticError('project-selection-cancelled', 'Project open was cancelled.');
        return toJson(await this.options.workspace.openProject(root));
      }
      case 'project/save': return toJson(await this.options.workspace.save());
      case 'project/command': return toJson(await this.options.workspace.execute({
        id: request.payload.commandId as StableId,
        label: request.payload.label as string,
        baseRevision: request.payload.baseRevision as number,
        key: request.payload.key as string,
        value: request.payload.value as JsonValue,
      }, signal));
      case 'history/undo': return toJson(await this.options.workspace.undo(request.payload.baseRevision as number));
      case 'history/redo': return toJson(await this.options.workspace.redo(request.payload.baseRevision as number));
      case 'project/close': await this.options.workspace.closeProject(); return Object.freeze({ closed: true });
      case 'project/reopen': return toJson(await this.options.workspace.reopen());
      case 'scene/snapshot': return toJson(this.options.scene.snapshot());
      case 'scene/create': return toJson(await this.options.scene.createEntity({
        commandId: request.payload.commandId as StableId,
        baseRevision: request.payload.baseRevision as number,
        kind: request.payload.kind as SceneEntityKind,
        name: request.payload.name as string | undefined,
        parentId: request.payload.parentId as StableId | null | undefined,
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
      case 'viewport/report': {
        const event = request.payload.event as ViewportReportEvent;
        await this.options.operationLog.append({
          kind: `viewport/${event}`, severity: event === 'ready' || event === 'rendered' ? 'info' : 'error',
          source: asStableId('studio.viewport.renderer'), correlation: {
            commandId: request.id,
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
        const plan = await this.options.scripts.prepare(request.payload.scriptId as StableId, request.payload.capabilities as never);
        const { emittedText: _emittedText, ...disclosure } = plan;
        return toJson(disclosure);
      }
      case 'preview/authorize': {
        const grant = await this.options.scripts.decide(request.payload.planId as StableId, request.payload.approved as boolean);
        return grant ? toJson(grant) : Object.freeze({ denied: true });
      }
      case 'preview/consume': return toJson(this.options.scripts.consume(request.payload.grantId as StableId));
      case 'preview/report': {
        const event = request.payload.event as string;
        await this.options.operationLog.append({
          kind: `preview/${event}`, severity: event === 'runtime-error' ? 'error' : 'info', source: asStableId('studio.preview.renderer'),
          correlation: { previewId: request.payload.previewId as StableId | undefined, entityId: request.payload.entityId as StableId | undefined },
          payload: { message: request.payload.message as string, disposableCount: request.payload.disposableCount as number },
        });
        return Object.freeze({ recorded: true });
      }
      case 'preview/agent-command': return this.options.agentPreview.command();
      case 'preview/agent-result': {
        const commandId = request.payload.commandId as StableId;
        if (request.payload.ok === true) this.options.agentPreview.resolve(commandId, request.payload.snapshot);
        else this.options.agentPreview.reject(commandId, request.payload.message as string);
        return Object.freeze({ recorded: true });
      }
      case 'conversation/replay': return toJson(this.options.conversation.replay());
      case 'conversation/intent': await this.options.conversation.dispatch(request.payload.intent, signal); return Object.freeze({ accepted: true });
      case 'logs/query': return toJson(await this.options.operationLog.logViewer(logQuery(request.payload.query)));
      case 'logs/export': return toJson(await this.options.operationLog.exportBugBundle({
        destinationRoot: this.options.bugBundleRoot,
        query: logQuery(request.payload.query),
        versions: this.options.versions,
      }));
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
  if (channel === 'project/new') requireShape(payload, keys, ['name'], { name: 'string' });
  else if (channel === 'project/command') requireShape(payload, keys, ['commandId', 'label', 'baseRevision', 'key', 'value'], {
    commandId: 'string', label: 'string', baseRevision: 'number', key: 'string', value: 'json',
  });
  else if (channel === 'history/undo' || channel === 'history/redo') requireShape(payload, keys, ['baseRevision'], { baseRevision: 'number' });
  else if (channel === 'scene/create') {
    requireAllowedShape(payload, keys, ['commandId', 'baseRevision', 'kind'], ['name', 'parentId']);
    if (typeof payload.commandId !== 'string' || typeof payload.baseRevision !== 'number' || (payload.kind !== 'empty' && payload.kind !== 'cube')
      || (payload.name !== undefined && typeof payload.name !== 'string')
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
    requireAllowedShape(payload, keys, ['scriptId'], ['capabilities']);
    if (typeof payload.scriptId !== 'string' || !validCapabilities(payload.capabilities)) throw new IpcDiagnosticError('ipc-payload-rejected', 'preview/prepare payload is invalid.');
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
  else if (channel === 'conversation/intent') {
    requireShape(payload, keys, ['intent'], { intent: 'json' });
    validateConversationIntent(payload.intent);
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
  'app/status', 'project/new', 'project/open', 'project/save', 'project/snapshot',
  'project/command', 'history/undo', 'history/redo', 'project/close', 'project/reopen',
  'scene/snapshot', 'scene/create', 'scene/select', 'scene/transform', 'viewport/report',
  'script/snapshot', 'script/propose', 'script/commit', 'preview/prepare', 'preview/authorize', 'preview/consume', 'preview/report',
  'preview/agent-command', 'preview/agent-result', 'conversation/replay', 'conversation/intent', 'logs/query', 'logs/export',
]);

type ViewportReportEvent = 'ready' | 'rendered' | 'device-lost' | 'failed' | 'picking-failed';
const viewportReportEvents = new Set<ViewportReportEvent>(['ready', 'rendered', 'device-lost', 'failed', 'picking-failed']);
const selectionSources = new Set<SelectionIntentSource>(['hierarchy', 'viewport', 'inspector', 'system']);
const previewReportEvents = new Set(['started', 'stopped', 'hot-reloaded', 'runtime-error', 'cleanup-complete']);
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
