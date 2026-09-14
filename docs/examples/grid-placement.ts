// onUpdate function body. Capabilities: input, scene.
// entity:board has haiyue.interaction.pointer with events: ['click'].
// This example uses an axis-aligned XZ grid in world space. Its origin and
// spacing are shared by snapping and rendering, independent of the camera.
// Texture recipe: 1024 x 1024, exactly 15 lines per axis at 64 + i * 64
// for i=0..14 (last line 960). Board spans 16 world units, centered at 0.
// Use the SAME definition for texture generation, picking, rendering and tests.
const layout = { count: 15, textureSize: 1024, firstPixel: 64, lastPixel: 960, boardSize: 16 };
const grid = { columns: layout.count, rows: layout.count,
  originX: (layout.firstPixel / layout.textureSize - 0.5) * layout.boardSize,
  originZ: (layout.firstPixel / layout.textureSize - 0.5) * layout.boardSize,
  spacing: (layout.lastPixel - layout.firstPixel) / (layout.count - 1) / layout.textureSize * layout.boardSize };
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
