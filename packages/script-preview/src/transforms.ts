import { mat4 } from 'wgpu-matrix';
export type Vector3 = readonly [
    number,
    number,
    number
];
export function finiteVector(value: readonly number[]): Vector3 {
    if (value.length !== 3 || !value.every(Number.isFinite))
        throw new TypeError('Expected a finite [x,y,z] vector.');
    return [value[0]!, value[1]!, value[2]!];
}
export function matrix(value: readonly number[] | Float32Array): Float32Array {
    if (value.length !== 16 || !Array.from(value).every(Number.isFinite))
        throw new TypeError('Expected a finite column-major matrix.');
    return new Float32Array(value);
}
export function inverse(value: readonly number[] | Float32Array): Float32Array {
    const m = matrix(value);
    if (Math.abs(mat4.determinant(m)) < 1e-10)
        throw new Error('Cannot invert a singular transform.');
    return mat4.inverse(m) as Float32Array;
}
export function multiply(a: readonly number[] | Float32Array, b: readonly number[] | Float32Array): Float32Array { return mat4.multiply(matrix(a), matrix(b)) as Float32Array; }
export function transformPoint(m: readonly number[] | Float32Array, point: readonly number[]): Vector3 {
    const p = finiteVector(point), a = matrix(m);
    const w = a[3]! * p[0] + a[7]! * p[1] + a[11]! * p[2] + a[15]!;
    if (Math.abs(w) < 1e-10)
        throw new Error('Point projects to infinity.');
    return [(a[0]! * p[0] + a[4]! * p[1] + a[8]! * p[2] + a[12]!) / w, (a[1]! * p[0] + a[5]! * p[1] + a[9]! * p[2] + a[13]!) / w, (a[2]! * p[0] + a[6]! * p[1] + a[10]! * p[2] + a[14]!) / w];
}
/** Left-multiply WORLD matrices: positions and orientations rotate together. */
export function rotationAround(pivot: readonly number[], axis: readonly number[], radians: number): Float32Array {
    const p = finiteVector(pivot), a = finiteVector(axis);
    if (!Number.isFinite(radians) || Math.hypot(...a) < 1e-8)
        throw new TypeError('Rotation requires a nonzero axis and finite radians.');
    return mat4.multiply(mat4.translation(p), mat4.multiply(mat4.axisRotation(a, radians), mat4.translation(p.map(v => -v)))) as Float32Array;
}
/** Project a small positive world-axis rotation to the actual camera/viewport.
 * Return signed radians for the supplied canvas-normalized drag, or null for a degenerate tangent. */
export function projectedDragAngle(viewProjection: readonly number[] | Float32Array, point: readonly number[], pivot: readonly number[], axis: readonly number[], delta: readonly [
    number,
    number
], aspect: number): number | null {
    if (!delta.every(Number.isFinite) || !Number.isFinite(aspect) || aspect <= 0)
        throw new TypeError('Invalid drag or viewport aspect.');
    const p = finiteVector(point), start = transformPoint(viewProjection, p);
    const end = transformPoint(viewProjection, transformPoint(rotationAround(pivot, axis, 0.001), p));
    const tx = (end[0] - start[0]) * 0.5 * aspect / 0.001, ty = -(end[1] - start[1]) * 0.5 / 0.001;
    const length = tx * tx + ty * ty;
    return length < 1e-10 ? null : (delta[0] * aspect * tx + delta[1] * ty) / length;
}
/** Pick the candidate whose screen tangent best aligns with the drag. */
export function selectDragAxis(viewProjection: readonly number[] | Float32Array, point: readonly number[], pivot: readonly number[], axes: readonly Vector3[], delta: readonly [
    number,
    number
], aspect: number): {
    axis: Vector3;
    angle: number;
} | null {
    if (!Array.isArray(axes) || axes.length < 1 || axes.length > 3)
        throw new TypeError('Provide 1-3 candidate world axes.');
    const p = finiteVector(point), start = transformPoint(viewProjection, p);
    let best: {
        axis: Vector3;
        angle: number;
    } | null = null, score = -1;
    for (const axis of axes) {
        const angle = projectedDragAngle(viewProjection, p, pivot, axis, delta, aspect);
        if (angle === null)
            continue;
        const end = transformPoint(viewProjection, transformPoint(rotationAround(pivot, axis, .001), p));
        const tx = (end[0] - start[0]) * aspect, ty = -(end[1] - start[1]);
        const alignment = Math.abs(delta[0] * aspect * tx + delta[1] * ty) / Math.hypot(tx, ty);
        if (alignment > score) {
            score = alignment;
            best = { axis: finiteVector(axis), angle };
        }
    }
    return Math.hypot(delta[0] * aspect, delta[1]) < 1e-6 ? null : best;
}
