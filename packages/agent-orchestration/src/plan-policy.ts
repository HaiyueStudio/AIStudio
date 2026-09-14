import { asStableId, type StableId, type JsonObject, type TaskSpecV2 } from '@haiyue/ai-studio-contracts';
import { ASSEMBLY_EXPECTATIONS_SCHEMA, normalizeAssemblyExpectations, EVIDENCE_ASSERTION_PATTERN, isSupportedEvidenceAssertion } from '@haiyue/ai-studio-game-authoring-tools';
import { isRecord } from './value-utils.js';

export interface ApprovedPlanExecution {
  readonly title: string;
  readonly summary: string;
  readonly items: readonly Readonly<{ id: StableId; label: string; details?: string }>[];
  readonly assemblies?: readonly JsonObject[];
  readonly note?: string;
  attempts: number;
  mutationCount: number;
}
export interface PlanAcceptanceProposal { readonly label: string; readonly required: boolean; readonly category: TaskSpecV2['acceptance'][number]['category']; readonly assertion: string; }
export function approvedPlanRequest(plan: ApprovedPlanExecution, projectOpen: boolean): string {
  return [
    projectOpen ? 'Execute the already approved plan against the current project.' : 'The project closed after approval; report that execution cannot continue.',
    canonicalPlan(plan),
    'Verify structure, transforms, game rules, interactions and runtime errors through play.inspect/play.pointer-gesture and task.evaluate. Scope entityIds to affected objects. Reserve play.capture and multimodal review for rendered appearance; reuse one capture for same-stage visual criteria. Do not replace visual requirements with data checks or count screenshot presence as visual correctness.',
    'Do not request the same plan approval again. Re-inspect the current revision, execute accepted steps, and invoke the next tool to request any required scoped approval. Do not stop merely because a future operation may need approval. Report actual policy or capability failures.',
  ].join('\n\n');
}
export function canonicalPlan(plan: ApprovedPlanExecution): string {
  return JSON.stringify({ title: plan.title, summary: plan.summary, assemblies: plan.assemblies ?? [], items: plan.items.map((item) => ({ label: item.label, ...(item.details ? { details: item.details } : {}) })), ...(plan.note ? { userNote: plan.note } : {}) });
}
export const PLAN_TOOL_ID = asStableId('studio.plan.propose');
const ASSERTION_GUIDANCE = 'Prefer one atomic assertion per acceptance entry; put multiple conditions in separate entries. Legacy semicolon-separated assertions are expanded into independent required checks without dropping conditions. Use evidence <type> [signal <payload.path> <equals|gte|lte> <JSON value>]. Types: state, event-trace, runtime-errors, performance, screenshot, visual-analysis, lifecycle. Examples: evidence runtime-errors signal count equals 0; evidence state signal gameplay.0.value.metrics.score gte 1; evidence state signal gameplay.0.value.phase equals "ready". Signal paths must match the observation payload you will produce and inspect. Put human-readable requirements in label. Preserve each requirement when correcting its assertion; do not omit criteria to bypass validation. Bare evidence <type> checks presence only, not correctness; visual correctness requires a real visual verifier. Current Play tools produce no visual-analysis evidence and no fps measurement. Performance exposes finite, tick, frame and timeMs. Screenshot presence cannot prove colors or shape: pair it with explicit structural/behavior assertions and state any remaining visual review limitation.';
export const PLAN_TOOL_DEFINITION = Object.freeze({
  id: PLAN_TOOL_ID,
  description: 'Submit the complete implementation plan and machine-checkable acceptance criteria for user review before any project mutation. Include authored entities, responsibilities, static properties persisted in the Document instead of initialization-only scripts, dynamic state ownership, rendering strategy, and real pointer/action gestures and authoritative before/after entity/camera state for interaction acceptance, and fixed evidence assertions. Select evidence per criterion: data-first for object structure, transforms, game rules, interaction effects and runtime errors; use scoped play.inspect and actual play.pointer-gesture input before task.evaluate. Reserve screenshots for rendered appearance (color, texture, lighting, occlusion, visual layout) or data/render discrepancies, reusing the same-stage image. Separate material/geometry configuration checks (functional data) from actual appearance checks (visual). Do not reclassify a visual requirement just to pass data verification. Distinguish appearance requirements from explicit implementation constraints. For repeated composite objects specify visible requirements, parts, independent color slots, parent-local transforms and motion owner. Plan assembly.create, assembly.inspect and assembly.instantiate as separate stages; structure checks must cover the promised colored surfaces and subparts, not only body counts. Use prefab.manage for existing subtrees; do not equate an object name with one primitive. The result blocks until the user approves or requests a revision.',
  effect: 'observe' as const,
  risk: 'low' as const,
  inputSchema: Object.freeze({
    type: 'object', additionalProperties: false, required: Object.freeze(['title', 'summary', 'items', 'assemblies']), properties: Object.freeze({
      title: Object.freeze({ type: 'string', minLength: 1, maxLength: 160 }),
      summary: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_200 }),
      items: Object.freeze({ type: 'array', minItems: 1, maxItems: 20, items: Object.freeze({
        type: 'object', additionalProperties: false, required: Object.freeze(['label', 'details']), properties: Object.freeze({
          label: Object.freeze({ type: 'string', minLength: 1, maxLength: 240 }),
          details: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_024 }),
        }),
      }) }),
      assemblies: { ...ASSEMBLY_EXPECTATIONS_SCHEMA, description: 'For repeated composite objects, declare required part roles, independent color count and total instances including the prototype. Studio enforces these against actual entities before preview and final acceptance. Use [] for tasks without repeated assemblies.' },
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
export function validatePlanProposal(value: JsonObject): Readonly<{ title: string; summary: string; items: readonly Readonly<{ label: string; details?: string }>[]; acceptance: readonly PlanAcceptanceProposal[]; assemblies: readonly JsonObject[] }> {
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['title', 'summary', 'items', 'acceptance', 'assemblies'].includes(key)) || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 160
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
    : raw.acceptance.flatMap((entry, index) => {
      if (!isRecord(entry) || Object.keys(entry).some((key) => !['label', 'required', 'category', 'assertion'].includes(key)) || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 240
        || typeof entry.required !== 'boolean' || !['functional', 'visual', 'performance', 'lifecycle', 'budget', 'security'].includes(String(entry.category))) {
        const issues = !isRecord(entry) ? ['entry must be an object'] : [
          ...(typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 240 ? ['label must be non-empty text up to 240 characters'] : []),
          ...(typeof entry.required !== 'boolean' ? [`required must be boolean; received ${typeof entry.required}`] : []),
          ...(!['functional', 'visual', 'performance', 'lifecycle', 'budget', 'security'].includes(String(entry.category)) ? ['category must be functional, visual, performance, lifecycle, budget or security'] : []),
          ...Object.keys(entry).filter(key => !['label', 'required', 'category', 'assertion'].includes(key)).map(key => `unknown field: ${key.slice(0, 80)}`),
        ];
        throw new PlanProtocolError('plan.payload-invalid', `acceptance[${index}] requires correction: ${issues.join('; ').slice(0, 800)}. Required fields: label (string), required (boolean), category (enum), assertion (evidence DSL string). Preserve every requirement; do not omit criteria.`);
      }
      if (typeof entry.assertion !== 'string' || !entry.assertion.trim() || entry.assertion.length > 2_000) {
        throw new PlanProtocolError('plan.payload-invalid', `acceptance[${index}].assertion must be non-empty text up to 2000 characters. Put each requirement in a separate acceptance entry; do not omit criteria.`);
      }
      const assertions = splitAcceptanceAssertions(entry.assertion);
      return assertions.map((assertion, part) => {
        if (!isSupportedEvidenceAssertion(assertion)) {
          throw new PlanProtocolError('plan.payload-invalid', `acceptance[${index}].assertion 条件 ${part + 1}/${assertions.length} 无法解析：${JSON.stringify(assertion.slice(0, 140))}. Use evidence <type> [signal <payload.path> <equals|gte|lte> <JSON value>]. Strings need JSON double quotes. Keep each condition as a separate acceptance entry; do not omit criteria.`);
        }
        if (/^evidence\s+visual-analysis(?:\s|$)/u.test(assertion) || /^evidence\s+performance\s+signal\s+(?!finite\s|tick\s|frame\s|timeMs\s)/u.test(assertion)) {
          throw new PlanProtocolError('plan.evidence-producer-unavailable', `acceptance[${index}].assertion 条件 ${part + 1} 请求了当前 Play 无法生成的证据：${JSON.stringify(assertion.slice(0, 160))}. Play supports performance finite/tick/frame/timeMs, but not fps or visual-analysis. Preserve the requirement and choose available evidence; do not claim an unverified result.`);
        }
        const suffix = assertions.length > 1 ? `（${part + 1}/${assertions.length}）` : '';
        const label = entry.label as string;
        return Object.freeze({ label: `${label.trim().slice(0, 240 - suffix.length)}${suffix}`, required: entry.required as boolean, category: entry.category as PlanAcceptanceProposal['category'], assertion });
      });
    });
  if (acceptance.length > 50) throw new PlanProtocolError('plan.payload-invalid', `The plan expands to ${acceptance.length} acceptance conditions; maximum 50. Reorganize the plan without dropping requirements.`);
  return Object.freeze({ title: raw.title.trim(), summary: raw.summary.trim(), items: Object.freeze(items), acceptance: Object.freeze(acceptance), assemblies: normalizeAssemblyExpectations(raw.assemblies ?? []) });
}
export class PlanProtocolError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'PlanProtocolError'; } }

/** Split only explicit conjunction separators outside JSON strings/containers. */
function splitAcceptanceAssertions(value: string): string[] {
  const parts: string[] = [];
  let start = 0, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
    else if ((character === ';' || character === '；') && depth === 0) { parts.push(value.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts;
}
