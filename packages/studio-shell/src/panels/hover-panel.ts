type HoverState = { key: string; pinned: boolean; pointer: { x: number; y: number } | null };

/** An interactive hover/focus panel in the native top layer, outside clipped graph canvases. */
export function createHoverPanel(document: Document, className: string, label: string) {
  const panel = document.createElement('div');
  panel.className = `chat-hover-panel ${className}`; panel.hidden = true;
  panel.setAttribute('popover', 'manual'); panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', label);
  panel.id = `chat-hover-${++nextPanelId}`;
  const lifetime = new AbortController(); const options = { signal: lifetime.signal };
  const bindings = new Map<string, { trigger: HTMLElement; populate?: () => void }>();
  const keyOf = (trigger: HTMLElement): string => trigger.dataset.nodeId ?? trigger.getAttribute('aria-label') ?? '';
  let anchor: HTMLElement | null = null; let pinned = false; let disposed = false; let restoringFocus = false;
  let pointer: HoverState['pointer'] = null;
  const trackPointer = (event: PointerEvent): void => { pointer = { x: event.clientX, y: event.clientY }; };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let focusFrame: number | undefined;
  const cancelClose = (): void => { clearTimeout(timer); timer = undefined; };
  const hide = (): void => {
    cancelClose(); if (!panel.hidden) panel.hidePopover?.(); panel.hidden = true;
    anchor?.setAttribute('aria-expanded', 'false'); anchor = null; pinned = false;
  };
  const scheduleClose = (): void => {
    cancelClose(); timer = setTimeout(() => {
      const underPointer = pointer ? document.elementFromPoint(pointer.x, pointer.y) : null;
      if (!pinned && !panel.contains(underPointer) && !anchor?.contains(underPointer)
        && !panel.contains(document.activeElement) && document.activeElement !== anchor) hide();
    }, 180);
  };
  const show = (trigger: HTMLElement, populate?: () => void): void => {
    if (disposed || restoringFocus || !trigger.isConnected || trigger.closest('.is-panning')) return;
    cancelClose();
    if (anchor !== trigger) { hide(); anchor = trigger; populate?.(); }
    panel.hidden = false; panel.showPopover?.(); trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect(); const bounds = panel.getBoundingClientRect();
    const width = document.documentElement.clientWidth; const height = document.documentElement.clientHeight;
    panel.style.left = `${Math.max(8, Math.min(rect.right - bounds.width, width - bounds.width - 8))}px`;
    const below = rect.bottom + 6; const above = rect.top - bounds.height - 6;
    panel.style.top = `${Math.max(8, Math.min(below + bounds.height <= height - 8 ? below : above, height - bounds.height - 8))}px`;
    scheduleClose();
  };
  const bind = (trigger: HTMLElement, populate?: () => void): void => {
    bindings.set(keyOf(trigger), { trigger, populate });
    trigger.setAttribute('aria-controls', panel.id); trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('pointerenter', event => { trackPointer(event); if (event.pointerType !== 'touch') show(trigger, populate); }, options);
    trigger.addEventListener('pointerleave', event => { trackPointer(event); scheduleClose(); }, options);
    trigger.addEventListener('focus', () => {
      // Keyboard focus can scroll an ancestor before the next frame. Open after that scroll.
      if (focusFrame !== undefined) document.defaultView?.cancelAnimationFrame(focusFrame);
      focusFrame = document.defaultView?.requestAnimationFrame(() => {
        focusFrame = undefined;
        if (document.activeElement === trigger && !restoringFocus) show(trigger, populate);
      });
    }, options);
    trigger.addEventListener('blur', scheduleClose, options);
    trigger.addEventListener('click', () => {
      if (anchor === trigger && pinned) hide(); else { show(trigger, populate); pinned = true; }
    }, options);
  };
  panel.addEventListener('pointerenter', event => { trackPointer(event); cancelClose(); }, options);
  panel.addEventListener('pointerleave', event => { trackPointer(event); scheduleClose(); }, options);
  panel.addEventListener('focusin', cancelClose, options);
  panel.addEventListener('focusout', scheduleClose, options);
  document.defaultView?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || panel.hidden) return;
    const trigger = anchor; const restore = panel.contains(document.activeElement);
    hide(); if (restore) { restoringFocus = true; trigger?.focus({ preventScroll: true }); restoringFocus = false; }
    if (focusFrame !== undefined) document.defaultView?.cancelAnimationFrame(focusFrame); focusFrame = undefined;
    event.preventDefault(); event.stopPropagation();
  }, options);
  document.defaultView?.addEventListener('pointerdown', event => {
    if (!panel.hidden && !panel.contains(event.target as Node) && !anchor?.contains(event.target as Node)) hide();
  }, options);
  document.defaultView?.addEventListener('scroll', event => {
    if (!panel.hidden && !panel.contains(event.target as Node)) hide();
  }, { ...options, capture: true, passive: true });
  document.defaultView?.addEventListener('resize', hide, options);
  document.defaultView?.addEventListener('pointermove', trackPointer, { ...options, passive: true });
  return {
    panel, bind, hide,
    snapshot(): HoverState | null { return anchor && !panel.hidden ? { key: keyOf(anchor), pinned, pointer } : null; },
    restore(state: HoverState): void {
      const binding = bindings.get(state.key); if (!binding) return;
      focusFrame = document.defaultView?.requestAnimationFrame(() => { focusFrame = undefined; pointer = state.pointer; show(binding.trigger, binding.populate); pinned = state.pinned; });
    },
    dispose(): void { disposed = true; hide(); if (focusFrame !== undefined) document.defaultView?.cancelAnimationFrame(focusFrame); lifetime.abort(); bindings.clear(); },
  };
}

let nextPanelId = 0;
