/** Drag a graph's scroll viewport without turning a drag into a node click.
 * All listeners and pointer capture belong to the viewport's lifetime. */
export function attachGraphPan(viewport: HTMLElement, onPan?: () => void): () => void {
  const lifetime = new AbortController();
  let pointer: { id: number; button: number; x: number; y: number; left: number; top: number; target: Element; moved: boolean } | null = null;
  let suppressClick = false;
  const finish = () => {
    const previous = pointer; pointer = null;
    viewport.classList.remove('is-panning');
    if (previous?.moved) suppressClick = true;
    if (previous?.target.hasPointerCapture(previous.id)) previous.target.releasePointerCapture(previous.id);
  };
  viewport.classList.add('graph-pan-viewport');
  viewport.addEventListener('pointerdown', event => {
    if (pointer || !event.isPrimary || ![0, 1].includes(event.button) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target as Element | null;
    if (!target?.closest || target.closest('input, textarea, select, a, [contenteditable="true"]')) return;
    // Leave native scrollbar tracks and thumbs to the browser.
    const bounds = viewport.getBoundingClientRect(), x = event.clientX - bounds.left - viewport.clientLeft, y = event.clientY - bounds.top - viewport.clientTop;
    if (x < 0 || y < 0 || x >= viewport.clientWidth || y >= viewport.clientHeight) return;
    suppressClick = false;
    pointer = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, target, moved: false };
    // Capture on the original target so an ordinary click still reaches its node.
    target.setPointerCapture(event.pointerId);
    if (event.button === 1) event.preventDefault();
  }, { signal: lifetime.signal });
  viewport.addEventListener('pointermove', event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!(event.buttons & (pointer.button === 1 ? 4 : 1))) { finish(); return; }
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    if (!pointer.moved && Math.hypot(dx, dy) < 4) return;
    pointer.moved = true;
    viewport.classList.add('is-panning');
    event.preventDefault();
    viewport.scrollLeft = pointer.left - dx;
    viewport.scrollTop = pointer.top - dy;
    onPan?.();
  }, { signal: lifetime.signal });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) viewport.addEventListener(name, event => { if (event.pointerId === pointer?.id) finish(); }, { signal: lifetime.signal });
  for (const name of ['click', 'auxclick'] as const) viewport.addEventListener(name, event => {
    if (suppressClick && event.detail > 0) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
  }, { capture: true, signal: lifetime.signal });
  viewport.addEventListener('dragstart', event => event.preventDefault(), { signal: lifetime.signal });
  return () => { finish(); lifetime.abort(); viewport.classList.remove('graph-pan-viewport'); };
}
