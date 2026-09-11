// onUpdate function body. Capabilities: input, scene.
// entity:board has haiyue.interaction.pointer with events: ['click'].
// This example uses an axis-aligned XZ grid in world space. Its origin and
// spacing are shared by snapping and rendering, independent of the camera.
const grid = { columns: 15, rows: 15, originX: -7, originZ: -7, spacing: 1 };
const state = component.data as unknown as { column?: number; row?: number; placements?: number };
for (const hit of api.input.interactions()) {
  if (hit.type !== 'click' || hit.entityId !== 'entity:board') continue;
  const column = Math.round((hit.point[0] - grid.originX) / grid.spacing);
  const row = Math.round((hit.point[2] - grid.originZ) / grid.spacing);
  if (column < 0 || column >= grid.columns || row < 0 || row >= grid.rows) continue;
  state.column = column;
  state.row = row;
  state.placements = (state.placements ?? 0) + 1;
}
const marker = api.scene.instances('entity:marker', 1);
marker.setCount(state.column === undefined ? 0 : 1);
if (state.column !== undefined && state.row !== undefined) {
  const position = { x: grid.originX + state.column * grid.spacing, y: 0.2, z: grid.originZ + state.row * grid.spacing };
  marker.set(0, { position, scale: { x: 0.4, y: 0.2, z: 0.4 } });
  api.scene.observe('placement', { schemaVersion: 1, column: state.column, row: state.row, placements: state.placements, position });
}
