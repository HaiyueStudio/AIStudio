/** Device-owned approval preference; projects and model output cannot configure it. */
export type AgentApprovalModeV1 = 'auto-review' | 'ask';
export interface AgentApprovalPreferencesV1 { readonly schemaVersion: 1; readonly mode: AgentApprovalModeV1; }
export const DEFAULT_AGENT_APPROVAL_PREFERENCES: AgentApprovalPreferencesV1 = Object.freeze({ schemaVersion: 1, mode: 'auto-review' });
export function parseAgentApprovalPreferences(value: unknown): AgentApprovalPreferencesV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Agent approval preferences.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'mode,schemaVersion' || record.schemaVersion !== 1 || (record.mode !== 'ask' && record.mode !== 'auto-review')) throw new TypeError('Invalid Agent approval preferences.');
  return Object.freeze({ schemaVersion: 1, mode: record.mode });
}
