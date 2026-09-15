import { Transform3D } from '@haiyue/engine/components';
import { Entity, CartesianTransform3D } from '@haiyue/engine';
import { finiteVector, inverse, multiply, projectedDragAngle, selectDragAxis, rotationAround, transformPoint, type Vector3 } from '@haiyue/ai-studio-script-preview/transforms';
/** Read from the current local chain, not a render-frame cache (scripts run before rendering). */
export function playWorldMatrix(entity: Entity, cache?: Map<number, Float32Array>): Float32Array {
    const previous = cache?.get(entity.id);
    if (previous)
        return previous;
    const local = entity.getComponent(Transform3D)?.localMatrix ?? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const result = entity.parent ? multiply(playWorldMatrix(entity.parent, cache), local) : new Float32Array(local);
    cache?.set(entity.id, result);
    return result;
}
export function createPlayTransforms(resolve: (id: string) => Entity, viewProjection: () => Float32Array, aspect: () => number) {
    return Object.freeze({
        worldPoint(id: string, point: Vector3): Vector3 { return transformPoint(playWorldMatrix(resolve(id)), point); },
        localPoint(id: string, point: Vector3): Vector3 { return transformPoint(inverse(playWorldMatrix(resolve(id))), point); },
        projectPoint(point: Vector3): readonly [
            number,
            number
        ] { const p = transformPoint(viewProjection(), point); return [(p[0] + 1) / 2, (1 - p[1]) / 2]; },
        dragAngle(point: Vector3, pivot: Vector3, axis: Vector3, delta: readonly [
            number,
            number
        ]): number | null { return projectedDragAngle(viewProjection(), point, pivot, axis, delta, aspect()); },
        dragAxis(point: Vector3, pivot: Vector3, axes: readonly Vector3[], delta: readonly [
            number,
            number
        ]) { return selectDragAxis(viewProjection(), point, pivot, axes, delta, aspect()); },
        capture(ids: readonly string[]): Readonly<{
            ids: readonly string[];
            worldMatrices: readonly (readonly number[])[];
        }> {
            if (!Array.isArray(ids) || ids.length < 1 || ids.length > 128 || new Set(ids).size !== ids.length)
                throw new Error('capture requires 1-128 unique entity ids.');
            const entities = ids.map(resolve);
            if (entities.some(e => entities.some(other => other !== e && isAncestor(other, e))))
                throw new Error('Capture motion roots only; do not include a root and its descendant.');
            return { ids: [...ids], worldMatrices: entities.map(e => Array.from(playWorldMatrix(e))) };
        },
        rotate(snapshot: Readonly<{
            ids: readonly string[];
            worldMatrices: readonly (readonly number[])[];
        }>, pivot: Vector3, axis: Vector3, radians: number): void {
            if (!snapshot || !Array.isArray(snapshot.ids) || snapshot.ids.length < 1 || snapshot.ids.length > 128 || snapshot.worldMatrices.length !== snapshot.ids.length || new Set(snapshot.ids).size !== snapshot.ids.length)
                throw new Error('Invalid transform snapshot.');
            finiteVector(pivot);
            const rotation = rotationAround(pivot, axis, radians);
            const entities = snapshot.ids.map(resolve);
            if (entities.some(e => entities.some(other => other !== e && isAncestor(other, e))))
                throw new Error('Rotate motion roots only.');
            const edits = entities.map((e, i) => { const tr = e.getComponent(CartesianTransform3D); if (!tr)
                throw new Error('Rotation needs CartesianTransform3D.'); const world = multiply(rotation, snapshot.worldMatrices[i]!); return { tr, m: e.parent ? multiply(inverse(playWorldMatrix(e.parent)), world) : world }; });
            for (const edit of edits)
                edit.tr.setMatrix(edit.m);
        },
    });
}
function isAncestor(parent: Entity, child: Entity): boolean { for (let p = child.parent; p; p = p.parent)
    if (p === parent)
        return true; return false; }
