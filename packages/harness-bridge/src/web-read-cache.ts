import type { JsonObject } from '@haiyue/ai-studio-contracts';

interface PendingRead { controller: AbortController; promise: Promise<JsonObject>; waiters: number; }
/** Bounded, owner-scoped read reuse. Every waiter owns its cancellation; the last one drains the request. */
export class WebReadCache {
  private readonly values = new Map<string, { expires: number; value: JsonObject }>();
  private readonly pending = new Map<string, PendingRead>();
  private disposed = false;

  async run(key: string, signal: AbortSignal, read: (signal: AbortSignal) => Promise<JsonObject>): Promise<JsonObject> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('official.web.disposed');
    const cached = this.values.get(key);
    if (cached && cached.expires > Date.now()) return { ...cached.value, cached: true };
    this.values.delete(key);
    let entry = this.pending.get(key);
    const shared = !!entry;
    if (!entry) {
      if (this.pending.size >= 64) throw new Error('official.web.pending-limit');
      const controller = new AbortController();
      entry = { controller, waiters: 0, promise: Promise.resolve().then(() => { controller.signal.throwIfAborted(); return read(controller.signal); }) };
      const owned = entry;
      entry.promise = entry.promise.then(value => {
        controller.signal.throwIfAborted();
        if (value.status === 'completed') {
          if (this.values.size >= 64) this.values.delete(this.values.keys().next().value!);
          this.values.set(key, { expires: Date.now() + 60_000, value });
        }
        return value;
      }).finally(() => { if (this.pending.get(key) === owned) this.pending.delete(key); });
      this.pending.set(key, entry);
    }
    const owned = entry;
    owned.waiters += 1;
    return new Promise<JsonObject>((resolve, reject) => {
      let settled = false;
      const release = () => { settled = true; owned.waiters -= 1; signal.removeEventListener('abort', abort); };
      const abort = () => {
        if (settled) return;
        release();
        if (owned.waiters === 0) {
          owned.controller.abort(signal.reason);
          void owned.promise.then(() => reject(signal.reason), () => reject(signal.reason));
        } else reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      void owned.promise.then(value => { if (!settled) { release(); resolve({ ...value, cached: shared }); } }, error => { if (!settled) { release(); reject(error); } });
      if (signal.aborted) abort();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const entry of this.pending.values()) entry.controller.abort(new Error('official.web.disposed'));
    await Promise.allSettled([...this.pending.values()].map(entry => entry.promise));
    this.pending.clear(); this.values.clear();
  }
}
