import { asStableId, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import type { OperationLog } from '@haiyue/ai-studio-operation-log';
import type { ProjectWorkspace } from '@haiyue/ai-studio-editor-plugins';

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
  | 'project/close';

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
  readonly operationLog: OperationLog;
  readonly selectProjectRoot: (purpose: 'new' | 'open') => Promise<string | null>;
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
  }

  get activeCount(): number { return this.active.size; }

  private async dispatch(request: StudioIpcRequest, signal: AbortSignal): Promise<JsonObject> {
    switch (request.channel) {
      case 'app/status':
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
  'project/command', 'history/undo', 'history/redo', 'project/close',
]);

function requireShape(payload: Record<string, unknown>, keys: readonly string[], required: readonly string[], types: Readonly<Record<string, 'string' | 'number' | 'json'>>): void {
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(payload, key))) throw new IpcDiagnosticError('ipc-payload-rejected', 'IPC payload fields are invalid.');
  for (const [key, type] of Object.entries(types)) {
    if (type === 'json') { assertJson(payload[key]); continue; }
    if (typeof payload[key] !== type) throw new IpcDiagnosticError('ipc-payload-rejected', `IPC payload ${key} must be ${type}.`);
  }
}

function assertJson(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(assertJson); return; }
  if (isRecord(value) && Object.values(value).every((member) => { try { assertJson(member); return true; } catch { return false; } })) return;
  throw new IpcDiagnosticError('ipc-payload-rejected', 'IPC value must be bounded JSON data.');
}

function failure(id: string, correlationId: string, code: string, message: string): StudioIpcResponse {
  return Object.freeze({ schemaVersion: 1, id: safeId(id), correlationId: safeId(correlationId), ok: false, payload: Object.freeze({ diagnostic: Object.freeze({ code, severity: 'error', message }) }) });
}
function safeId(value: string): StableId { try { return asStableId(value); } catch { return asStableId('request:invalid'); } }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function toJson(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
function errorCode(value: unknown): string { return value instanceof IpcDiagnosticError ? value.code : value instanceof Error && 'code' in value ? String((value as Error & { code: unknown }).code) : 'ipc-operation-failed'; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
