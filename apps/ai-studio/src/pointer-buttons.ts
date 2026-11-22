type PointerPhase = 'move' | 'down' | 'up' | 'cancel';
const buttons = [0, 2, 1, 3, 4, 5] as const;
const mask = (button: number): number => button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : 1 << button;
export interface PointerButtonSample { readonly pointerId: number; readonly button: number; readonly buttons: number; }
export interface PointerButtonEdge { readonly phase: PointerPhase; readonly button?: number; }

/** Browser ids are opaque; Safari may use ids outside the bounded replay format. */
export class RuntimePointerIds {
  private readonly mapped = new Map<number, number>();
  private readonly occupied = new Set<number>();
  resolve(browserId: number): number | null {
    if (!Number.isSafeInteger(browserId)) return null;
    const existing = this.mapped.get(browserId);
    if (existing !== undefined) return existing;
    // Bound active contacts independently of the browser's monotonically growing ids.
    if (this.mapped.size >= 64) return null;
    let runtimeId = browserId >= 0 && browserId <= 1_000_000 ? browserId : 1;
    if (this.occupied.has(runtimeId)) {
      runtimeId = 1;
      while (this.occupied.has(runtimeId)) runtimeId++;
    }
    this.mapped.set(browserId, runtimeId);
    this.occupied.add(runtimeId);
    return runtimeId;
  }
  release(browserId: number): void {
    const runtimeId = this.mapped.get(browserId);
    if (runtimeId !== undefined) this.occupied.delete(runtimeId);
    this.mapped.delete(browserId);
  }
  clear(): void { this.mapped.clear(); this.occupied.clear(); }
}

/** DOM fires intermediate mouse-button changes as pointermove, not pointerdown/up. */
export class PointerButtonTracker {
  private readonly held = new Map<number, number>();
  translate(phase: PointerPhase, event: PointerButtonSample): readonly PointerButtonEdge[] {
    const previous = this.held.get(event.pointerId);
    if (phase === 'cancel') { this.held.delete(event.pointerId); return [{phase:'cancel'}]; }
    if (previous === undefined && phase !== 'down') return phase === 'move' ? [{phase:'move'}] : [];
    const current = event.buttons & 63;
    const before = previous ?? (current & ~mask(event.button));
    const changed = before ^ current;
    if (current) this.held.set(event.pointerId, current); else this.held.delete(event.pointerId);
    const edges: PointerButtonEdge[] = [];
    for (const button of buttons) if (changed & mask(button)) edges.push({phase:current & mask(button) ? 'down' : 'up',button});
    return edges.length ? edges : phase === 'move' ? [{phase:'move'}] : [];
  }
  clear(): void { this.held.clear(); }
  pressed(pointerId: number): readonly number[] { return buttons.filter(button => (this.held.get(pointerId) ?? 0) & mask(button)); }
  has(pointerId: number): boolean { return this.held.has(pointerId); }
}
