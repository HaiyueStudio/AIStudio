// Bind to entity:drag-target, with haiyue.interaction.pointer events down/move/up/drag/cancel,
// capturePointer=true and draggable=true. Initial transforms belong in the Document.
// This example uses the preview's spherical camera; inspect the active camera component
// before adapting it to a project with a Cartesian gameplay camera.
type GestureState = { mode?: 'object' | 'camera' | ''; pointerId?: number; x?: number; y?: number; changes?: number; cancels?: number };
const state = component.data as unknown as GestureState;
const object = api.read.find('entity:drag-target');
if (!object) throw new Error('Missing drag target');
const transform = object.getComponent('CartesianTransform3D') as unknown as { rotation: Float32Array; setRotation(x: number, y: number, z: number): unknown };
const cameraEntity = api.read.findAll().find((candidate: Entity) => candidate.getComponent('Camera3D') !== null);
const camera = cameraEntity?.getComponent('SphericalTransform3D') as unknown as { theta: number; phi: number } | null;
for (const event of api.input.pointerEvents()) {
  if (event.type === 'down') {
    const hit = api.input.interactions().find((hit: { type: string; entityId: string; pointerId: number }) => hit.type === 'down' && hit.pointerId === event.pointerId);
    state.mode = hit?.entityId === 'entity:drag-target' ? 'object' : !hit ? 'camera' : '';
    state.pointerId = event.pointerId; state.x = event.x; state.y = event.y;
  }
  if (event.pointerId !== state.pointerId) continue;
  if (event.type === 'move' && state.mode) {
    // Normalized displacement controls angle, not world position or picking.
    const dx = event.x - (state.x ?? event.x), dy = event.y - (state.y ?? event.y);
    if (state.mode === 'object') transform.setRotation(transform.rotation[0], transform.rotation[1] + dx * Math.PI, transform.rotation[2]);
    else if (camera) { camera.theta += dx * Math.PI; camera.phi = Math.max(.1, Math.min(Math.PI - .1, camera.phi + dy * Math.PI)); }
    else throw new Error('Expected spherical camera');
    state.x = event.x; state.y = event.y;
    if (dx !== 0 || dy !== 0) state.changes = (state.changes ?? 0) + 1;
  }
  if (event.type === 'up' || event.type === 'cancel') {
    if (event.type === 'cancel') state.cancels = (state.cancels ?? 0) + 1;
    state.mode = ''; state.pointerId = undefined;
  }
}
if (api.input.interactions().some((hit: { type: string; pointerId: number }) => hit.type === 'cancel' && hit.pointerId === state.pointerId)) { state.mode = ''; state.pointerId = undefined; state.cancels = (state.cancels ?? 0) + 1; }
api.scene.observe('drag-state', { schemaVersion: 1, mode: state.mode ?? '', changes: state.changes ?? 0, cancels: state.cancels ?? 0 });
