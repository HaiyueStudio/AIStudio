import type { JsonObject, JsonValue } from '@haiyue/ai-studio-contracts';
import type { GameToolDefinition } from '@haiyue/ai-studio-game-authoring-tools';
import { redactObject } from '@haiyue/ai-studio-operation-log';
import { isRecord, stringField } from './value-utils.js';

// Only errors known to precede a commit are eligible. `retryable` alone does
// not establish that replaying a mutation is safe.
export function toolCorrectionGuidance(code: string): string | null {
  switch (code) {
    case 'plan.payload-invalid':
      return 'Correct the indicated plan fields using the studio.plan.propose schema and resubmit the complete plan. For assertions prefer a structured object {type, signal, operator, expected}. A missing operator/value or nonexistent evidence field is not broken outer JSON: resolve it from the requirement and actual producer data; do not apply guessed defaults. Preserve all user requirements and required acceptance conditions; never remove checks just to pass validation. Await real user approval after the corrected plan is accepted.';
    case 'tool.arguments-invalid':
      return 'Use the supplied exact tool schema to correct the reported fields and submit a new tool call. Use tool.search only if the required schema or constraints are unavailable. Copy returned references unchanged; never guess missing values or repeat successful edits.';
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
export function toolFailureFeedback(result: JsonObject, definition?: Pick<GameToolDefinition, 'id' | 'version' | 'inputSchema'>): JsonObject {
  if (result.status !== 'failed') return {};
  const raw = isRecord(result.error) ? result.error : isRecord(result.value) ? result.value : {};
  const error = redactObject({ code: stringField(raw.code, 'tool.failed').slice(0, 160), message: stringField(raw.message, 'Tool failed without a diagnostic.').slice(0, 2048), retryable: raw.retryable === true }).value;
  const instruction = toolCorrectionGuidance(String(error.code));
  const contract = error.code === 'tool.arguments-invalid' && definition ? correctionContract(definition, String(error.message)) : null;
  return { error, ...(instruction ? { correction: { action: 'revise-and-resubmit', instruction, automaticReplay: false, ...(contract ? { toolContract: contract } : {}) } } : {}) };
}

/** Registry-owned repair context, never a replacement validator or an automatic argument rewrite. */
function correctionContract(definition: Pick<GameToolDefinition, 'id' | 'version' | 'inputSchema'>, message: string): JsonObject {
  const identity = { toolId: definition.id, toolVersion: definition.version };
  const schema = definition.inputSchema;
  if (Buffer.byteLength(JSON.stringify(schema)) <= 4_096) return { ...identity, complete: true, inputSchema: schema };
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
  const keys = Object.keys(properties);
  const selected = [...new Set([...keys.filter(key => message.includes(key)), ...required, ...keys])];
  const fields: Record<string, JsonValue> = {};
  const excerpt: JsonObject = { ...(typeof schema.type === 'string' ? { type: schema.type } : {}), required: required.slice(0, 32),
    ...(typeof schema.additionalProperties === 'boolean' ? { additionalProperties: schema.additionalProperties } : {}), properties: fields };
  if (Buffer.byteLength(JSON.stringify(excerpt)) > 4_096) return { ...identity, complete: false, instruction: 'Use tool.search for the exact schema; required constraints exceed the inline repair budget.' };
  for (const key of selected) {
    if (Object.keys(fields).length >= 8) break;
    fields[key] = properties[key] as JsonValue;
    if (Buffer.byteLength(JSON.stringify(excerpt)) > 4_096) delete fields[key];
  }
  return { ...identity, complete: false, schemaExcerpt: excerpt,
    instruction: 'This is a partial schema, not the full contract. Omitted fields and constraints are unknown. Use the native schema when available; search only for missing constraints. Preserve existing valid arguments.' };
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
