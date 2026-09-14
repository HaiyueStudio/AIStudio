import { CartesianTransform3D, SphericalTransform3D, type Entity } from '@haiyue/engine';
import type { ReplayInputEvent } from '@haiyue/engine/experimental/simulation';

export interface PlayOrbitOptions {
  readonly enabled?: boolean;
  readonly mode?: 'all' | 'background';
  readonly target?: Readonly<{ x: number; y: number; z: number }>;
  readonly rotateSpeed?: number;
  readonly enableZoom?: boolean;
  readonly minRadius?: number;
  readonly maxRadius?: number;
}

/** Fixed-tick camera facade over Engine's spherical transform. No DOM listeners:
 * native and injected input share the same replay queue and gesture ownership. */
export class PlayOrbitControls {
  private owner: string | null = null;
  private camera: Entity | null = null;
  private lastTick = -1;
  private mode = 'all';
  private pointer: { id: number; x: number; y: number } | null = null;

  update(owner: string, camera: Entity, tick: number, events: readonly ReplayInputEvent[], hits: readonly { type: string; pointerId: number }[], options: PlayOrbitOptions = {}): void {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['enabled','mode','target','rotateSpeed','enableZoom','minRadius','maxRadius'].includes(key))) throw new TypeError('orbitControls options are invalid.');
    const speed = bounded(options.rotateSpeed, 1, 0, 10, 'rotateSpeed');
    const minimum = bounded(options.minRadius, .1, .001, 1e6, 'minRadius');
    const maximum = bounded(options.maxRadius, Math.max(10000, minimum), minimum, 1e6, 'maxRadius');
    const mode = options.mode ?? 'all';
    if (!['all','background'].includes(mode) || (options.enabled !== undefined && typeof options.enabled !== 'boolean') || (options.enableZoom !== undefined && typeof options.enableZoom !== 'boolean')) throw new TypeError('orbitControls mode/enabled/enableZoom are invalid.');
    if (options.target && (typeof options.target !== 'object' || Object.keys(options.target).sort().join(',') !== 'x,y,z' || ![options.target.x,options.target.y,options.target.z].every(value => Number.isFinite(value) && Math.abs(value) <= 1e6))) throw new TypeError('orbitControls target must be finite world x/y/z.');
    if (this.owner && this.owner !== owner && tick <= this.lastTick + 1) throw new Error('orbitControls must have one script owner per active camera.');
    if (this.owner === owner && tick === this.lastTick) return;
    if (this.owner !== owner || this.camera !== camera || tick !== this.lastTick + 1 || mode !== this.mode) this.pointer = null;
    this.owner = owner; this.lastTick = tick; this.mode = mode;
    if (options.enabled === false) { this.pointer = null; return; }
    let transform = camera.getComponent(SphericalTransform3D);
    if (!transform) {
      const cartesian = camera.getComponent(CartesianTransform3D);
      if (!cartesian) throw new Error('orbitControls needs an active 3D camera transform.');
      if (camera.parent) throw new Error('orbitControls requires a root camera; detach it from its parent before Play.');
      const target = options.target ?? { x: 0, y: 0, z: 0 };
      const x = cartesian.position[0]! - target.x, y = cartesian.position[1]! - target.y, z = cartesian.position[2]! - target.z;
      const radius = Math.hypot(x,y,z);
      if (radius < .001) throw new Error('orbitControls camera must be separated from its target.');
      transform = new SphericalTransform3D({ target: [target.x,target.y,target.z], radius, theta: Math.atan2(x,z), phi: Math.acos(Math.max(-1,Math.min(1,y/radius))) });
      camera.removeComponent(cartesian); camera.addComponent(transform);
    } else if (this.camera !== camera && options.target) {
      transform.setTarget(options.target.x, options.target.y, options.target.z);
    }
    this.camera = camera;
    for (const event of events) {
      if (event.kind === 'reset') { this.pointer = null; continue; }
      if (event.kind !== 'pointer') continue;
      if (event.phase === 'down') {
        if (this.pointer || (event.button ?? 0) !== 0) continue;
        if (mode === 'background' && hits.some(hit => hit.pointerId === event.pointerId && hit.type === 'down')) continue;
        this.pointer = { id: event.pointerId, x: event.x, y: event.y };
      } else if (event.phase === 'move' && this.pointer?.id === event.pointerId) {
        const dx = event.x - this.pointer.x, dy = event.y - this.pointer.y;
        transform.set(transform.radius, transform.theta - dx * Math.PI * 2 * speed, Math.max(.01, Math.min(Math.PI - .01, transform.phi - dy * Math.PI * speed)));
        this.pointer.x = event.x; this.pointer.y = event.y;
      } else if ((event.phase === 'up' || event.phase === 'cancel') && this.pointer?.id === event.pointerId) this.pointer = null;
      else if (event.phase === 'wheel' && options.enableZoom !== false && !(mode === 'background' && hits.some(hit => hit.pointerId === event.pointerId && hit.type === 'wheel'))) {
        transform.radius = Math.max(minimum, Math.min(maximum, transform.radius * (1 + (event.wheelY ?? 0) * .001)));
      }
    }
  }

  dispose(): void { this.owner = null; this.camera = null; this.pointer = null; this.lastTick = -1; }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`orbitControls ${label} must be between ${minimum} and ${maximum}.`);
  return value;
}
