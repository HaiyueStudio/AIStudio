type HoverState = { key: string; pinned: boolean; pointer: { x: number; y: number } | null };

/** An interactive hover/focus panel in the native top layer, outside clipped graph canvases. */
export function createHoverPanel(document: Document, className: string, label: string) {
  const panel = document.createElement('div');
  panel.className = `chat-hover-panel ${className}`; panel.hidden = true;
  panel.setAttribute('popover', 'manual'); panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', label);
  panel.id = `chat-hover-${++nextPanelId}`;
  const lifetime = new AbortController(); const options = { signal: lifetime.signal };
  const bindings = new Map<string, { trigger: HTMLElement; populate?: () => void; lifetime: AbortController }>();
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
      timer = undefined;
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
    panel.style.maxHeight = '';
    const rect = trigger.getBoundingClientRect(); const bounds = panel.getBoundingClientRect();
    const width = document.documentElement.clientWidth; const height = document.documentElement.clientHeight;
    let left = Math.max(8, Math.min(rect.right - bounds.width, width - bounds.width - 8));
    let top = rect.bottom + 6;
    const below = height - rect.bottom - 14; const above = rect.top - 14;
    // Rich details must not cover their trigger and intercept its click or drag.
    if (bounds.height <= below) top = rect.bottom + 6;
    else if (bounds.height <= above) top = rect.top - bounds.height - 6;
    else if (rect.right + bounds.width + 14 <= width || rect.left >= bounds.width + 14) {
      left = rect.right + bounds.width + 14 <= width ? rect.right + 6 : rect.left - bounds.width - 6;
      top = Math.max(8, Math.min(rect.top, height - bounds.height - 8));
    } else {
      const available = Math.max(1, Math.max(below, above));
      panel.style.maxHeight = `${available}px`;
      top = below >= above ? rect.bottom + 6 : rect.top - panel.getBoundingClientRect().height - 6;
    }
    panel.style.left = `${left}px`; panel.style.top = `${Math.max(8, top)}px`;
    scheduleClose();
  };
  const unbind = (trigger: HTMLElement): void => {
    const key = keyOf(trigger); const binding = bindings.get(key);
    if (binding?.trigger !== trigger) return;
    if (anchor === trigger) hide();
    binding.lifetime.abort(); bindings.delete(key);
  };
  const bind = (trigger: HTMLElement, populate?: () => void): void => {
    const previous = bindings.get(keyOf(trigger)); if (previous) unbind(previous.trigger);
    const bindingLifetime = new AbortController(); const options = { signal: bindingLifetime.signal };
    bindings.set(keyOf(trigger), { trigger, populate, lifetime: bindingLifetime });
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
  document.defaultView?.addEventListener('pointermove', event => {
    trackPointer(event);
    // After a streamed rerender, the replacement panel may never receive pointerleave.
    if (!panel.hidden && !pinned && timer === undefined && !panel.contains(event.target as Node) && !anchor?.contains(event.target as Node)) scheduleClose();
  }, { ...options, passive: true });
  return {
    panel, bind, unbind, hide,
    refresh(key: string): void {
      if (!anchor || panel.hidden || keyOf(anchor) !== key) return;
      const scrollTop = panel.scrollTop; const scrollLeft = panel.scrollLeft;
      const expanded = [...panel.querySelectorAll('details')].map(detail => detail.open);
      bindings.get(key)?.populate?.();
      panel.querySelectorAll('details').forEach((detail, index) => { if (expanded[index] !== undefined) detail.open = expanded[index]!; });
      panel.scrollTop = scrollTop; panel.scrollLeft = scrollLeft;
    },
    snapshot(): HoverState | null { return anchor && !panel.hidden ? { key: keyOf(anchor), pinned, pointer } : null; },
    restore(state: HoverState): void {
      const binding = bindings.get(state.key); if (!binding) return;
      focusFrame = document.defaultView?.requestAnimationFrame(() => { focusFrame = undefined; pointer = state.pointer; show(binding.trigger, binding.populate); pinned = state.pinned; });
    },
    dispose(): void { disposed = true; hide(); if (focusFrame !== undefined) document.defaultView?.cancelAnimationFrame(focusFrame); lifetime.abort(); for (const binding of bindings.values()) binding.lifetime.abort(); bindings.clear(); },
  };
}

let nextPanelId = 0;
