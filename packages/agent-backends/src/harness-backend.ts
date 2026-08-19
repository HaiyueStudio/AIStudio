import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { HarnessAgentTransport, HarnessBridgeEvent } from '@haiyue/ai-studio-harness-bridge/agent';
import { AgentBackendProtocolError, normalizeBackendFailure, type AgentBackend, type AgentBackendDescriptor, type AgentBackendEvent, type AgentBackendStatus, type AgentTurnInput } from '@haiyue/ai-studio-agent-runtime';
import { backendEvent, TurnChannel } from './shared.js';

export interface HarnessApiKeyBackendOptions { readonly transport: HarnessAgentTransport; readonly clearApiKey: () => Promise<void>; }
export class HarnessApiKeyBackend implements AgentBackend {
  readonly upstream = Object.freeze({ tag: 'dsh-v0.1.0-rc.7', commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' });
  readonly descriptor: AgentBackendDescriptor = Object.freeze({ schemaVersion: 1, id: asStableId('backend:harness-api-key'), kind: 'harness-api-key', protocolVersion: 'dsh-v0.1.0-rc.7', capabilities: Object.freeze({ resume: true, questions: false, structuredTools: true, backendApprovals: false, usage: true, rateLimits: false }) });
  private readonly turns = new Map<StableId, TurnChannel>(); private disposed = false;
  constructor(private readonly options: HarnessApiKeyBackendOptions) {}
  async authenticate(): Promise<null> { this.assertActive(); return null; }
  async status(): Promise<AgentBackendStatus> { this.assertActive(); return Object.freeze({ state: await this.options.transport.configured() ? 'ready' : 'auth-required', authMode: 'api-key', rateLimits: Object.freeze([]) }); }
  async logout(): Promise<void> { this.assertActive(); await this.options.clearApiKey(); }
  startTurn(input: AgentTurnInput, signal?: AbortSignal): AsyncIterable<AgentBackendEvent> { this.assertActive(); const channel = new TurnChannel(); void this.run(input, channel, signal); return channel.stream(); }
  resumeTurn(_sessionId: StableId, turnId: StableId): AsyncIterable<AgentBackendEvent> { this.assertActive(); const channel = this.turns.get(turnId); if (!channel) throw new AgentBackendProtocolError('agent.resume-missing', `Harness turn ${turnId} is unavailable.`); return channel.stream(); }
  async submitToolResult(toolCallId: StableId, result: JsonObject, signal?: AbortSignal): Promise<void> { this.assertActive(); await this.options.transport.submitToolResult(toolCallId, result, signal); }
  async answerQuestion(): Promise<void> { throw new AgentBackendProtocolError('agent.question-unavailable', 'Harness question response is not pending.'); }
  async resolveBackendApproval(): Promise<void> { throw new AgentBackendProtocolError('agent.approval-unavailable', 'Harness backend approval is not pending.'); }
  async cancelTurn(sessionId: StableId): Promise<void> { this.assertActive(); await this.options.transport.cancel(sessionId); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await this.options.transport.dispose(); for (const turn of this.turns.values()) turn.terminalFailure(this.descriptor.id, { code: 'agent.backend-disposed', message: 'Harness backend disposed.', retryable: false }, 'interrupted'); this.turns.clear(); }
  private async run(input: AgentTurnInput, channel: TurnChannel, signal?: AbortSignal): Promise<void> { let terminal = false; try { for await (const raw of this.options.transport.start({ sessionId: input.sessionId, prompt: input.prompt, tools: input.tools }, signal)) { const value = normalizeHarnessEvent(this.descriptor.id, raw); if (!this.turns.has(value.turnId)) this.turns.set(value.turnId, channel); channel.emit(value); terminal ||= value.kind === 'completed'; } if (!terminal) channel.terminalFailure(this.descriptor.id, { code: 'agent.stream-without-terminal', message: 'Harness stream closed without a terminal event.', retryable: true }, 'interrupted'); } catch (cause) { channel.terminalFailure(this.descriptor.id, normalizeBackendFailure(cause)); } }
  private assertActive(): void { if (this.disposed) throw new AgentBackendProtocolError('agent.backend-disposed', 'Harness backend is disposed.'); }
}
function normalizeHarnessEvent(backendId: StableId, raw: HarnessBridgeEvent): AgentBackendEvent {
  if (raw.type === 'turn-start') return backendEvent(backendId, raw.sessionId, raw.turnId, 'status', { status: 'running' });
  if (raw.type === 'text-delta') return backendEvent(backendId, raw.sessionId, raw.turnId, 'conversation-node', { nodeKind: 'text', status: 'streaming', delta: raw.text });
  if (raw.type === 'tool-request') return backendEvent(backendId, raw.sessionId, raw.turnId, 'tool-request', { toolCallId: raw.toolCallId, toolId: raw.toolId, arguments: raw.arguments as JsonObject });
  if (raw.type === 'usage') return backendEvent(backendId, raw.sessionId, raw.turnId, 'usage', { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, ...(raw.cacheReadTokens === undefined ? {} : { cacheReadTokens: raw.cacheReadTokens }), ...(raw.reasoningTokens === undefined ? {} : { reasoningTokens: raw.reasoningTokens }) });
  if (raw.diagnostic) return backendEvent(backendId, raw.sessionId, raw.turnId, 'diagnostic', raw.diagnostic);
  return backendEvent(backendId, raw.sessionId, raw.turnId, 'completed', { status: raw.status });
}
