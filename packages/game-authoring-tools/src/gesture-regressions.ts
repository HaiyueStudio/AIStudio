import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import type { GamePlayObservation } from './types.js';
import { GameToolProtocolError } from './types.js';
interface Regression {
    id: string;
    label: string;
    sequence: JsonObject[];
    baseline: JsonObject;
    revision: number;
    passed: boolean;
}
const record = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** Test definitions are project/document-scoped journal artifacts, independent of model turns.
 * Never overwrite the original expectation on replay; every verdict appends a fact. */
export class GestureRegressions {
    private project = '';
    private document = '';
    private scanned = -1;
    private cases = new Map<string, Regression>();
    private refs = new Map<string, string>();
    private play = '';
    private sequence: JsonObject[] = [];
    private baseline: JsonObject | null = null;
    private sequenceValid = true;
    constructor(private readonly log: OperationLog) { }
    async sync(project: StableId, document: StableId): Promise<void> {
        if (this.project !== project || this.document !== document) {
            this.project = project;
            this.document = document;
            this.scanned = -1;
            this.cases.clear();
            this.refs.clear();
            this.invalidate();
        }
        const status = this.log.status();
        let from = Math.max(this.scanned, status.retainedFromSequence - 1);
        const end = status.nextSequence;
        while (from < end - 1) {
            const before = Math.min(end, from + 5001);
            let cursor: string | undefined;
            do {
                const page = await this.log.query({ projectId: project, documentId: document, kinds: ['interaction/regression'], ...(from >= 0 ? { afterSequence: from } : {}), beforeSequence: before, limit: 200, traverseCorrelation: false, ...(cursor ? { cursor } : {}) });
                for (const event of page.events) {
                    const id = event.payload.artifactId;
                    if (typeof id !== 'string')
                        throw new Error('Regression artifact reference missing.');
                    const value = (await this.log.readArtifact(asStableId(id))).value;
                    if (!record(value) || value.kind !== 'haiyue.gesture-regression.v1' || value.projectId !== project || value.documentId !== document || !record(value.test))
                        throw new Error('Invalid regression artifact.');
                    const t = value.test as unknown as Regression;
                    if (typeof t.id !== 'string' || typeof t.label !== 'string' || !Array.isArray(t.sequence) || t.sequence.length < 1 || t.sequence.length > 32 || !record(t.baseline) || typeof t.passed !== 'boolean' || !Number.isSafeInteger(t.revision))
                        throw new Error('Invalid regression test.');
                    this.cases.set(t.id, t);
                    this.refs.set(t.id, id);
                }
                cursor = page.nextCursor;
            } while (cursor);
            from = before - 1;
        }
        this.scanned = end - 1;
    }
    invalidate(): void { this.play = ''; this.sequence = []; this.baseline = null; this.sequenceValid = false; }
    begin(before: GamePlayObservation): void { if (this.play !== before.playId) {
        this.play = before.playId;
        this.sequence = [];
        this.baseline = precondition(before);
        this.sequenceValid = before.tick <= 2;
    } }
    async record(args: JsonObject, before: GamePlayObservation, passed: boolean, caseId?: string): Promise<JsonObject | null> {
        if (caseId) {
            const test = this.cases.get(caseId);
            if (!test)
                throw new Error('Unknown regression.');
            return this.store({ ...test, revision: before.documentRevision, passed });
        }
        if (this.sequence.length >= 32)
            this.sequenceValid = false;
        if (this.sequenceValid)
            this.sequence.push(args);
        if (!args.caseLabel && passed)
            return null;
        if (!args.expect)
            return { saved: false, reason: 'Supply an explicit expectation before saving a regression.' };
        if (!this.sequenceValid || !this.baseline)
            return { saved: false, reason: 'Start a fresh paused Play and use pointer-gesture for the full prelude (maximum 32 gestures); unrecorded input/steps cannot be replayed faithfully.' };
        const sequence = this.sequence.map(({ caseLabel, ...args }) => args);
        const id = 'regression:' + sha256(canonicalStringify({ baseline: this.baseline, sequence })).slice(0, 24);
        if (!this.cases.has(id) && this.cases.size >= 64)
            throw new GameToolProtocolError('interaction.regression-capacity', '64 persistent regression cases already exist; cannot silently discard previous failures.');
        return this.store({ id, label: String(args.caseLabel ?? args.hypothesis ?? 'Failed pointer gesture').slice(0, 240), sequence, baseline: this.baseline, revision: before.documentRevision, passed });
    }
    list(): JsonObject { return { cases: [...this.cases.values()].map(t => ({ id: t.id, label: t.label, revision: t.revision, passed: t.passed, gestureCount: t.sequence.length })), count: this.cases.size }; }
    inspect(id: string): JsonObject { const t = this.get(id); const result: JsonObject = { id: t.id, label: t.label, setup: { camera: t.baseline.camera ?? null, viewport: t.baseline.viewport ?? null, seed: t.baseline.seed ?? null }, sequence: t.sequence, artifactId: this.refs.get(id) ?? null }; if (new TextEncoder().encode(JSON.stringify(result)).length > 60 * 1024)
        return { ...result, sequence: [], gestureCount: t.sequence.length, sequenceTruncated: true }; return result; }
    get(id: string): Regression { const test = this.cases.get(id); if (!test)
        throw new GameToolProtocolError('interaction.regression-not-found', 'Unknown case id in this project/document.'); return test; }
    assertBaseline(test: Regression, before: GamePlayObservation): void {
        if (!approximatelyEqual(test.baseline, precondition(before)))
            throw new GameToolProtocolError('interaction.regression-precondition', 'Regression requires its original initial camera, viewport, seed and entity transforms. Start a fresh paused Play with the saved setup; do not alter the case or count this as passed.');
    }
    pending(revision: number): string[] { return [...this.cases.values()].filter(t => !t.passed || t.revision !== revision).map(t => `${t.id}: ${t.label}`); }
    private async store(test: Regression): Promise<JsonObject> { const artifact = await this.log.putArtifact({ kind: 'haiyue.gesture-regression.v1', projectId: this.project, documentId: this.document, test: test as unknown as JsonObject }); await this.log.append({ kind: 'interaction/regression', source: asStableId('studio.interaction'), severity: test.passed ? 'info' : 'warning', correlation: { projectId: asStableId(this.project), documentId: asStableId(this.document) }, payload: { artifactId: artifact.id, caseId: test.id, passed: test.passed, revision: test.revision }, artifactRefs: [artifact.id] }); this.cases.set(test.id, test); this.refs.set(test.id, artifact.id); return { id: test.id, label: test.label, saved: true, passed: test.passed, revision: test.revision }; }
}
function precondition(o: GamePlayObservation): JsonObject { const state = record(o.value.state) ? o.value.state : {}; return { camera: state.camera ?? null, entities: Array.isArray(state.entities) ? state.entities.map(e => { const r = record(e) ? e : {}; return { id: r.id ?? null, parentId: r.parentId ?? null, worldMatrix: r.worldMatrix ?? null }; }) : [], seed: o.value.seed ?? null, viewport: o.viewport as unknown as JsonObject }; }
function approximatelyEqual(a: unknown, b: unknown): boolean { if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) < 1e-4; if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => approximatelyEqual(v, b[i])); if (record(a) && record(b))
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => approximatelyEqual(a[k], b[k])); return a === b; }
