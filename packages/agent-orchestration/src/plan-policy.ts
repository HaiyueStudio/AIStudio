import { asStableId, type StableId, type JsonObject, type TaskSpecV2 } from '@haiyue/ai-studio-contracts';
import { EVIDENCE_ASSERTION_PATTERN, isSupportedEvidenceAssertion } from '@haiyue/ai-studio-game-authoring-tools';
import { isRecord } from './value-utils.js';

export interface ApprovedPlanExecution {
  readonly title: string;
  readonly summary: string;
  readonly items: readonly Readonly<{ id: StableId; label: string; details?: string }>[];
  readonly note?: string;
  attempts: number;
  mutationCount: number;
}
export interface PlanAcceptanceProposal { readonly label: string; readonly required: boolean; readonly category: TaskSpecV2['acceptance'][number]['category']; readonly assertion: string; }
export function approvedPlanRequest(plan: ApprovedPlanExecution, projectOpen: boolean): string {
  return [
    projectOpen ? 'Execute the already approved plan against the current project.' : 'The project closed after approval; report that execution cannot continue.',
    canonicalPlan(plan),
    'Do not request the same plan approval again. Re-inspect the current revision, execute accepted steps, and invoke the next tool to request any required scoped approval. Do not stop merely because a future operation may need approval. Report actual policy or capability failures.',
  ].join('\n\n');
}
export function canonicalPlan(plan: ApprovedPlanExecution): string {
  return JSON.stringify({ title: plan.title, summary: plan.summary, items: plan.items.map((item) => ({ label: item.label, ...(item.details ? { details: item.details } : {}) })), ...(plan.note ? { userNote: plan.note } : {}) });
}
export const PLAN_TOOL_ID = asStableId('studio.plan.propose');
const ASSERTION_GUIDANCE = 'Use evidence <type> [signal <payload.path> <equals|gte|lte> <JSON value>]. Types: state, event-trace, runtime-errors, performance, screenshot, visual-analysis, lifecycle. Examples: evidence runtime-errors signal count equals 0; evidence state signal gameplay.0.value.metrics.score gte 1; evidence state signal gameplay.0.value.phase equals "ready". Signal paths must match the observation payload you will produce and inspect. Put human-readable requirements in label. Preserve each requirement when correcting its assertion; do not omit criteria to bypass validation. Bare evidence <type> checks presence only, not correctness; visual correctness requires a real visual verifier. Current Play tools produce no visual-analysis evidence and no fps measurement. Performance exposes finite, tick, frame and timeMs. Screenshot presence cannot prove colors or shape: pair it with explicit structural/behavior assertions and state any remaining visual review limitation.';
export const PLAN_TOOL_DEFINITION = Object.freeze({
  id: PLAN_TOOL_ID,
  description: 'Submit the complete implementation plan and machine-checkable acceptance criteria for user review before any project mutation. Include authored entities, responsibilities, scripts, dynamic state ownership, rendering strategy, and fixed evidence assertions. Distinguish appearance requirements from explicit implementation constraints. For repeated composite objects specify parts, materials, parent-local transforms, motion owner, prototype checks and prefab reuse; do not equate an object name with one primitive. The result blocks until the user approves or requests a revision.',
  effect: 'observe' as const,
  risk: 'low' as const,
  inputSchema: Object.freeze({
    type: 'object', additionalProperties: false, required: Object.freeze(['title', 'summary', 'items']), properties: Object.freeze({
      title: Object.freeze({ type: 'string', minLength: 1, maxLength: 160 }),
      summary: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_200 }),
      items: Object.freeze({ type: 'array', minItems: 1, maxItems: 20, items: Object.freeze({
        type: 'object', additionalProperties: false, required: Object.freeze(['label', 'details']), properties: Object.freeze({
          label: Object.freeze({ type: 'string', minLength: 1, maxLength: 240 }),
          details: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_024 }),
        }),
      }) }),
      acceptance: Object.freeze({ type: 'array', description: 'Fixed, machine-checkable criteria corresponding to the user requirements. Each assertion uses the evidence DSL described below; natural-language assertions are not executable.', minItems: 1, maxItems: 50, items: Object.freeze({
        type: 'object', additionalProperties: false, required: Object.freeze(['label', 'required', 'category', 'assertion']), properties: Object.freeze({
          label: Object.freeze({ type: 'string', minLength: 1, maxLength: 240 }), required: Object.freeze({ type: 'boolean' }),
          category: Object.freeze({ enum: Object.freeze(['functional', 'visual', 'performance', 'lifecycle', 'budget', 'security']) }),
          assertion: Object.freeze({ type: 'string', description: ASSERTION_GUIDANCE, minLength: 1, maxLength: 2_000, pattern: EVIDENCE_ASSERTION_PATTERN }),
        }),
      }) }),
    }),
  }) as JsonObject,
});
export function validatePlanProposal(value: JsonObject): Readonly<{ title: string; summary: string; items: readonly Readonly<{ label: string; details?: string }>[]; acceptance: readonly PlanAcceptanceProposal[] }> {
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['title', 'summary', 'items', 'acceptance'].includes(key)) || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 160
    || typeof raw.summary !== 'string' || !raw.summary.trim() || raw.summary.length > 1_200 || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 20) {
    throw new PlanProtocolError('plan.payload-invalid', 'Plan requires a title, summary and 1-20 detailed items.');
  }
  const items = raw.items.map((value, index) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !['label', 'details'].includes(key)) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 240
      || typeof value.details !== 'string' || !value.details.trim() || value.details.length > 1_024) {
      throw new PlanProtocolError('plan.payload-invalid', `Plan item ${index + 1} requires bounded label and details fields.`);
    }
    return Object.freeze({ label: value.label.trim(), details: value.details.trim() });
  });
  const acceptance = raw.acceptance === undefined ? [] : !Array.isArray(raw.acceptance) || raw.acceptance.length < 1 || raw.acceptance.length > 50
    ? (() => { throw new PlanProtocolError('plan.payload-invalid', 'Plan acceptance requires 1-50 criteria.'); })()
    : raw.acceptance.map((entry, index) => {
      if (!isRecord(entry) || Object.keys(entry).some((key) => !['label', 'required', 'category', 'assertion'].includes(key)) || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 240
        || typeof entry.required !== 'boolean' || !['functional', 'visual', 'performance', 'lifecycle', 'budget', 'security'].includes(String(entry.category))) {
        throw new PlanProtocolError('plan.payload-invalid', `acceptance[${index}] requires a non-empty label (up to 240 characters), required (boolean), category (functional, visual, performance, lifecycle, budget or security), and assertion; no extra fields.`);
      }
      if (typeof entry.assertion !== 'string' || entry.assertion.length > 2_000 || !isSupportedEvidenceAssertion(entry.assertion)) {
        throw new PlanProtocolError('plan.payload-invalid', `acceptance[${index}].assertion is not executable (maximum 2000 characters). ${ASSERTION_GUIDANCE}`);
      }
      if (/^evidence\s+visual-analysis(?:\s|$)/u.test(entry.assertion.trim()) || /^evidence\s+performance\s+signal\s+(?!finite\s|tick\s|frame\s|timeMs\s)/u.test(entry.assertion.trim())) {
        throw new PlanProtocolError('plan.evidence-producer-unavailable', `acceptance[${index}] requires evidence the current Play tools cannot produce. ${ASSERTION_GUIDANCE}`);
      }
      return Object.freeze({ label: entry.label.trim(), required: entry.required, category: entry.category as PlanAcceptanceProposal['category'], assertion: entry.assertion.trim() });
    });
  return Object.freeze({ title: raw.title.trim(), summary: raw.summary.trim(), items: Object.freeze(items), acceptance: Object.freeze(acceptance) });
}
export class PlanProtocolError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'PlanProtocolError'; } }
