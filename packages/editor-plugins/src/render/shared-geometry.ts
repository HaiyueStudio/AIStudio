import { createBox3D, createSphere3D, type Geometry3D } from '@haiyue/engine';
import { createCone3D, createCylinder3D, createIcosahedron3D, createTorus3D } from '@haiyue/engine/experimental';
import { createAuthoringRoundedBox, roundedBoxParameters } from './rounded-box.js';
import { createAuthoringPlane } from './plane.js';

/** Geometry identity excludes names, entity ids, transforms and material colors. */
export function geometryDefinition(kind: string, value: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, string | number>> {
  if (kind === 'rounded-box') return { kind, radius: 0.075, segments: 4, ...roundedBoxParameters(kind, value) };
  if (kind === 'plane') return { kind, plane: typeof value.plane === 'string' ? value.plane : 'xy' };
  return { kind };
}
/** Owned by one projection/build. Eviction never destroys geometry still used by a mesh. */
export class SharedGeometryPool {
  private readonly values = new Map<string, Geometry3D>();
  get(kind: string, value: Readonly<Record<string, unknown>> = {}): Geometry3D {
    const definition = geometryDefinition(kind, value), key = JSON.stringify(definition);
    const prior = this.values.get(key); if (prior) return prior;
    let geometry: Geometry3D;
    switch (kind) {
      case 'rounded-box': geometry = createAuthoringRoundedBox(value); break;
      case 'plane': geometry = createAuthoringPlane(value.plane); break;
      case 'cube': geometry = createBox3D(); break;
      case 'sphere': geometry = createSphere3D(); break;
      case 'cone': geometry = createCone3D(); break;
      case 'cylinder': geometry = createCylinder3D(); break;
      case 'torus': geometry = createTorus3D(); break;
      case 'icosahedron': geometry = createIcosahedron3D(); break;
      default: throw new Error(`Unsupported shared geometry ${kind}.`);
    }
    if (this.values.size >= 512) this.values.delete(this.values.keys().next().value!);
    this.values.set(key, geometry); return geometry;
  }
  clear(): void { this.values.clear(); }
}
