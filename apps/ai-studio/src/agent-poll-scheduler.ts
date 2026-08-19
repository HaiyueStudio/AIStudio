export interface AgentPollSchedulerOptions {
  readonly intervalMs: number;
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

  constructor(private readonly options: AgentPollSchedulerOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1) throw new RangeError('Agent poll interval must be positive.');
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
    try { await this.options.poll(); }
    catch (cause) { this.options.onError(cause); }
    finally {
      this.running = false;
      if (this.started) this.timer = this.scheduleTask(() => { this.timer = null; void this.run(); }, this.rerunRequested ? 0 : this.options.intervalMs);
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.cancelTask(this.timer);
    this.timer = null;
  }
}
