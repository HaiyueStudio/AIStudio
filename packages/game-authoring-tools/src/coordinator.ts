import { asStableId, type AgentTurnConfigV2, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { AgentBackend, AgentBackendEvent } from '@haiyue/ai-studio-agent-runtime';
import type { GameAuthoringToolRuntime } from './runtime.js';
import { GameToolProtocolError, type GameToolApproval, type GameToolApprovalResolution, type GameToolPreparation, type GameToolResult } from './types.js';

export interface GameToolApprovalPort {
  request(preparation: GameToolPreparation, approval: GameToolApproval, signal?: AbortSignal): Promise<GameToolApprovalResolution>;
}

export interface AgentGameTurnInput {
  readonly taskId: StableId;
  readonly config: AgentTurnConfigV2;
  readonly prompt: string;
  readonly sessionId?: StableId;
  readonly contextArtifactIds?: readonly StableId[];
}

export interface AgentGameTurnSummary {
  readonly backendId: StableId;
  readonly sessionId: StableId | null;
  readonly turnId: StableId | null;
  readonly terminal: 'completed' | 'cancelled' | 'failed' | 'interrupted';
  readonly results: readonly GameToolResult[];
  readonly diagnostics: readonly Readonly<{ code: string; message: string }>[];
}

export class AgentGameAuthoringCoordinator {
  private readonly lifecycle = new AbortController();
  private disposed = false;
  constructor(private readonly runtime: GameAuthoringToolRuntime, private readonly approvals: GameToolApprovalPort) {}

  async run(backend: AgentBackend, input: AgentGameTurnInput, onEvent?: (event: AgentBackendEvent) => void, signal?: AbortSignal): Promise<AgentGameTurnSummary> {
    this.assertActive();
    const controller = new AbortController();
    const unlinkLifecycle = forwardAbort(this.lifecycle.signal, controller);
    const unlinkCaller = forwardAbort(signal, controller);
    const results: GameToolResult[] = [];
    const diagnostics: Readonly<{ code: string; message: string }>[] = [];
    let sessionId: StableId | null = input.sessionId ?? null;
    let turnId: StableId | null = null;
    let terminal: AgentGameTurnSummary['terminal'] | null = null;
    const tools = this.runtime.definitions().map((definition) => Object.freeze({ id: definition.id, description: `${definition.description} Effect: ${definition.effect}. Risk: ${definition.risk}.`, inputSchema: definition.inputSchema }));
    try { for await (const event of backend.startTurn({ taskId: input.taskId, config: input.config, sessionId: input.sessionId, prompt: input.prompt, contextArtifactIds: input.contextArtifactIds ?? [], tools }, controller.signal)) {
      if (controller.signal.aborted) throw controller.signal.reason;
      sessionId = event.sessionId; turnId = event.turnId; onEvent?.(event);
      if (event.kind === 'tool-request') {
        const toolCallId = stablePayloadId(event.payload.toolCallId, 'tool call id');
        const toolId = stablePayloadId(event.payload.toolId, 'tool id');
        try {
          if (!isRecord(event.payload.arguments)) throw new GameToolProtocolError('tool.arguments-invalid', 'Backend tool arguments must be a JSON object.');
          const args = event.payload.arguments as JsonObject;
          const preparation = await this.runtime.prepare({ schemaVersion: 1, id: toolCallId, sessionId: event.sessionId, turnId: event.turnId, toolId, toolVersion: '1.0.0', arguments: args }, controller.signal);
          if (preparation.approvalId) {
            const approval = this.runtime.approval(preparation.approvalId);
            if (!approval) throw new Error('Prepared approval is unavailable.');
            const decision = await this.approvals.request(preparation, approval, controller.signal);
            await this.runtime.decide(approval.approvalId, decision);
          }
          const result = await this.runtime.execute(preparation.id, controller.signal);
          results.push(result);
          await backend.submitToolResult(toolCallId, Object.freeze({ status: result.status, value: result.value, documentId: result.documentId, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, ...(result.historyLabel ? { historyLabel: result.historyLabel } : {}) }), controller.signal);
        } catch (cause) {
          if (controller.signal.aborted) { await this.runtime.cancel(toolCallId).catch(() => undefined); throw controller.signal.reason ?? cause; }
          const diagnostic = Object.freeze({ code: hasCode(cause) ? cause.code : 'tool.execution-failed', message: cause instanceof Error ? cause.message : String(cause) });
          diagnostics.push(diagnostic);
          await backend.submitToolResult(toolCallId, Object.freeze({ status: 'failed', error: diagnostic }), controller.signal);
        }
      } else if (event.kind === 'diagnostic') {
        diagnostics.push(Object.freeze({ code: typeof event.payload.code === 'string' ? event.payload.code : 'agent.diagnostic', message: typeof event.payload.message === 'string' ? event.payload.message : 'Agent backend reported a diagnostic.' }));
      } else if (event.kind === 'completed') {
        const status = event.payload.status;
        terminal = status === 'completed' || status === 'cancelled' || status === 'failed' || status === 'interrupted' ? status : 'failed';
      }
    } } finally { unlinkCaller(); unlinkLifecycle(); }
    if (!terminal) terminal = 'interrupted';
    return Object.freeze({ backendId: backend.descriptor.id, sessionId, turnId, terminal, results: Object.freeze(results), diagnostics: Object.freeze(diagnostics) });
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.lifecycle.abort(new GameToolProtocolError('tool.coordinator-disposed', 'Agent game authoring coordinator is disposed.')); }
  private assertActive(): void { if (this.disposed) throw new Error('Agent game authoring coordinator is disposed.'); }
}

function stablePayloadId(value: unknown, label: string): StableId { if (typeof value !== 'string') throw new TypeError(`${label} is invalid.`); return asStableId(value, label); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function hasCode(value: unknown): value is Readonly<{ code: string }> { return Boolean(value) && typeof value === 'object' && typeof (value as Record<string, unknown>).code === 'string'; }
function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}
