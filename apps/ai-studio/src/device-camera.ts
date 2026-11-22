import type { Camera3D } from '@haiyue/engine/components';

/** Keep the configured camera span on the shorter screen axis for device play. */
export function fitDeviceCamera(camera: Camera3D, aspect: number, enabled: boolean): void {
  if (!enabled || !Number.isFinite(aspect) || aspect <= 0 || aspect >= 1) return;
  const factor = 1 / Math.max(aspect, 0.000001);
  if (camera.projectionType === 'orthographic') {
    camera.orthoLeft *= factor; camera.orthoRight *= factor;
    camera.orthoTop *= factor; camera.orthoBottom *= factor;
  } else {
    camera.fov = Math.min(Math.PI - 0.000001, 2 * Math.atan(Math.tan(camera.fov / 2) * factor));
  }
}
