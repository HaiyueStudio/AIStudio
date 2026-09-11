import { createRoundedBox3D } from '@haiyue/engine/experimental';

/** Unit box centered at the local origin. Transform is applied after rounding. */
export const ROUNDED_BOX_PROPERTIES = Object.freeze({
  radius: { type: 'number', minimum: 0, maximum: 0.5, description: 'rounded-box only: corner radius in local units before Transform, 0..0.5; default 0.075. The unscaled box is 1 x 1 x 1. Zero disables rounding.' },
  segments: { type: 'integer', minimum: 1, maximum: 16, description: 'rounded-box only: subdivisions per rounded band, 1..16; default 4.' },
});

export function roundedBoxParameters(kind: unknown, input: { readonly radius?: unknown; readonly segments?: unknown }): { radius?: number; segments?: number } {
  const { radius, segments } = input;
  if ((radius !== undefined || segments !== undefined) && kind !== 'rounded-box') throw new TypeError('radius and segments are valid only for rounded-box geometry.');
  if (radius !== undefined && (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0 || radius > 0.5)) throw new TypeError('rounded-box radius must be finite and between 0 and 0.5 local units.');
  if (segments !== undefined && (typeof segments !== 'number' || !Number.isInteger(segments) || segments < 1 || segments > 16)) throw new TypeError('rounded-box segments must be an integer from 1 to 16.');
  return { ...(radius === undefined ? {} : { radius: radius as number }), ...(segments === undefined ? {} : { segments: segments as number }) };
}

export function createAuthoringRoundedBox(value: { readonly radius?: unknown; readonly segments?: unknown } = {}): ReturnType<typeof createRoundedBox3D> {
  return createRoundedBox3D({ width: 1, height: 1, depth: 1, radius: 0.075, segments: 4, ...roundedBoxParameters('rounded-box', value) });
}
