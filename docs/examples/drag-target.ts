// Bind to entity:drag-target, with haiyue.interaction.pointer events down/move/up/drag/cancel,
// capturePointer=true and draggable=true on the body AND selectable child surfaces.
// Initial transforms belong in the Document. A missing interaction is only background
// after confirming coverage; this example scene has no unconfigured visible blockers.
// A SEPARATE camera/controller script calls api.scene.orbitControls({mode:'background'}).
// Decorative child surfaces may use penetrable:true with events:[] and no script.
type GestureState = { mode?: 'object' | 'camera' | ''; pointerId?: number; x?: number; y?: number; changes?: number; cancels?: number; initial?: ReturnType<typeof api.scene.transforms.capture>; pivot?: readonly [number,number,number] };
const state = component.data as unknown as GestureState;
const object = api.read.find('entity:drag-target');
if (!object) throw new Error('Missing drag target');

for (const event of api.input.pointerEvents()) {
  if (event.type === 'down') {
    const hit = api.input.interactions().find((hit: { type: string; entityId: string; pointerId: number }) => hit.type === 'down' && hit.pointerId === event.pointerId);
    let hitOwner: Entity | null = hit ? api.read.find(hit.entityId) : null;
    while (hitOwner && hitOwner !== object) hitOwner = hitOwner.parent;
    state.mode = hitOwner === object ? 'object' : '';
    state.pointerId = event.pointerId; state.x = event.x; state.y = event.y;
    if (state.mode) { state.initial = api.scene.transforms.capture(['entity:drag-target']); state.pivot = api.scene.transforms.worldPoint('entity:drag-target',[0,0,0]); }
  }
  if (event.pointerId !== state.pointerId) continue;
  if (event.type === 'move' && state.mode) {
    // Normalized displacement controls angle, not world position or picking.
    const dx = event.x - (state.x ?? event.x), dy = event.y - (state.y ?? event.y);
    // This example is a fixed world-Y turntable; layered games use dragAxis/dragAngle.
    if (state.mode === 'object' && state.initial && state.pivot) api.scene.transforms.rotate(state.initial, state.pivot, [0,1,0], dx * Math.PI);
    if (dx !== 0 || dy !== 0) state.changes = (state.changes ?? 0) + 1;
  }
  if (event.type === 'up' || event.type === 'cancel') {
    if (event.type === 'cancel') state.cancels = (state.cancels ?? 0) + 1;
    state.mode = ''; state.pointerId = undefined;
  }
}
if (api.input.interactions().some((hit: { type: string; pointerId: number }) => hit.type === 'cancel' && hit.pointerId === state.pointerId)) { state.mode = ''; state.pointerId = undefined; state.cancels = (state.cancels ?? 0) + 1; }
api.scene.observe('drag-state', { schemaVersion: 1, mode: state.mode ?? '', changes: state.changes ?? 0, cancels: state.cancels ?? 0 });
