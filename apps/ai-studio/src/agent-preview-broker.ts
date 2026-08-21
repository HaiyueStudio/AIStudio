import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { SceneSnapshot } from '@haiyue/ai-studio-editor-plugins';
import type { GamePreviewControl } from '@haiyue/ai-studio-game-authoring-tools';
import type { PreviewPlan, PreviewRuntimeSnapshot } from '@haiyue/ai-studio-script-preview';

export interface AgentPreviewCommand {
  readonly id: StableId;
  readonly kind: 'start' | 'stop';
  readonly scene?: SceneSnapshot;
  readonly plan?: PreviewPlan;
}

interface PendingCommand {
  readonly command: AgentPreviewCommand;
  readonly resolve: (snapshot: PreviewRuntimeSnapshot) => void;
  readonly reject: (cause: unknown) => void;
  readonly unlink: () => void;
}

const STOPPED: PreviewRuntimeSnapshot = Object.freeze({
  instanceId: null,
  state: 'stopped',
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
    return this.enqueue(Object.freeze({ id: this.nextId(), kind: 'start', scene, plan }), signal);
  }

  stop(signal?: AbortSignal): Promise<PreviewRuntimeSnapshot> {
    return this.enqueue(Object.freeze({ id: this.nextId(), kind: 'stop' }), signal);
  }

  snapshot(): PreviewRuntimeSnapshot { return this.latest; }

  command(): JsonObject {
    if (!this.pending) return Object.freeze({ pending: false });
    return Object.freeze({ pending: true, command: this.pending.command as unknown as JsonObject });
  }

  resolve(commandId: StableId, value: unknown): void {
    const pending = this.requirePending(commandId);
    const snapshot = validatePreviewSnapshot(value);
    this.pending = null;
    pending.unlink();
    this.latest = snapshot;
    pending.resolve(snapshot);
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

  private enqueue(command: AgentPreviewCommand, signal?: AbortSignal): Promise<PreviewRuntimeSnapshot> {
    if (this.disposed) return Promise.reject(new Error('Agent preview broker is disposed.'));
    if (this.pending) return Promise.reject(new Error('Another Agent preview command is pending.'));
    return new Promise<PreviewRuntimeSnapshot>((resolve, reject) => {
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

function validatePreviewSnapshot(value: unknown): PreviewRuntimeSnapshot {
  if (!isRecord(value) || !['stopped', 'playing', 'faulted'].includes(String(value.state))
    || (value.instanceId !== null && typeof value.instanceId !== 'string')
    || (value.entityId !== null && typeof value.entityId !== 'string')
    || !Number.isSafeInteger(value.disposableCount) || (value.disposableCount as number) < 0
    || !Array.isArray(value.errors)) throw new Error('Renderer preview acknowledgement is invalid.');
  const position = value.position === null ? null : validatePosition(value.position);
  return Object.freeze({
    instanceId: value.instanceId === null ? null : asStableId(value.instanceId as string),
    state: value.state as PreviewRuntimeSnapshot['state'],
    entityId: value.entityId === null ? null : asStableId(value.entityId as string),
    position,
    disposableCount: value.disposableCount as number,
    errors: Object.freeze([]),
  });
}

function validatePosition(value: unknown): Readonly<{ x: number; y: number; z: number }> {
  if (!isRecord(value) || !finite(value.x) || !finite(value.y) || !finite(value.z)) throw new Error('Renderer preview position is invalid.');
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
