import type { JsonObject, JsonValue } from '@haiyue/ai-studio-contracts';
import { multiply, rotationAround } from '@haiyue/ai-studio-script-preview/transforms';
import { GameToolProtocolError } from './types.js';
const object = (v: JsonValue | undefined): JsonObject => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : {};
export const rotationSchema = { type: 'object', additionalProperties: false, required: ['entityIds', 'pivot', 'axis', 'angleDegrees'], properties: {
        entityIds: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', pattern: '^entity:[A-Za-z0-9._:-]{3,160}$' } },
        pivot: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }, axis: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
        angleDegrees: { type: 'number', minimum: -360, maximum: 360 }, tolerance: { type: 'number', minimum: 0.000001, maximum: 0.01 }, requireIntermediate: { type: 'boolean' }
    } };
export function normalizeRotation(value: unknown): JsonObject {
    const v = value as JsonObject;
    if (!v || Array.isArray(v) || typeof v !== 'object' || Object.keys(v).some(k => !Object.keys(rotationSchema.properties).includes(k)))
        throw new GameToolProtocolError('tool.arguments-invalid', 'Invalid rotation expectation.');
    const ids = v.entityIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 128 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^entity:[A-Za-z0-9._:-]{3,160}$/.test(id)))
        throw new GameToolProtocolError('tool.arguments-invalid', 'rotation.entityIds requires 1-128 unique entity ids.');
    for (const key of ['pivot', 'axis'])
        if (!Array.isArray(v[key]) || (v[key] as JsonValue[]).length !== 3 || (v[key] as JsonValue[]).some(n => typeof n !== 'number' || !Number.isFinite(n)))
            throw new GameToolProtocolError('tool.arguments-invalid', `rotation.${key} must be finite world [x,y,z].`);
    if (Math.hypot(...v.axis as number[]) < 1e-8 || typeof v.angleDegrees !== 'number' || !Number.isFinite(v.angleDegrees) || Math.abs(v.angleDegrees) > 360 || (v.tolerance !== undefined && (typeof v.tolerance !== 'number' || v.tolerance < 1e-6 || v.tolerance > 0.01)) || (v.requireIntermediate !== undefined && typeof v.requireIntermediate !== 'boolean'))
        throw new GameToolProtocolError('tool.arguments-invalid', 'Invalid rotation angle/axis/tolerance/intermediate expectation.');
    return v;
}
function entities(v: JsonObject): Map<string, JsonObject> { const rows = object(v.state).entities; return new Map((Array.isArray(rows) ? rows : []).flatMap(e => { const row = object(e); return typeof row.id === 'string' ? [[row.id, row] as const] : []; })); }
function world(e: JsonObject | undefined): number[] | null { const m = e?.worldMatrix; return Array.isArray(m) && m.length === 16 && m.every(n => typeof n === 'number' && Number.isFinite(n)) ? m as number[] : null; }
function near(a: readonly number[] | Float32Array, b: readonly number[] | Float32Array, t: number): boolean { return a.every((v, i) => Math.abs(v - b[i]!) <= t); }
export function verifyRotation(before: JsonObject, after: JsonObject, samples: readonly JsonObject[], expect: JsonObject): JsonObject {
    const old = entities(before), next = entities(after), ids = expect.entityIds as string[], t = Number(expect.tolerance ?? 0.001);
    const r = rotationAround(expect.pivot as number[], expect.axis as number[], Number(expect.angleDegrees) * Math.PI / 180);
    const mismatches: string[] = [];
    for (const id of ids) {
        const a = world(old.get(id)), b = world(next.get(id));
        if (!a || !b) {
            mismatches.push(`${id}: missing world matrix`);
            continue;
        }
        if (!near(multiply(r, a), b, t))
            mismatches.push(`${id}: world position/orientation does not match the expected axis, pivot and signed angle`);
    }
    // Check every nonmember, including descendants through the expected rigid transform.
    const beforeParents = new Map([...old].map(([id, e]) => [id, e.parentId]));
    function affected(id: string): boolean { const seen = new Set<string>(); for (let p: string | undefined = id; p && !seen.has(p);) {
        if (ids.includes(p))
            return true;
        seen.add(p);
        const parent = beforeParents.get(p);
        p = typeof parent === 'string' ? parent : undefined;
    } return false; }
    for (const [id, e] of old) {
        if (ids.includes(id))
            continue;
        const a = world(e), b = world(next.get(id));
        if (!a || !b) {
            mismatches.push(`${id}: missing world matrix`);
            continue;
        }
        const expected = affected(id) ? multiply(r, a) : a;
        if (!near(expected, b, t))
            mismatches.push(`${id}: unexpected nonmember/descendant transform`);
    }
    for (const id of next.keys())
        if (!old.has(id))
            mismatches.push(`${id}: unexpected new entity`);
    const intermediate = samples.some(sample => { const es = entities(sample); return ids.some(id => { const a = world(old.get(id)), b = world(es.get(id)), end = world(next.get(id)); return !!a && !!b && !!end && !near(a, b, t) && !near(end, b, t); }); });
    if (expect.requireIntermediate === true && !intermediate)
        mismatches.push('No actual intermediate transform was observed before release.');
    return { rotationMatched: mismatches.length === 0, intermediateMotion: intermediate, rotationMismatches: mismatches.slice(0, 16), rotationMismatchesTruncated: mismatches.length > 16 };
}
