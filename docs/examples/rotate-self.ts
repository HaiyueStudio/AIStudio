// Studio onUpdate body; read capability. The entity has CartesianTransform3D.
// setRotation uses radians in parent-local space. delta is milliseconds.
// Authoring transform tools instead accept rotationDegrees.
const transform = entity.getComponent('CartesianTransform3D') as unknown as {
  rotation: Float32Array;
  setRotation(x: number, y: number, z: number): unknown;
} | null;
if (transform) {
  const radiansPerSecond = Math.PI / 2;
  transform.setRotation(transform.rotation[0], transform.rotation[1] + radiansPerSecond * delta / 1000, transform.rotation[2]);
}
