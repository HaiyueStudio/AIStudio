import { asStableId, type AgentTurnConfigV2, type BackendCapabilityNegotiationV2, type JsonObject, type M12ReasoningEffort, type StableId } from '@haiyue/ai-studio-contracts';
import type { HarnessAgentTransport, HarnessBridgeEvent, HarnessReasoningEffort } from '@haiyue/ai-studio-harness-bridge/agent';
import {
  AgentBackendProtocolError,
  negotiateAgentTurnConfig,
  normalizeBackendFailure,
  type AgentBackend,
  type AgentBackendDescriptor,
  type AgentBackendEvent,
  type AgentBackendStatus,
  type AgentModelCatalog,
  type AgentTurnInput,
} from '@haiyue/ai-studio-agent-runtime';
import { backendEvent, toolSetSignature, TurnChannel } from './shared.js';

export interface HarnessApiKeyBackendOptions { readonly transport: HarnessAgentTransport; readonly clearApiKey: () => Promise<void>; }
export class HarnessApiKeyBackend implements AgentBackend {
  readonly upstream = Object.freeze({ tag: 'dsh-v0.1.0-rc.7', commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' });
  readonly descriptor: AgentBackendDescriptor = Object.freeze({ schemaVersion: 1, id: asStableId('backend:harness-api-key'), kind: 'harness-api-key', protocolVersion: 'dsh-v0.1.0-rc.7', capabilities: Object.freeze({ resume: true, questions: false, structuredTools: true, backendApprovals: false, usage: true, rateLimits: false }) });
  private readonly turns = new Map<StableId, TurnChannel>();
  private readonly sessionToolSignatures = new Map<StableId, string>();
  private disposed = false;
  constructor(private readonly options: HarnessApiKeyBackendOptions) {}
  async authenticate(): Promise<null> { this.assertActive(); return null; }
  async status(): Promise<AgentBackendStatus> { this.assertActive(); return Object.freeze({ state: await this.options.transport.configured() ? 'ready' : 'auth-required', authMode: 'api-key', rateLimits: Object.freeze([]) }); }
  async logout(): Promise<void> { this.assertActive(); await this.options.clearApiKey(); }
  async modelCatalog(): Promise<AgentModelCatalog> {
    this.assertActive(); const models = this.options.transport.modelCatalog();
    if (!models.length) throw new AgentBackendProtocolError('harness.model-catalog-empty', 'Harness adapter advertised no models.');
    return Object.freeze({
      schemaVersion: 1, backendId: this.descriptor.id, protocolVersion: this.descriptor.protocolVersion, source: 'pinned-adapter',
      models: Object.freeze(models.map((model, index) => Object.freeze({ id: model.id, label: model.name, description: model.description, reasoningEfforts: Object.freeze(['off', 'low', 'high', 'xhigh'] as const), defaultReasoningEffort: 'high' as const, maxOutputTokens: model.maxTokens, isDefault: index === 0 }))),
    });
  }
  async negotiate(config: AgentTurnConfigV2): Promise<BackendCapabilityNegotiationV2> {
    return negotiateAgentTurnConfig(config, {
      backendId: this.descriptor.id, protocolVersion: this.descriptor.protocolVersion, catalog: await this.modelCatalog(),
      supportedCapabilities: ['agent.model-config', 'agent.usage', 'agent.cache', 'agent.context'], effortFallbacks: { medium: 'high' },
    });
  }
  startTurn(input: AgentTurnInput, signal?: AbortSignal): AsyncIterable<AgentBackendEvent> { this.assertActive(); const channel = new TurnChannel(); void this.run(input, channel, signal); return channel.stream(); }
  resumeTurn(_sessionId: StableId, turnId: StableId): AsyncIterable<AgentBackendEvent> { this.assertActive(); const channel = this.turns.get(turnId); if (!channel) throw new AgentBackendProtocolError('agent.resume-missing', `Harness turn ${turnId} is unavailable.`); return channel.stream(); }
  async submitToolResult(toolCallId: StableId, result: JsonObject, signal?: AbortSignal): Promise<void> { this.assertActive(); await this.options.transport.submitToolResult(toolCallId, result, signal); }
  async answerQuestion(): Promise<void> { this.assertActive(); throw new AgentBackendProtocolError('agent.question-unavailable', 'Harness question response is not pending.'); }
  async resolveBackendApproval(): Promise<void> { this.assertActive(); throw new AgentBackendProtocolError('agent.approval-unavailable', 'Harness backend approval is not pending.'); }
  async cancelTurn(sessionId: StableId): Promise<void> { this.assertActive(); await this.options.transport.cancel(sessionId); }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    let failure: unknown;
    try { await this.options.transport.dispose(); } catch (cause) { failure = cause; }
    finally { for (const turn of this.turns.values()) turn.terminalFailure(this.descriptor.id, { code: 'agent.backend-disposed', message: 'Harness backend disposed.', retryable: false }, 'interrupted'); this.turns.clear(); this.sessionToolSignatures.clear(); }
    if (failure) throw failure;
  }
  private async run(input: AgentTurnInput, channel: TurnChannel, signal?: AbortSignal): Promise<void> {
    let terminal = false; let usageSequence = 0;
    try {
      const tools = toolSetSignature(input.tools);
      if (input.sessionId && this.sessionToolSignatures.has(input.sessionId) && this.sessionToolSignatures.get(input.sessionId) !== tools) {
        throw new AgentBackendProtocolError('harness.session-toolset-drift', `Harness session ${input.sessionId} cannot be reused with a different Studio tool allowlist.`);
      }
      const negotiation = await this.negotiate(input.config); if (!negotiation.effective) throw new AgentBackendProtocolError('agent.config-rejected', negotiation.diagnostics.map((entry) => entry.message).join(' '));
      const effective = negotiation.effective;
      for await (const raw of this.options.transport.start({
        sessionId: input.sessionId, prompt: input.prompt, tools: input.tools, model: effective.model,
        reasoningEffort: harnessEffort(effective.reasoningEffort), maxTokens: effective.outputTokenLimit,
      }, signal)) {
        const value = normalizeHarnessEvent(this.descriptor.id, raw, raw.type === 'usage' ? ++usageSequence : usageSequence, effective);
        if (raw.type === 'turn-start') this.sessionToolSignatures.set(value.sessionId, tools);
        if (!this.turns.has(value.turnId)) this.turns.set(value.turnId, channel); channel.emit(value); terminal ||= value.kind === 'completed';
      }
      if (!terminal) channel.terminalFailure(this.descriptor.id, { code: 'agent.stream-without-terminal', message: 'Harness stream closed without a terminal event.', retryable: true }, 'interrupted');
    } catch (cause) { channel.terminalFailure(this.descriptor.id, normalizeBackendFailure(cause)); }
  }
  private assertActive(): void { if (this.disposed) throw new AgentBackendProtocolError('agent.backend-disposed', 'Harness backend is disposed.'); }
}

function normalizeHarnessEvent(backendId: StableId, raw: HarnessBridgeEvent, usageSequence: number, effective: NonNullable<BackendCapabilityNegotiationV2['effective']>): AgentBackendEvent {
  if (raw.type === 'turn-start') return backendEvent(backendId, raw.sessionId, raw.turnId, 'status', { status: 'running', model: effective.model, reasoningEffort: effective.reasoningEffort, outputTokenLimit: effective.outputTokenLimit });
  if (raw.type === 'text-delta') return backendEvent(backendId, raw.sessionId, raw.turnId, 'conversation-node', { nodeKind: 'text', status: 'streaming', delta: raw.text });
  if (raw.type === 'tool-request') return backendEvent(backendId, raw.sessionId, raw.turnId, 'tool-request', { toolCallId: raw.toolCallId, toolId: raw.toolId, arguments: raw.arguments as JsonObject });
  if (raw.type === 'usage') return backendEvent(backendId, raw.sessionId, raw.turnId, 'usage', {
    eventId: `${raw.turnId}:usage:${usageSequence}`, sequence: usageSequence, mode: 'delta',
    inputTokens: raw.inputTokens + (raw.cacheReadTokens ?? 0) + (raw.cacheWriteTokens ?? 0), outputTokens: raw.outputTokens,
    cachedInputTokens: raw.cacheReadTokens ?? null, cacheWriteTokens: raw.cacheWriteTokens ?? null, reasoningTokens: raw.reasoningTokens ?? null,
  });
  if (raw.diagnostic) return backendEvent(backendId, raw.sessionId, raw.turnId, 'diagnostic', raw.diagnostic);
  return backendEvent(backendId, raw.sessionId, raw.turnId, 'completed', { status: raw.status, finishReason: raw.finishReason });
}
function harnessEffort(value: M12ReasoningEffort): HarnessReasoningEffort { return value === 'xhigh' ? 'max' : value === 'off' || value === 'low' || value === 'high' ? value : 'high'; }
