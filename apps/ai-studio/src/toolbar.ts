export type ToolbarIcon = 'new' | 'open' | 'save' | 'play' | 'stop' | 'busy' | 'settings';

const paths: Readonly<Record<ToolbarIcon, string>> = {
  new: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8L14 2Zm0 0v6h6M12 12v6m-3-3h6',
  open: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 10h18l-3 10H3V10Z',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2ZM7 3v6h10V3M7 21v-8h10v8',
  play: 'm8 4 13 8-13 8V4Z',
  stop: 'M6 6h12v12H6Z',
  busy: 'M20 12a8 8 0 1 1-8-8',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3l-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-3H9Z',
};

/** Labels are shared by assistive technology and the public UI tooltip. */
export function updateToolbarButton(button: HTMLButtonElement, label: string, icon: ToolbarIcon): void {
  button.setAttribute('aria-label', label);
  button.removeAttribute('title');
  button.closest('hy-tooltip')?.setAttribute('label', label);
  if (button.dataset.icon === icon) return;
  const svg = button.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', icon === 'play' || icon === 'stop' ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = button.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[icon]);
  svg.append(path);
  button.replaceChildren(svg);
  button.dataset.icon = icon;
}
