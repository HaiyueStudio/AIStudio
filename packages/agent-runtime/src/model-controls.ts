import type {
  AgentTurnConfigV2,
  BackendCapabilityNegotiationV2,
  M12CapabilityId,
  M12ReasoningEffort,
  StableId,
} from '@haiyue/ai-studio-contracts';

export interface AgentModelDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly reasoningEfforts: readonly M12ReasoningEffort[];
  readonly defaultReasoningEffort: M12ReasoningEffort;
  readonly maxOutputTokens: number;
  readonly isDefault: boolean;
}

export interface AgentModelCatalog {
  readonly schemaVersion: 1;
  readonly backendId: StableId;
  readonly protocolVersion: string;
  readonly source: 'provider' | 'pinned-adapter';
  readonly models: readonly AgentModelDescriptor[];
}

export interface BackendNegotiationPolicy {
  readonly backendId: StableId;
  readonly protocolVersion: string;
  readonly catalog: AgentModelCatalog;
  readonly supportedCapabilities: readonly M12CapabilityId[];
  readonly effortFallbacks?: Readonly<Partial<Record<M12ReasoningEffort, M12ReasoningEffort>>>;
}

export function negotiateAgentTurnConfig(config: AgentTurnConfigV2, policy: BackendNegotiationPolicy): BackendCapabilityNegotiationV2 {
  validateAgentTurnConfig(config);
  if (config.backendId !== policy.backendId) return rejected(config, policy, 'backend.id-mismatch', 'Requested backend does not match the selected backend.');
  const model = policy.catalog.models.find((entry) => entry.id === config.model);
  if (!model) return rejected(config, policy, 'backend.model-unsupported', `Model ${config.model} is not advertised by this backend.`);

  const diagnostics: Array<{ code: string; message: string; capability?: M12CapabilityId }> = [];
  let effort = config.reasoningEffort === 'backend-default' ? model.defaultReasoningEffort : config.reasoningEffort;
  if (!model.reasoningEfforts.includes(effort)) {
    const fallback = policy.effortFallbacks?.[effort];
    if (!fallback || !model.reasoningEfforts.includes(fallback)) return rejected(config, policy, 'backend.reasoning-unsupported', `Reasoning effort ${config.reasoningEffort} is not supported by ${model.id}.`);
    diagnostics.push({ code: 'backend.reasoning-degraded', message: `Reasoning effort ${config.reasoningEffort} was explicitly mapped to ${fallback}.` });
    effort = fallback;
  }

  const outputTokenLimit = Math.min(config.outputTokenLimit, model.maxOutputTokens);
  if (outputTokenLimit !== config.outputTokenLimit) diagnostics.push({ code: 'backend.output-limit-capped', message: `Output token limit was capped at ${model.maxOutputTokens}.` });
  const capabilitySet = new Set(policy.supportedCapabilities);
  const capabilities = config.requestedCapabilities.filter((capability) => capabilitySet.has(capability));
  for (const capability of config.requestedCapabilities) {
    if (!capabilitySet.has(capability)) diagnostics.push({ code: 'backend.capability-unsupported', message: `Capability ${capability} is not supported by this backend.`, capability });
  }
  if (capabilities.length !== config.requestedCapabilities.length) {
    return Object.freeze({ schemaVersion: 2, backendId: policy.backendId, protocolVersion: policy.protocolVersion, requested: config, status: 'rejected', effective: null, diagnostics: Object.freeze(diagnostics) });
  }
  return Object.freeze({
    schemaVersion: 2,
    backendId: policy.backendId,
    protocolVersion: policy.protocolVersion,
    requested: config,
    status: diagnostics.length ? 'degraded' : 'accepted',
    effective: Object.freeze({ model: model.id, reasoningEffort: effort, outputTokenLimit, capabilities: Object.freeze(capabilities) }),
    diagnostics: Object.freeze(diagnostics.map((entry) => Object.freeze(entry))),
  });
}

export function validateAgentTurnConfig(value: unknown): AgentTurnConfigV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || !isStableId(value.backendId) || typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 128
    || !reasoningEfforts.has(value.reasoningEffort as string) || !Number.isSafeInteger(value.outputTokenLimit) || (value.outputTokenLimit as number) < 1 || (value.outputTokenLimit as number) > 1_000_000
    || !isStableId(value.taskBudgetId) || !isRecord(value.promptProfile) || !isStableId(value.promptProfile.id)
    || typeof value.promptProfile.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.promptProfile.version)
    || typeof value.promptProfile.digest !== 'string' || !digest.test(value.promptProfile.digest)
    || !Array.isArray(value.requestedCapabilities) || new Set(value.requestedCapabilities).size !== value.requestedCapabilities.length
    || value.requestedCapabilities.some((entry) => typeof entry !== 'string')) throw new AgentModelControlError('agent.turn-config-invalid', 'Agent turn configuration is invalid.');
  return deepFreeze(value) as unknown as AgentTurnConfigV2;
}

export class AgentModelControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AgentModelControlError'; }
}

function rejected(config: AgentTurnConfigV2, policy: BackendNegotiationPolicy, code: string, message: string): BackendCapabilityNegotiationV2 {
  return Object.freeze({ schemaVersion: 2, backendId: policy.backendId, protocolVersion: policy.protocolVersion, requested: config, status: 'rejected', effective: null, diagnostics: Object.freeze([Object.freeze({ code, message })]) });
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isStableId(value: unknown): value is StableId { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
const reasoningEfforts = new Set(['backend-default', 'off', 'low', 'medium', 'high', 'xhigh']);
const digest = /^sha256:[a-f0-9]{64}$/u;
