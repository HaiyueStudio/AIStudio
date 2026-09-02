import { asStableId, type StableId, type ToolBatchNodeV1, type ToolExecutionClassV1 } from '@haiyue/ai-studio-contracts';
import { ToolBatchProtocolError } from './types.js';

const GLOBAL_EFFECT_KEY = 'effect:global';

export interface EffectLockLease {
  readonly ownerId: StableId;
  readonly keys: readonly StableId[];
  readonly waitMs: number;
  release(): void;
}

export interface EffectLockSnapshot {
  readonly heldOwners: number;
  readonly heldKeys: number;
  readonly waiting: number;
  readonly acquisitions: number;
  readonly conflicts: number;
  readonly cancelledWaits: number;
}

interface PendingLock {
  readonly ownerId: StableId;
  readonly keys: readonly StableId[];
  readonly enqueuedAt: number;
  readonly resolve: (lease: EffectLockLease) => void;
  readonly reject: (cause: unknown) => void;
  readonly detachAbort: () => void;
}

/** Fair, cancellable in-process lock set. Durable recovery always reconciles against History/receipts. */
export class EffectLockManager {
  private readonly held = new Map<StableId, StableId>();
  private readonly owners = new Map<StableId, readonly StableId[]>();
  private readonly queue: PendingLock[] = [];
  private acquisitions = 0;
  private conflicts = 0;
  private cancelledWaits = 0;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  acquire(ownerId: StableId, keys: readonly StableId[], signal?: AbortSignal): Promise<EffectLockLease> {
    if (this.owners.has(ownerId) || this.queue.some((entry) => entry.ownerId === ownerId)) throw new ToolBatchProtocolError('effect-lock.owner-active', `Effect lock owner ${ownerId} is already active.`);
    const normalized = normalizeEffectLockKeys(keys);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new ToolBatchProtocolError('effect-lock.cancelled', 'Effect lock wait was cancelled.', true));
    return new Promise<EffectLockLease>((resolve, reject) => {
      let entry!: PendingLock;
      const abort = (): void => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1); this.cancelledWaits += 1; entry.detachAbort();
        reject(signal?.reason ?? new ToolBatchProtocolError('effect-lock.cancelled', 'Effect lock wait was cancelled.', true));
        this.pump();
      };
      const detachAbort = signal ? () => signal.removeEventListener('abort', abort) : () => {};
      entry = { ownerId, keys: normalized, enqueuedAt: this.clock(), resolve, reject, detachAbort };
      this.queue.push(entry);
      if (this.hasHeldConflict(normalized) || this.queue.slice(0, -1).some((prior) => conflicts(prior.keys, normalized))) this.conflicts += 1;
      signal?.addEventListener('abort', abort, { once: true });
      this.pump();
    });
  }

  acquireNode(ownerId: StableId, node: ToolBatchNodeV1, signal?: AbortSignal): Promise<EffectLockLease> {
    return this.acquire(ownerId, effectLockKeys(node.executionClass, node.effectKeys), signal);
  }

  snapshot(): EffectLockSnapshot {
    return Object.freeze({ heldOwners: this.owners.size, heldKeys: this.held.size, waiting: this.queue.length, acquisitions: this.acquisitions, conflicts: this.conflicts, cancelledWaits: this.cancelledWaits });
  }

  private pump(): void {
    for (let index = 0; index < this.queue.length;) {
      const entry = this.queue[index]!;
      const blockedByEarlier = this.queue.slice(0, index).some((prior) => conflicts(prior.keys, entry.keys));
      if (blockedByEarlier || this.hasHeldConflict(entry.keys)) { index += 1; continue; }
      this.queue.splice(index, 1); entry.detachAbort();
      for (const key of entry.keys) this.held.set(key, entry.ownerId);
      this.owners.set(entry.ownerId, entry.keys); this.acquisitions += 1;
      let released = false;
      entry.resolve(Object.freeze({
        ownerId: entry.ownerId, keys: entry.keys, waitMs: Math.max(0, this.clock() - entry.enqueuedAt),
        release: () => {
          if (released) return; released = true;
          const owned = this.owners.get(entry.ownerId);
          if (!owned) return;
          this.owners.delete(entry.ownerId);
          for (const key of owned) if (this.held.get(key) === entry.ownerId) this.held.delete(key);
          this.pump();
        },
      }));
    }
  }

  private hasHeldConflict(keys: readonly StableId[]): boolean {
    if (this.held.size === 0) return false;
    return conflicts(keys, [...this.held.keys()]);
  }
}

export function effectLockKeys(executionClass: ToolExecutionClassV1, effectKeys: readonly string[]): readonly StableId[] {
  if (executionClass === 'parallel-read') return Object.freeze([]);
  if (executionClass === 'unknown-exclusive') return Object.freeze([GLOBAL_EFFECT_KEY as StableId]);
  const keys = [...effectKeys];
  if (executionClass === 'exclusive-mutation' || executionClass === 'trusted-code-barrier' || executionClass === 'approval-barrier') keys.push('document:current' as StableId);
  if (executionClass === 'runtime-barrier' && keys.length === 0) keys.push('runtime:preview' as StableId);
  return normalizeEffectLockKeys(keys);
}

function normalizeEffectLockKeys(keys: readonly string[]): readonly StableId[] {
  const normalized = [...new Set(keys.map((key) => String(key)))].sort();
  if (normalized.length === 0) throw new ToolBatchProtocolError('effect-lock.keys-missing', 'Exclusive work requires at least one effect key.');
  if (normalized.length > 256 || normalized.some((key) => key.length < 3 || key.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(key))) throw new ToolBatchProtocolError('effect-lock.key-invalid', 'Effect lock keys are invalid or oversized.');
  if (normalized.includes(GLOBAL_EFFECT_KEY)) return Object.freeze([asStableId(GLOBAL_EFFECT_KEY)]);
  return Object.freeze(normalized.map((key) => asStableId(key, 'effect key')));
}

function conflicts(left: readonly StableId[], right: readonly StableId[]): boolean {
  if (left.includes(GLOBAL_EFFECT_KEY as StableId) || right.includes(GLOBAL_EFFECT_KEY as StableId)) return true;
  const rightSet = new Set(right);
  return left.some((key) => rightSet.has(key));
}
