import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { SceneSnapshot } from '@haiyue/ai-studio-editor-plugins';
import type { GamePlayCapture, GamePlayInputEvent, GamePlayObservation, GamePreviewControl } from '@haiyue/ai-studio-game-authoring-tools';
import type { PreviewPlan, PreviewRuntimeSnapshot } from '@haiyue/ai-studio-script-preview';

export interface AgentPreviewCommand {
  readonly id: StableId;
  readonly kind: 'start' | 'stop' | 'step' | 'input' | 'inspect' | 'capture';
  readonly scene?: SceneSnapshot;
  readonly plan?: PreviewPlan;
  readonly count?: number;
  readonly event?: GamePlayInputEvent;
}

interface PendingCommand {
  readonly command: AgentPreviewCommand;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
  readonly unlink: () => void;
}

const STOPPED: PreviewRuntimeSnapshot = Object.freeze({
  instanceId: null,
  state: 'stopped',
  scriptSetDigest: null,
  scriptCount: 0,
  scripts: Object.freeze([]),
  entityId: null,
  position: null,
  disposableCount: 0,
  errors: Object.freeze([]),
});

/** Keeps the trusted preview realm renderer-owned while exposing a typed host service to tools. */
export class AgentPreviewBroker implements GamePreviewControl {
  private pending: PendingCommand | null = null;
  private latest: PreviewRuntimeSnapshot = STOPPED;
  private sequence = 0;
  private disposed = false;

  start(scene: SceneSnapshot, plan: PreviewPlan, signal?: AbortSignal): Promise<PreviewRuntimeSnapshot> {
    return this.enqueue(Object.freeze({ id: this.nextId(), kind: 'start', scene, plan }), signal).then((value) => value as PreviewRuntimeSnapshot);
  }

  stop(signal?: AbortSignal): Promise<PreviewRuntimeSnapshot> {
    return this.enqueue(Object.freeze({ id: this.nextId(), kind: 'stop' }), signal).then((value) => value as PreviewRuntimeSnapshot);
  }

  step(count: number, signal?: AbortSignal): Promise<GamePlayObservation> { return this.enqueue(Object.freeze({ id: this.nextId(), kind: 'step', count }), signal).then((value) => value as GamePlayObservation); }
  input(event: GamePlayInputEvent, signal?: AbortSignal): Promise<GamePlayObservation> { return this.enqueue(Object.freeze({ id: this.nextId(), kind: 'input', event }), signal).then((value) => value as GamePlayObservation); }
  inspect(signal?: AbortSignal): Promise<GamePlayObservation> { return this.enqueue(Object.freeze({ id: this.nextId(), kind: 'inspect' }), signal).then((value) => value as GamePlayObservation); }
  capture(signal?: AbortSignal): Promise<GamePlayCapture> { return this.enqueue(Object.freeze({ id: this.nextId(), kind: 'capture' }), signal).then((value) => value as GamePlayCapture); }

  snapshot(): PreviewRuntimeSnapshot { return this.latest; }

  command(): JsonObject {
    if (!this.pending) return Object.freeze({ pending: false });
    return Object.freeze({ pending: true, command: this.pending.command as unknown as JsonObject });
  }

  resolve(commandId: StableId, value: unknown): void {
    const pending = this.requirePending(commandId);
    const result = pending.command.kind === 'start' || pending.command.kind === 'stop' ? validatePreviewSnapshot(value)
      : pending.command.kind === 'capture' ? validatePlayCapture(value) : validatePlayObservation(value);
    this.pending = null;
    pending.unlink();
    if (pending.command.kind === 'start' || pending.command.kind === 'stop') this.latest = result as PreviewRuntimeSnapshot;
    pending.resolve(result);
  }

  reject(commandId: StableId, message: string): void {
    const pending = this.requirePending(commandId);
    this.pending = null;
    pending.unlink();
    pending.reject(new Error(message.slice(0, 2_000)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending('Agent preview broker disposed.');
  }

  cancelPending(reason = 'Renderer owner changed.'): void {
    const pending = this.pending;
    this.pending = null;
    pending?.unlink();
    pending?.reject(new Error(reason));
  }

  private enqueue(command: AgentPreviewCommand, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('Agent preview broker is disposed.'));
    if (this.pending) return Promise.reject(new Error('Another Agent preview command is pending.'));
    return new Promise<unknown>((resolve, reject) => {
      const abort = (): void => {
        if (this.pending?.command.id !== command.id) return;
        this.pending = null;
        reject(signal?.reason ?? new Error('Agent preview command cancelled.'));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.pending = Object.freeze({
        command,
        resolve,
        reject,
        unlink: () => signal?.removeEventListener('abort', abort),
      });
    });
  }

  private requirePending(commandId: StableId): PendingCommand {
    if (!this.pending || this.pending.command.id !== commandId) throw new Error('Agent preview command is missing, stale, or already resolved.');
    return this.pending;
  }

  private nextId(): StableId { this.sequence += 1; return asStableId(`preview-command:${this.sequence}`); }
}

function validatePlayObservation(value: unknown): GamePlayObservation {
  const base = validateObservationBase(value);
  if (!isRecord(value) || !isJsonObject(value.value)) throw new Error('Renderer Play observation value is invalid.');
  return Object.freeze({ ...base, value: value.value as JsonObject });
}

function validatePlayCapture(value: unknown): GamePlayCapture {
  const base = validateObservationBase(value);
  if (!isRecord(value) || value.mediaType !== 'image/png' || !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 8 || Number(value.byteLength) > 376 * 1024 || typeof value.base64 !== 'string' || value.base64.length > 513_376) throw new Error('Renderer Play capture is invalid.');
  return Object.freeze({ ...base, mediaType: 'image/png', byteLength: Number(value.byteLength), base64: value.base64 });
}

function validateObservationBase(value: unknown): Omit<GamePlayObservation, 'value'> {
  if (!isRecord(value) || typeof value.playId !== 'string' || !Number.isSafeInteger(value.documentRevision) || Number(value.documentRevision) < 0
    || !Array.isArray(value.scriptDigests) || !value.scriptDigests.every((item) => typeof item === 'string' && /^sha256:[a-f0-9]{64}$/u.test(item))
    || !Number.isSafeInteger(value.tick) || Number(value.tick) < 0 || !Number.isSafeInteger(value.frame) || Number(value.frame) < 0
    || typeof value.capturedAt !== 'string' || (value.device !== null && typeof value.device !== 'string')) throw new Error('Renderer Play observation provenance is invalid.');
  const viewport = value.viewport === null ? null : validateViewport(value.viewport);
  return Object.freeze({ playId: asStableId(value.playId), documentRevision: Number(value.documentRevision), scriptDigests: Object.freeze([...(value.scriptDigests as string[])]), tick: Number(value.tick), frame: Number(value.frame), viewport, device: value.device as string | null, capturedAt: value.capturedAt });
}

function validateViewport(value: unknown): Readonly<{ width: number; height: number }> {
  if (!isRecord(value) || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || Number(value.width) < 1 || Number(value.height) < 1 || Number(value.width) > 8192 || Number(value.height) > 8192) throw new Error('Renderer Play viewport is invalid.');
  return Object.freeze({ width: Number(value.width), height: Number(value.height) });
}

function isJsonObject(value: unknown): value is JsonObject { return isRecord(value) && isJsonValue(value); }
function isJsonValue(value: unknown): boolean { if (value === null || typeof value === 'string' || typeof value === 'boolean') return true; if (typeof value === 'number') return Number.isFinite(value); if (Array.isArray(value)) return value.every(isJsonValue); return isRecord(value) && Object.values(value).every(isJsonValue); }

function validatePreviewSnapshot(value: unknown): PreviewRuntimeSnapshot {
  if (!isRecord(value) || !['stopped', 'playing', 'faulted'].includes(String(value.state))
    || (value.instanceId !== null && typeof value.instanceId !== 'string')
    || (value.scriptSetDigest !== null && (typeof value.scriptSetDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.scriptSetDigest)))
    || !Number.isSafeInteger(value.scriptCount) || Number(value.scriptCount) < 0 || Number(value.scriptCount) > 128
    || !Array.isArray(value.scripts) || value.scripts.length !== value.scriptCount || !value.scripts.every(isPreviewScriptSnapshot)
    || (value.entityId !== null && typeof value.entityId !== 'string')
    || !Number.isSafeInteger(value.disposableCount) || (value.disposableCount as number) < 0
    || !Array.isArray(value.errors)) throw new Error('Renderer preview acknowledgement is invalid.');
  const position = value.position === null ? null : validatePosition(value.position);
  const scripts = Object.freeze((value.scripts as Record<string, unknown>[]).map((script) => Object.freeze({
    scriptId: asStableId(script.scriptId as string), entityId: asStableId(script.entityId as string), order: Number(script.order),
    state: script.state as 'playing' | 'faulted', position: script.position === null ? null : validatePosition(script.position),
    disposableCount: Number(script.disposableCount), errorCount: Number(script.errorCount),
  })));
  return Object.freeze({
    instanceId: value.instanceId === null ? null : asStableId(value.instanceId as string),
    state: value.state as PreviewRuntimeSnapshot['state'],
    scriptSetDigest: value.scriptSetDigest as `sha256:${string}` | null,
    scriptCount: Number(value.scriptCount),
    scripts,
    entityId: value.entityId === null ? null : asStableId(value.entityId as string),
    position,
    disposableCount: value.disposableCount as number,
    errors: Object.freeze([]),
  });
}

function isPreviewScriptSnapshot(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.scriptId === 'string' && typeof value.entityId === 'string'
    && Number.isSafeInteger(value.order) && (value.state === 'playing' || value.state === 'faulted')
    && (value.position === null || (() => { try { validatePosition(value.position); return true; } catch { return false; } })())
    && Number.isSafeInteger(value.disposableCount) && Number(value.disposableCount) >= 0
    && Number.isSafeInteger(value.errorCount) && Number(value.errorCount) >= 0;
}

function validatePosition(value: unknown): Readonly<{ x: number; y: number; z: number }> {
  if (!isRecord(value) || !finite(value.x) || !finite(value.y) || !finite(value.z)) throw new Error('Renderer preview position is invalid.');
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
