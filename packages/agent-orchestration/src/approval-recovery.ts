import type { JsonObject } from '@haiyue/ai-studio-contracts';
/** A model session is replaceable. Consent belongs to its task and exact operation. */
export function matchesRecoveredApproval(content: JsonObject, expected: JsonObject): boolean {
  // Start schemas contain only revision + planId. Revalidation replaces that handle,
  // while the validated preview binds the executable set and runtime configuration.
  const runtimeStart = expected.effect === 'runtime-start' && ['play.start', 'preview.start'].includes(String(expected.toolId));
  return !content.consumedBy && ['allow-once', 'allow-always'].includes(String(content.decision))
    && ['taskId', 'documentId', 'toolId', 'toolVersion', 'target', 'baseRevision', ...(runtimeStart ? [] : ['argsDigest']), 'previewDigest', 'effect', 'risk']
      .every(key => expected[key] !== undefined && expected[key] !== null && content[key] === expected[key]);
}
