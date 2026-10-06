export interface AgentPollSchedulerOptions {
  /** Null uses push events only after a successful refresh; failures still retry. */
  readonly intervalMs: number | null;
  readonly poll: () => Promise<void>;
  readonly onError: (cause: unknown) => void;
  readonly schedule?: (task: () => void, delayMs: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

/** Coalesces push hints and fallback polling without overlapping IPC requests. */
export class AgentPollScheduler {
  private readonly scheduleTask: (task: () => void, delayMs: number) => unknown;
  private readonly cancelTask: (handle: unknown) => void;
  private timer: unknown = null;
  private running = false;
  private rerunRequested = false;
  private started = false;
  private failures = 0;

  constructor(private readonly options: AgentPollSchedulerOptions) {
    if (options.intervalMs !== null && (!Number.isFinite(options.intervalMs) || options.intervalMs < 1)) throw new RangeError('Agent poll interval must be positive or null.');
    this.scheduleTask = options.schedule ?? ((task, delayMs) => setTimeout(task, delayMs));
    this.cancelTask = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.trigger();
  }

  trigger(): void {
    if (!this.started) return;
    if (this.running) { this.rerunRequested = true; return; }
    this.clearTimer();
    this.timer = this.scheduleTask(() => { this.timer = null; void this.run(); }, 0);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.rerunRequested = false;
    this.clearTimer();
  }

  private async run(): Promise<void> {
    if (!this.started || this.running) return;
    this.running = true;
    this.rerunRequested = false;
    try { await this.options.poll(); this.failures = 0; }
    catch (cause) { this.failures += 1; this.options.onError(cause); }
    finally {
      this.running = false;
      const delay = this.rerunRequested ? 0 : this.options.intervalMs ?? (this.failures ? Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5)) : null);
      if (this.started && delay !== null) this.timer = this.scheduleTask(() => { this.timer = null; void this.run(); }, delay);
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.cancelTask(this.timer);
    this.timer = null;
  }
}
