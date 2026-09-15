/** Keep retained children connected; do not move a persistent popover/viewport
 * through a detached fragment while replacing its surrounding controls. */
export function reconcileChildren(parent: HTMLElement, children: readonly Node[]): void {
  if (!parent.childNodes || !parent.insertBefore) { parent.replaceChildren(...children); return; }
  const retained = new Set(children);
  for (const child of [...parent.childNodes]) if (!retained.has(child)) parent.removeChild(child);
  let next = parent.firstChild;
  for (const child of children) {
    if (child === next) next = next.nextSibling;
    else parent.insertBefore(child, next);
  }
}
