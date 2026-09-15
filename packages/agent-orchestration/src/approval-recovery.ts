import type { JsonObject } from '@haiyue/ai-studio-contracts';
/** A model session is replaceable. Consent belongs to its task and exact operation. */
export function matchesRecoveredApproval(content: JsonObject, expected: JsonObject): boolean {
  return !content.consumedBy && ['allow-once', 'allow-always'].includes(String(content.decision))
    && ['taskId', 'documentId', 'toolId', 'toolVersion', 'target', 'baseRevision', 'argsDigest', 'previewDigest', 'effect', 'risk']
      .every(key => expected[key] !== undefined && expected[key] !== null && content[key] === expected[key]);
}
