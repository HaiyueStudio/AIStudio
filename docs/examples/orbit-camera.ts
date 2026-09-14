// Bind ONE controller script to a project entity. Call each fixed onUpdate tick.
// Use camera.set for the initial viewpoint; this call changes only the Play camera.
// Capabilities: input + scene. No imports, DOM listeners, ray math or raw camera casts.
api.scene.orbitControls({ mode: 'all', rotateSpeed: 0.9, enableZoom: true });
// For a game with draggable objects, use mode: 'background' and configure
// haiyue.interaction.pointer down/up/cancel on every selectable body/child surface.
// Verify play.inspect state.camera before/after actual play.pointer-gesture input.
