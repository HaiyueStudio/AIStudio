/** Local reading state only; never influences task execution or approval state. */
export interface ReadingPosition {
  readonly top: number;
  readonly anchor: HTMLElement | null;
  readonly offset: number;
}
export function captureReadingPosition(container: HTMLElement): ReadingPosition {
  const bounds = container.getBoundingClientRect?.();
  const anchor = bounds ? [...container.querySelectorAll<HTMLElement>('.chat-card')].find(card => {
    const rect = card.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom;
  }) ?? null : null;
  return { top: container.scrollTop, anchor, offset: anchor && bounds ? anchor.getBoundingClientRect().top - bounds.top : 0 };
}
export function restoreReadingPosition(container: HTMLElement, position: ReadingPosition | undefined, fallback: number): void {
  container.scrollTop = position?.top ?? fallback;
  if (position?.anchor?.isConnected && container.contains(position.anchor)) {
    container.scrollTop += position.anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset;
  }
}
