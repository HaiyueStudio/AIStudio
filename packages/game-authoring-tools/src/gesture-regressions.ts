import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import type { GamePlayObservation } from './types.js';
import { GameToolProtocolError } from './types.js';

interface Regression {
  id: string; label: string; mode: 'probe' | 'regression'; sequence: JsonObject[];
  baseline: JsonObject; revision: number; passed: boolean;
  checks?: JsonObject[]; correction?: JsonObject; supersededBy?: string;
}
const record = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a as JsonObject) === canonicalStringify(b as JsonObject);
const stripMeta = ({ mode, caseLabel, hypothesis, targetEntityId, ...args }: JsonObject): JsonObject => args;
const fail = (code: string, message: string): never => { throw new GameToolProtocolError(code, message); };

/** Immutable definitions, append-only verdicts. Exploratory probes never gate acceptance. */
export class GestureRegressions {
  private project = ''; private document = ''; private scanned = -1;
  private cases = new Map<string, Regression>(); private refs = new Map<string, string>();
  private play = ''; private sequence: JsonObject[] = []; private checks: JsonObject[] = [];
  private baseline: JsonObject | null = null; private sequenceValid = true;
  constructor(private readonly log: OperationLog) {}
  async sync(project: StableId, document: StableId): Promise<void> {
    if (this.project !== project || this.document !== document) {
      this.project = project; this.document = document; this.scanned = -1;
      this.cases.clear(); this.refs.clear(); this.invalidate();
    }
    const status = this.log.status(), end = status.nextSequence;
    let from = Math.max(this.scanned, status.retainedFromSequence - 1);
    while (from < end - 1) {
      const before = Math.min(end, from + 5001); let cursor: string | undefined;
      do {
        const page = await this.log.query({ projectId: project, documentId: document, kinds: ['interaction/regression', 'interaction/probe'], ...(from >= 0 ? { afterSequence: from } : {}), beforeSequence: before, limit: 200, traverseCorrelation: false, ...(cursor ? { cursor } : {}) });
        for (const event of page.events) {
          const id = event.payload.artifactId;
          if (typeof id !== 'string') throw new Error('Regression artifact reference missing.');
          const value = (await this.log.readArtifact(asStableId(id))).value;
          if (!record(value) || !['haiyue.gesture-regression.v1', 'haiyue.gesture-regression.v2'].includes(String(value.kind)) || value.projectId !== project || value.documentId !== document || !record(value.test)) throw new Error('Invalid regression artifact.');
          const t = value.test;
          if (typeof t.id !== 'string' || typeof t.label !== 'string' || !Array.isArray(t.sequence) || t.sequence.length < 1 || t.sequence.length > 32 || !record(t.baseline) || typeof t.passed !== 'boolean' || !Number.isSafeInteger(t.revision)
            || (t.mode !== undefined && t.mode !== 'probe' && t.mode !== 'regression') || (t.checks !== undefined && (!Array.isArray(t.checks) || t.checks.length > 32 || !t.checks.every(record)))
            || (t.supersededBy !== undefined && typeof t.supersededBy !== 'string') || (t.correction !== undefined && !record(t.correction))) throw new Error('Invalid regression test.');
          this.remember({ ...t, mode: t.mode ?? 'regression' } as unknown as Regression, id);
        }
        cursor = page.nextCursor;
      } while (cursor);
      from = before - 1;
    }
    this.scanned = end - 1;
  }
  invalidate(): void { this.play = ''; this.sequence = []; this.checks = []; this.baseline = null; this.sequenceValid = false; }
  begin(before: GamePlayObservation): void {
    if (this.play !== before.playId) { this.play = before.playId; this.sequence = []; this.checks = []; this.baseline = precondition(before); this.sequenceValid = before.tick <= 2; }
  }
  async record(args: JsonObject, before: GamePlayObservation, passed: boolean, caseId?: string, checks?: JsonObject[]): Promise<JsonObject | null> {
    if (caseId) { const test = this.get(caseId); return this.store({ ...test, revision: before.documentRevision, passed, ...(checks ? { checks } : {}) }); }
    if (this.sequence.length >= 32) this.sequenceValid = false;
    if (this.sequenceValid) { this.sequence.push(args); this.checks.push(checks?.[0] ?? { expectationMatched: passed }); }
    if (!args.expect) return { saved: false, mode: 'probe', reason: 'Supply an explicit expectation before saving a test.' };
    if (!this.sequenceValid || !this.baseline) return { saved: false, mode: 'probe', reason: 'Start a fresh paused Play and record the full prelude (maximum 32 gestures); unrecorded input/steps cannot be replayed faithfully.' };
    // Earlier exploratory actions remain reproducible setup, without becoming assertions.
    const sequence = this.sequence.map((step, index) => {
      const { mode, caseLabel, hypothesis, ...args } = step;
      if (index < this.sequence.length - 1 && mode !== 'regression') { const { expect, targetEntityId, ...setup } = args; return setup; }
      return args;
    });
    const mode = args.mode === 'regression' ? 'regression' : 'probe';
    const id = (mode === 'regression' ? 'regression:' : 'probe:') + sha256(canonicalStringify({ baseline: this.baseline, sequence })).slice(0, 24);
    const allPassed = passed && sequence.every((step, index) => !step.expect || this.checks[index]?.expectationMatched === true);
    const prior = this.cases.get(id), effectiveMode = prior?.mode === 'regression' ? 'regression' : mode;
    this.assertCapacity(id, effectiveMode);
    return this.store({ ...prior, id, label: String(args.caseLabel ?? args.hypothesis ?? 'Pointer exploration').slice(0, 240), mode: effectiveMode, sequence, baseline: this.baseline, revision: before.documentRevision, passed: allPassed, checks: this.checks.slice() });
  }
  async promote(id: string, revision: number, guard?: () => void): Promise<JsonObject> {
    guard?.();
    const test = this.get(id);
    if (test.supersededBy || !test.passed || test.revision !== revision) fail('interaction.regression-correction-invalid', 'Only a passing current-revision probe can be promoted; replay it first.');
    this.assertCapacity(id, 'regression'); return this.store({ ...test, mode: 'regression' },guard);
  }
  async correct(id: string, replacementId: string, reason: string, revision: number, guard?: () => void): Promise<JsonObject> {
    guard?.();
    const original = this.get(id), replacement = this.get(replacementId);
    if (id === replacementId || original.supersededBy || replacement.supersededBy || original.mode !== 'regression' || original.passed || !replacement.passed || original.revision !== revision || replacement.revision !== revision || !approximatelyEqual(original.baseline, replacement.baseline))
      fail('interaction.regression-correction-invalid', 'Correction requires a replayed failing formal case and a passing replacement at the same current revision, original camera, viewport, seed and initial transforms.');
    let corrected = 0, preservedThrough = 0;
    for (let index = 0; index < original.sequence.length; index++) {
      const step = original.sequence[index]!; if (!step.expect) continue;
      const preserved = replacement.sequence.findIndex((other,i) => i >= preservedThrough && same(stripMeta(step), stripMeta(other)));
      if (preserved >= 0) { preservedThrough = preserved + 1; continue; }
      const check = original.checks?.[index], expect = record(step.expect) ? step.expect : {}, changed = expect.changedTransformEntityIds;
      // Legacy tests have no declared target; only an unambiguous single-actor form is eligible.
      const target = typeof step.targetEntityId === 'string' ? step.targetEntityId : Array.isArray(changed) && changed.length === 1 && typeof changed[0] === 'string' ? changed[0] : null;
      const wrongTarget = check?.expectationMatched === false && target && Object.hasOwn(check, 'hitEntityId') && check.hitEntityId !== target && ['background-hit', 'pointer-unavailable', 'events-filtered', 'target-mismatch'].includes(String(check.stage));
      const verified = replacement.sequence.some((other, i) => other.targetEntityId === target && same(other.expect ?? null, step.expect) && replacement.checks?.[i]?.expectationMatched === true && replacement.checks?.[i]?.hitEntityId === target);
      if (!wrongTarget || !verified) fail('interaction.regression-correction-invalid', 'Every changed assertion step needs recorded wrong-target evidence and a passing intended-target replacement with identical expectations. Replay legacy cases for diagnostics. Behavior failures cannot be discarded.');
      corrected++;
    }
    if (!corrected) fail('interaction.regression-correction-invalid', 'No evidenced targeting mistake was corrected.');
    this.assertCapacity(replacementId, 'regression');
    // Promotion first: interrupted corrections leave the original blocking.
    const promoted = await this.store({ ...replacement, mode: 'regression', correction: { replaces: id, originalArtifactId: this.refs.get(id)!, reason } },guard);
    const superseded = await this.store({ ...original, supersededBy: replacementId, correction: { replacementArtifactId: this.refs.get(replacementId)!, reason } },guard);
    return { original: superseded, replacement: promoted, historyPreserved: true };
  }
  list(): JsonObject { return { cases: [...this.cases.values()].map(t => ({ id: t.id, label: t.label, mode: t.mode, revision: t.revision, passed: t.passed, gestureCount: t.sequence.length, supersededBy: t.supersededBy ?? null })), count: this.cases.size }; }
  inspect(id: string): JsonObject {
    const t = this.get(id);
    const result: JsonObject = { id: t.id, label: t.label, mode: t.mode, passed: t.passed, revision: t.revision, setup: { camera: t.baseline.camera ?? null, viewport: t.baseline.viewport ?? null, seed: t.baseline.seed ?? null }, sequence: t.sequence, checks: t.checks ?? [], supersededBy: t.supersededBy ?? null, correction: t.correction ?? null, artifactId: this.refs.get(id) ?? null };
    return new TextEncoder().encode(JSON.stringify(result)).length > 60 * 1024 ? { ...result, sequence: [], checks: [], gestureCount: t.sequence.length, sequenceTruncated: true } : result;
  }
  get(id: string): Regression { return this.cases.get(id) ?? fail('interaction.regression-not-found', 'Unknown case id in this project/document.'); }
  assertBaseline(test: Regression, before: GamePlayObservation): void { if (!approximatelyEqual(test.baseline, precondition(before))) fail('interaction.regression-precondition', 'Regression requires its original initial camera, viewport, seed and entity transforms. Start a fresh paused Play with the saved setup; do not count this as passed.'); }
  pending(revision: number): string[] { return [...this.cases.values()].filter(t => t.mode === 'regression' && !t.supersededBy && (!t.passed || t.revision !== revision)).map(t => `${t.id}: ${t.label}`); }
  private assertCapacity(id: string, mode: Regression['mode']): void {
    if (mode === 'regression' && this.cases.get(id)?.mode !== 'regression' && [...this.cases.values()].filter(t => t.mode === 'regression').length >= 64) fail('interaction.regression-capacity', '64 persistent formal cases already exist; cannot silently discard prior regressions.');
  }
  private remember(test: Regression, ref: string): void {
    this.cases.set(test.id, test); this.refs.set(test.id, ref);
    const probes = [...this.cases.values()].filter(t => t.mode === 'probe');
    for (const old of probes.slice(0, Math.max(0, probes.length - 64))) { this.cases.delete(old.id); this.refs.delete(old.id); }
  }
  private async store(test: Regression, guard?: () => void): Promise<JsonObject> {
    guard?.();
    const artifact = await this.log.putArtifact({ kind: 'haiyue.gesture-regression.v2', projectId: this.project, documentId: this.document, test: test as unknown as JsonObject });
    guard?.();
    await this.log.append({ kind: test.mode === 'probe' ? 'interaction/probe' : 'interaction/regression', source: asStableId('studio.interaction'), severity: test.passed || test.supersededBy ? 'info' : 'warning', correlation: { projectId: asStableId(this.project), documentId: asStableId(this.document) }, payload: { artifactId: artifact.id, caseId: test.id, mode: test.mode, passed: test.passed, revision: test.revision, supersededBy: test.supersededBy ?? null }, artifactRefs: [artifact.id] });
    this.remember(test, artifact.id);
    return { id: test.id, label: test.label, mode: test.mode, saved: true, passed: test.passed, revision: test.revision, supersededBy: test.supersededBy ?? null };
  }
}
function precondition(o: GamePlayObservation): JsonObject { const state = record(o.value.state) ? o.value.state : {}; return { camera: state.camera ?? null, entities: Array.isArray(state.entities) ? state.entities.map(e => { const r = record(e) ? e : {}; return { id: r.id ?? null, parentId: r.parentId ?? null, worldMatrix: r.worldMatrix ?? null }; }) : [], seed: o.value.seed ?? null, viewport: o.viewport as unknown as JsonObject }; }
function approximatelyEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-4;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => approximatelyEqual(v, b[i]));
  if (record(a) && record(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => approximatelyEqual(a[k], b[k])); return a === b;
}
