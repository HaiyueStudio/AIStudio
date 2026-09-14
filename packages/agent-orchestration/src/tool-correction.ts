import type { JsonObject } from '@haiyue/ai-studio-contracts';
import { redactObject } from '@haiyue/ai-studio-operation-log';
import { isRecord, stringField } from './value-utils.js';

// Only errors known to precede a commit are eligible. `retryable` alone does
// not establish that replaying a mutation is safe.
export function toolCorrectionGuidance(code: string): string | null {
  switch (code) {
    case 'plan.payload-invalid':
      return 'Correct the indicated plan fields using the studio.plan.propose schema and resubmit the complete plan. Preserve all user requirements and required acceptance conditions; never remove checks just to pass validation. Await real user approval after the corrected plan is accepted.';
    case 'tool.arguments-invalid':
      return 'Read the exact tool schema with tool.search, correct the reported arguments, and submit a new tool call. Copy returned references unchanged. Do not repeat successful edits.';
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
