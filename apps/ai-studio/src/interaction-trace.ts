import type { JsonObject, JsonValue } from '@haiyue/ai-studio-contracts';

/** Tick-local host facts. Never persist a per-frame journal or infer that reading
 * an event means the script handled it successfully. */
export class InteractionTrace {
  private tick = -1;
  private hits: JsonObject[] = [];
  private reads: JsonObject[] = [];
  private truncated = false;
  begin(tick: number): void { this.tick = tick; this.hits = []; this.reads = []; this.truncated = false; }
  hit(value: JsonObject): void { if (this.hits.length < 64) this.hits.push(value); else this.truncated = true; }
  read(scriptId: string, entityId: string, scope: 'global' | 'self', events: readonly { entityId: string }[]): void {
    if (!this.hits.length) return;
    const ids = [...new Set(events.map(event => event.entityId))];
    const value = { scriptId, entityId, scope, eventCount: events.length, entityIds: ids.slice(0, 8), entityIdsTruncated: ids.length > 8 };
    const existing = this.reads.findIndex(item => item.scriptId === scriptId && item.scope === scope);
    if (existing >= 0) this.reads[existing] = value;
    else if (this.reads.length < 32) this.reads.push(value);
    else this.truncated = true;
  }
  snapshot(orbit: JsonValue): JsonObject { return { tick: this.tick, hits: this.hits, reads: this.reads, orbit, truncated: this.truncated }; }
  clear(): void { this.begin(-1); }
}
