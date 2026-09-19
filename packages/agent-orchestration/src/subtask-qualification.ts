import type { JsonObject, PlanTaskV1, UsageRecordV2, CostRecordV2 } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, redactObject, sha256 } from '@haiyue/ai-studio-operation-log';

export interface SubtaskQualification {
  /** Trusted composition identity, never model-supplied. */
  readonly sourceRevision: string;
  readonly cohortFor: (tasks: readonly PlanTaskV1[]) => string | null;
  /** Read a retained immutable artifact; no model-controlled paths or URLs. */
  readonly load: (ref: string, signal: AbortSignal) => Promise<unknown>;
}
export interface QualificationIdentity {
  readonly backendId: string;
  readonly model: string;
  readonly profileDigest: string;
  readonly registryDigest: string;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === keys.sort().join(',');
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const bounded = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const digest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v);
const median = (values: number[]) => { const s = [...values].sort((a,b) => a-b); return (s[Math.floor((s.length-1)/2)]! + s[Math.floor(s.length/2)]!) / 2; };
function safe(v: unknown): v is JsonObject {
  if (!record(v)) return false;
  try { return Buffer.byteLength(JSON.stringify(v)) <= 262_144 && canonicalStringify(redactObject(v as JsonObject).value) === canonicalStringify(v as JsonObject); } catch { return false; }
}

/** Validates measured paired trials, not a caller's assertion that a reference is qualified.
 * Quality and total work include the parent's final review/merge. Five pairs admit only
 * an exploratory cohort, not a p95 claim or general enablement. */
export async function qualifySubtasks(gate: SubtaskQualification | undefined, ref: string, identity: QualificationIdentity,
  tasks: readonly PlanTaskV1[], signal: AbortSignal): Promise<string | null> {
  if (!gate || !bounded(ref) || !bounded(gate.sourceRevision) || !digest(identity.profileDigest) || !digest(identity.registryDigest)) return null;
  const cohort = gate.cohortFor(tasks);
  if (!bounded(cohort)) return null;
  const expected = { ...identity, sourceRevision: gate.sourceRevision, cohort };
  const report = await gate.load(ref, signal);
  signal.throwIfAborted();
  if (!safe(report) || !exact(report, ['schemaVersion', 'identity', 'measurement', 'trials']) || report.schemaVersion !== 1 || report.measurement !== 'real-provider'
    || canonicalStringify(report.identity!) !== canonicalStringify(expected)
    || !Array.isArray(report.trials) || report.trials.length < 5 || report.trials.length > 40) return null;
  const refs = new Set<string>(), cases = new Set<string>(), ledgerIds = new Set<string>();
  const ratios: { latency: number[]; tokens: number[]; cost: number[] } = { latency: [], tokens: [], cost: [] };
  for (const trial of report.trials) {
    if (!record(trial) || !exact(trial, ['caseId', 'serial', 'parallel']) || !bounded(trial.caseId) || cases.has(trial.caseId)) return null;
    cases.add(trial.caseId);
    const metrics: { elapsed: number; tokens: number; cost: number }[] = [];
    let required: number | null = null, criteriaDigest: string | null = null;
    for (const mode of ['serial', 'parallel'] as const) {
      const link = trial[mode];
      if (!record(link) || !exact(link, ['ref', 'digest']) || !bounded(link.ref) || !digest(link.digest) || refs.has(link.ref)) return null;
      refs.add(link.ref);
      const evidence = await gate.load(link.ref, signal);
      signal.throwIfAborted();
      if (!safe(evidence) || `sha256:${sha256(canonicalStringify(evidence))}` !== link.digest
        || !exact(evidence, ['schemaVersion', 'identity', 'caseId', 'mode', 'startedAtMs', 'completedAtMs', 'quality', 'phases'])
        || evidence.schemaVersion !== 1 || evidence.caseId !== trial.caseId || evidence.mode !== mode
        || canonicalStringify(evidence.identity!) !== canonicalStringify(expected)
        || !count(evidence.startedAtMs) || !count(evidence.completedAtMs) || evidence.completedAtMs <= evidence.startedAtMs
        || !record(evidence.quality) || !exact(evidence.quality, ['required', 'passed', 'criteriaDigest']) || !count(evidence.quality.required) || evidence.quality.required < 1
        || evidence.quality.passed !== evidence.quality.required || !digest(evidence.quality.criteriaDigest) || !Array.isArray(evidence.phases)) return null;
      if (required !== null && (required !== evidence.quality.required || criteriaDigest !== evidence.quality.criteriaDigest)) return null;
      required = evidence.quality.required; criteriaDigest = evidence.quality.criteriaDigest;
      const roles = new Set<string>(); let tokens = 0, cost = 0;
      for (const phase of evidence.phases) {
        if (!record(phase) || !exact(phase, ['role', 'ledgerRefs']) || !['parent', 'children', 'merge'].includes(String(phase.role))
          || roles.has(String(phase.role)) || !Array.isArray(phase.ledgerRefs) || !phase.ledgerRefs.length || phase.ledgerRefs.length > 32 || phase.role === 'children' && phase.ledgerRefs.length < 2) return null;
        roles.add(String(phase.role));
        for (const link of phase.ledgerRefs) {
          if (!record(link) || !exact(link, ['usage', 'cost']) || !bounded(link.usage) || !bounded(link.cost) || refs.has(link.usage) || refs.has(link.cost)) return null;
          refs.add(link.usage); refs.add(link.cost);
          const [usage, pricing] = await Promise.all([gate.load(link.usage, signal), gate.load(link.cost, signal)]);
          signal.throwIfAborted();
          if (!finalUsage(usage) || !knownCost(pricing) || pricing.usageRecordId !== usage.id || ledgerIds.has(usage.id) || ledgerIds.has(pricing.id)) return null;
          ledgerIds.add(usage.id); ledgerIds.add(pricing.id);
          tokens += usage.inputTokens! + usage.outputTokens!; cost += pricing.amountMicros!;
        }
      }
      if (!roles.has('parent') || mode === 'parallel' && (!roles.has('children') || !roles.has('merge')) || !Number.isSafeInteger(tokens) || !Number.isSafeInteger(cost) || tokens <= 0 || cost <= 0) return null;
      metrics.push({ elapsed: evidence.completedAtMs - evidence.startedAtMs, tokens, cost });
    }
    const [serial, parallel] = metrics;
    ratios.latency.push(parallel!.elapsed / serial!.elapsed); ratios.tokens.push(parallel!.tokens / serial!.tokens); ratios.cost.push(parallel!.cost / serial!.cost);
  }
  // Require a clear latency gain and no median total token/cost regression. A task class
  // with different tradeoffs needs a reviewed policy, not model-selected thresholds.
  return median(ratios.latency) <= 0.9 && median(ratios.tokens) <= 1 && median(ratios.cost) <= 1 ? `${ref}#sha256:${sha256(canonicalStringify(report))}` : null;
}

// Reuse the canonical M12 envelopes. Qualification requires final known totals;
// estimates with a pinned pricing catalog are allowed, unknown/free-by-assumption is not.
function finalUsage(value: unknown): value is UsageRecordV2 {
  return safe(value) && value.schemaVersion === 2 && value.final === true && value.stepId === undefined && value.toolCallId === undefined && bounded(value.id)
    && bounded(value.taskId) && bounded(value.sessionId) && bounded(value.turnId)
    && digest(value.providerRequestDigest) && count(value.inputTokens) && count(value.outputTokens)
    && ['cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens'].every(k => value[k] === null || count(value[k]))
    && ['wallTimeMs', 'toolInputBytes', 'toolOutputBytes'].every(k => count(value[k]));
}
function knownCost(value: unknown): value is CostRecordV2 {
  return safe(value) && value.schemaVersion === 2 && bounded(value.id) && bounded(value.usageRecordId)
    && ['actual', 'estimated'].includes(String(value.status)) && count(value.amountMicros)
    && bounded(value.pricingCatalogId) && bounded(value.pricingCatalogVersion) && bounded(value.effectiveAt)
    && value.currency === 'USD' && bounded(value.formula);
}
