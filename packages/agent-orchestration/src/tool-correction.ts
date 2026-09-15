import type { JsonObject } from '@haiyue/ai-studio-contracts';
import { redactObject } from '@haiyue/ai-studio-operation-log';
import { isRecord, stringField } from './value-utils.js';

// Only errors known to precede a commit are eligible. `retryable` alone does
// not establish that replaying a mutation is safe.
export function toolCorrectionGuidance(code: string): string | null {
  switch (code) {
    case 'plan.payload-invalid':
      return 'Correct the indicated plan fields using the studio.plan.propose schema and resubmit the complete plan. For assertions prefer a structured object {type, signal, operator, expected}. A missing operator/value or nonexistent evidence field is not broken outer JSON: resolve it from the requirement and actual producer data; do not apply guessed defaults. Preserve all user requirements and required acceptance conditions; never remove checks just to pass validation. Await real user approval after the corrected plan is accepted.';
    case 'tool.arguments-invalid':
      return 'Read the exact tool schema with tool.search, correct the reported arguments, and submit a new tool call. Copy returned references unchanged. Do not repeat successful edits.';
    case 'interaction.regression-incomplete':
    case 'interaction.regression-precondition':
      return 'Use play.regression list/inspect to read retained cases and their original setup. Start a fresh paused Play through the normal authorized preview flow and replay each case at the current revision. Preserve its original expectations. If a case fails, inspect world-transform mismatches and repair the supported cause; do not weaken or replace the case to pass acceptance.';
    case 'interaction.diagnostic-required':
      return 'Inspect the previous gesture diagnostics, actual hit entity, pointer configuration and script binding. Fix the first supported cause through normal editing approval, or state a new hypothesis and run a distinct points/expect probe. Do not repeat the same test, restart Play or capture new images as a substitute for diagnosis.';
    case 'task.preview-stop-required':
      return 'Call play.stop, verify state is stopped, then inspect the current project revision and retry the intended edit through its normal approval path.';
    case 'evaluation.evidence-selection-invalid':
      return 'Correct acceptanceEvidence keys using the approved criterion ids and ensure all selected ids are included in observationIds. Reuse compatible retained evidence and resubmit task.evaluate. Do not restart Play, regenerate evidence, or edit gameplay to fix a selection mapping.';
    default: return null;
  }
}

/** Error details are control information, even when successful data is compacted. */
export function toolFailureFeedback(result: JsonObject): JsonObject {
  if (result.status !== 'failed') return {};
  const raw = isRecord(result.error) ? result.error : isRecord(result.value) ? result.value : {};
  const error = redactObject({ code: stringField(raw.code, 'tool.failed').slice(0, 160), message: stringField(raw.message, 'Tool failed without a diagnostic.').slice(0, 2048), retryable: raw.retryable === true }).value;
  const instruction = toolCorrectionGuidance(String(error.code));
  return { error, ...(instruction ? { correction: { action: 'revise-and-resubmit', instruction, automaticReplay: false } } : {}) };
}

/** A completed probe can reveal a failed behavior. Keep this control feedback
 * even when the successful tool payload is reduced to a digest. */
export function interactionDiagnosticFeedback(result: JsonObject): JsonObject {
  const value = isRecord(result.value) ? result.value : result;
  const d = isRecord(value.diagnostics) ? value.diagnostics : null;
  if (!d || typeof d.stage !== 'string') return {};
  return { interactionDiagnostic: redactObject({
    stage: d.stage.slice(0, 80), expectationMatched: typeof d.expectationMatched === 'boolean' ? d.expectationMatched : null,
    hitEntityId: typeof d.hitEntityId === 'string' ? d.hitEntityId.slice(0, 200) : null,
    receiverEntityId: typeof d.receiverEntityId === 'string' ? d.receiverEntityId.slice(0, 200) : null,
    mismatches: Array.isArray(d.mismatches) ? d.mismatches.slice(0, 2).map(x => String(x).slice(0, 200)) : [],
    nextAction: String(d.nextAction ?? '').slice(0, 600), repeatedFailureCount: typeof d.repeatedFailureCount === 'number' ? d.repeatedFailureCount : 0,
  }).value };
}
