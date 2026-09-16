import type { AgentBackendEvent } from './index.js';

/** Only adjacent text deltas are lossy checkpoints; control facts always flush first. */
export class TextJournal {
  private pending: AgentBackendEvent | null = null;
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(private readonly persist: (event: AgentBackendEvent) => Promise<void>, private readonly enabled = true) {}

  async accept(event: AgentBackendEvent): Promise<void> {
    await this.tail;
    this.assertHealthy();
    if (!this.enabled || event.kind !== 'conversation-node' || typeof event.payload.delta !== 'string' || event.payload.status !== 'streaming' || (event.payload.nodeKind !== undefined && event.payload.nodeKind !== 'text')) {
      await this.flush();
      await this.persist(event);
      return;
    }
    const { delta: _delta, ...metadata } = event.payload;
    const { delta: _previousDelta, ...previousMetadata } = this.pending?.payload ?? {};
    if (this.pending && (this.pending.turnId !== event.turnId || JSON.stringify(metadata) !== JSON.stringify(previousMetadata))) await this.flush();
    this.pending = { ...event, payload: { ...event.payload, delta: `${this.pending?.payload.delta ?? ''}${event.payload.delta}` } };
    this.bytes += Buffer.byteLength(event.payload.delta);
    if (this.bytes >= 8192) await this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.enqueue(), 250);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> { this.enqueue(); await this.tail; this.assertHealthy(); }

  private enqueue(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const event = this.pending; this.pending = null; this.bytes = 0;
    if (event) this.tail = this.tail.then(() => { this.assertHealthy(); return this.persist(event); }).catch(cause => { this.failure ??= cause; });
  }
  private assertHealthy(): void { if (this.failure) throw this.failure; }
}
