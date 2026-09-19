/** Runtime-local timing metadata; provider UsageRecord remains unchanged. */
export class ActivityClock {
  private readonly closed: Array<readonly [number, number]> = [];
  private activeSince: number | null;
  private observed: number;
  private depth = 0;
  private finished = false;
  constructor(startedAtMs: number) { this.observed = startedAtMs; this.activeSince = startedAtMs; this.observe(startedAtMs); }
  observe(at: number): void { if (!Number.isFinite(at) || at < 0) throw new TypeError('Invalid activity time.'); if (!this.finished) this.observed = Math.max(this.observed, at); }
  pause(at: number): void {
    if (this.finished) return;
    this.observe(at);
    if (this.depth++ === 0) this.close();
  }
  resume(at: number): void {
    if (this.finished || !this.depth) return;
    this.observe(at);
    if (--this.depth === 0) this.activeSince = this.observed;
  }
  finish(at: number): void { if (this.finished) return; this.observe(at); this.close(); this.finished = true; }
  intervals(at?: number): readonly (readonly [number, number])[] {
    if (at !== undefined) this.observe(at);
    return Object.freeze([...this.closed, ...(this.activeSince === null ? [] : [Object.freeze([this.activeSince, this.observed] as const)])]);
  }
  private close(): void {
    if (this.activeSince !== null && this.observed > this.activeSince) this.closed.push(Object.freeze([this.activeSince, this.observed] as const));
    this.activeSince = null;
  }
}

/** Union, not sum/max: handles parallel turns, serial turns, tools and human pauses. */
export function activeDuration(intervals: readonly (readonly [number, number])[]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0, start = 0, end = 0;
  for (const [left, right] of sorted) {
    if (left > end) { total += end - start; start = left; end = right; }
    else end = Math.max(end, right);
  }
  return Math.max(0, Math.floor(total + end - start));
}
