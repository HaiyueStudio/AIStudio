import type { JsonObject } from '@haiyue/ai-studio-contracts';

/** Presentation only: uses the same normalized viewport coordinates as Play input. */
export class AgentPreviewCursor {
  private root: HTMLElement | null = null;
  private cursor: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private readonly pressed = new Map<number, Set<number>>();
  private readonly marks = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  private disposed = false;

  show(host: HTMLElement, event: JsonObject, language: string): void {
    if (this.disposed) return;
    if (event.kind === 'reset') { this.clear(); return; }
    if (event.kind !== 'pointer' || typeof event.x !== 'number' || typeof event.y !== 'number'
      || !Number.isFinite(event.x) || !Number.isFinite(event.y) || event.x < 0 || event.x > 1 || event.y < 0 || event.y > 1
      || !['move', 'down', 'up', 'cancel', 'wheel'].includes(String(event.phase))) return;
    if (this.root?.parentElement !== host) {
      this.clear();
      this.root = document.createElement('div'); this.root.className = 'agent-pointer-overlay'; this.root.setAttribute('aria-hidden', 'true');
      this.cursor = document.createElement('div'); this.cursor.className = 'agent-pointer';
      this.cursor.innerHTML = '<svg viewBox="0 0 28 32" width="28" height="32"><path d="M2 2L2 25L9 19L14 30L19 27L14 17L24 17Z" fill="currentColor" stroke="#101525" stroke-width="2" stroke-linejoin="round"/></svg>';
      this.label = document.createElement('span'); this.label.className = 'agent-pointer-label';
      this.cursor.append(this.label); this.root.append(this.cursor); host.append(this.root);
    }
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    const buttons = this.pressed.get(pointerId) ?? new Set<number>();
    const button = typeof event.button === 'number' ? event.button : 0;
    if (event.phase === 'down') buttons.add(button);
    if (event.phase === 'up') buttons.delete(button);
    if (event.phase === 'cancel') buttons.clear();
    if (buttons.size) this.pressed.set(pointerId, buttons); else this.pressed.delete(pointerId);
    const phase = event.phase === 'move' && buttons.size ? 'drag' : String(event.phase);
    const labels: Record<string, string> = language === 'zh-CN'
      ? { move: '移动', down: '按下', drag: '拖动', up: '抬起', cancel: '取消', wheel: '滚动' }
      : { move: 'Move', down: 'Press', drag: 'Drag', up: 'Release', cancel: 'Cancel', wheel: 'Scroll' };
    this.cursor!.dataset.state = phase;
    this.cursor!.style.left = `${event.x * 100}%`; this.cursor!.style.top = `${event.y * 100}%`;
    this.cursor!.dataset.edge = event.x > 0.75 ? 'right' : 'left';
    this.cursor!.dataset.verticalEdge = event.y > 0.8 ? 'bottom' : 'top';
    this.label!.textContent = `AI · ${labels[phase]}`;
    if (['down', 'up', 'cancel', 'wheel'].includes(phase)) {
      // Keep both press and release visible even when consecutive inputs finish in one frame.
      const mark = document.createElement('span'); mark.className = 'agent-pointer-mark'; mark.dataset.state = phase;
      mark.style.left = `${event.x * 100}%`; mark.style.top = `${event.y * 100}%`;
      this.root!.append(mark);
      this.marks.set(mark, setTimeout(() => { mark.remove(); this.marks.delete(mark); }, 900));
      if (this.marks.size > 12) { const first = this.marks.keys().next().value!; clearTimeout(this.marks.get(first)); first.remove(); this.marks.delete(first); }
    }
  }

  clear(): void {
    for (const timer of this.marks.values()) clearTimeout(timer);
    this.marks.clear(); this.pressed.clear(); this.root?.remove(); this.root = this.cursor = this.label = null;
  }
  dispose(): void { this.clear(); this.disposed = true; }
}
