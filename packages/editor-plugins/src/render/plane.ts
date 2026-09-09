import { createPlane3D } from '@haiyue/engine';

/** Shared by the authoring projection and Play. Legacy geometry is local XY, facing +Z. */
export function createAuthoringPlane(plane: unknown = 'xy'): ReturnType<typeof createPlane3D> {
  if (plane !== 'xy' && plane !== 'xz' && plane !== 'yz') throw new TypeError('Geometry plane must be xy, xz or yz.');
  return createPlane3D({ normal: plane === 'xz' ? 'y' : plane === 'yz' ? 'x' : 'z' });
}
