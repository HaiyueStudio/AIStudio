// Incremental object behavior: bind this script to the clicked mesh.
// Keep the existing camera orbitControls script unchanged.
// Configure haiyue.interaction.pointer on this object with events: ['click'].
// Parent scripts do not receive selfInteractions for child meshes: use the child's
// script or an explicit global controller filtering actual child stable ids.
// Colors are sRGB RGBA. This only changes the Play material, not saved properties.
const data = component.data as { colorIndex?: number };
const colors: readonly (readonly [number, number, number, number])[] = [
  [0.16, 0.58, 1, 1], [0.95, 0.18, 0.22, 1],
  [0.18, 0.82, 0.38, 1], [0.95, 0.68, 0.12, 1],
];
// Set the initial index to match the authored initial color.
const previous = data.colorIndex ?? 0;
for (const hit of api.input.selfInteractions()) {
  if (hit.type !== 'click') continue;
  const old = data.colorIndex ?? previous;
  // Sample among all other entries, so every click changes the color.
  const next = (old + 1 + Math.floor(Math.random() * (colors.length - 1))) % colors.length;
  api.scene.setMaterialColor(entity, colors[next]!);
  data.colorIndex = next;
}
// Acceptance: simulate clicks, inspect actual materialColor before/after,
// verify no repeated adjacent color, no background-click changes, and that
// dragging still changes camera state without triggering click recoloring.
// A script-reported color/click counter is not authoritative material evidence.
