import { asStableId, type AgentTurnConfigV2, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import type { AgentBackend, AgentBackendEvent, AgentTurnInput } from '@haiyue/ai-studio-agent-runtime';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';
import type { GameAuthoringToolRuntime } from './runtime.js';
import { GameToolProtocolError, type GameToolApproval, type GameToolApprovalResolution, type GameToolPreparation, type GameToolResult } from './types.js';

export interface GameToolApprovalPort {
  request(preparation: GameToolPreparation, approval: GameToolApproval, signal?: AbortSignal): Promise<GameToolApprovalResolution>;
}

export interface GameQuestionTakeoverPort {
  answer(event: AgentBackendEvent, signal?: AbortSignal): Promise<JsonObject | null>;
}

export interface AgentGameAuthoringCoordinatorOptions {
  readonly questionTakeover?: GameQuestionTakeoverPort;
  readonly maxToolRequests?: number;
  readonly maxRepeatedToolRequests?: number;
  readonly maxNoProgressToolRequests?: number;
  /** Maximum bytes returned to the provider for one successful tool call. Full results remain in Studio evidence. */
  readonly maxModelToolResultBytes?: number;
  /** Optional provider-visible subset. The Studio runtime retains the full catalog. */
  readonly modelToolIds?: readonly StableId[];
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

export interface AgentTurnExecutionPort {
  start(backendId: StableId, input: AgentTurnInput, signal?: AbortSignal): AsyncIterable<AgentBackendEvent>;
  recordToolResult(turnId: StableId, toolCallId: StableId, result: JsonObject, observedAtMs?: number): Promise<void>;
}

export class AgentGameAuthoringCoordinator {
  private readonly lifecycle = new AbortController();
  private disposed = false;
  constructor(
    private readonly runtime: GameAuthoringToolRuntime,
    private readonly approvals: GameToolApprovalPort,
    private readonly turns?: AgentTurnExecutionPort,
    private readonly options: AgentGameAuthoringCoordinatorOptions = {},
  ) {
    validateOptionalLimit(options.maxToolRequests, 'maxToolRequests');
    validateOptionalLimit(options.maxRepeatedToolRequests, 'maxRepeatedToolRequests');
    validateOptionalLimit(options.maxNoProgressToolRequests, 'maxNoProgressToolRequests');
    validateOptionalLimit(options.maxModelToolResultBytes, 'maxModelToolResultBytes');
    if (options.modelToolIds) {
      if (new Set(options.modelToolIds).size !== options.modelToolIds.length) throw new TypeError('modelToolIds must be unique.');
      const available = new Set(runtime.definitions().map((entry) => entry.id));
      for (const id of options.modelToolIds) if (!available.has(id)) throw new TypeError(`Unknown provider-visible tool ${id}.`);
    }
  }

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
    let toolRequests = 0;
    let previousToolSignature: string | null = null;
    let consecutiveToolRepetitions = 0;
    let noProgressToolRequests = 0;
    let highestDocumentRevision = 0;
    const visible = this.options.modelToolIds ? new Set(this.options.modelToolIds) : null;
    const tools = this.runtime.definitions().filter((definition) => !visible || visible.has(definition.id)).map((definition) => Object.freeze({ id: definition.id, description: `${definition.description} Effect: ${definition.effect}. Risk: ${definition.risk}.`, inputSchema: definition.inputSchema }));
    const turnInput = Object.freeze({ taskId: input.taskId, config: input.config, sessionId: input.sessionId, prompt: input.prompt, contextArtifactIds: input.contextArtifactIds ?? [], tools });
    const events = this.turns ? this.turns.start(backend.descriptor.id, turnInput, controller.signal) : backend.startTurn(turnInput, controller.signal);
    try { for await (const event of events) {
      if (controller.signal.aborted) throw controller.signal.reason;
      sessionId = event.sessionId; turnId = event.turnId; onEvent?.(event);
      if (event.kind === 'tool-request') {
        const toolCallId = stablePayloadId(event.payload.toolCallId, 'tool call id');
        const toolId = stablePayloadId(event.payload.toolId, 'tool id');
        toolRequests += 1;
        noProgressToolRequests += 1;
        const signature = `${toolId}:${canonicalStringify((isRecord(event.payload.arguments) ? event.payload.arguments : {}) as JsonObject)}`;
        consecutiveToolRepetitions = signature === previousToolSignature ? consecutiveToolRepetitions + 1 : 1;
        previousToolSignature = signature;
        const safeguard = toolRequestSafeguard(this.options, toolRequests, consecutiveToolRepetitions, noProgressToolRequests);
        if (safeguard) {
          diagnostics.push(safeguard);
          terminal = 'failed';
          try { await backend.cancelTurn(event.sessionId, event.turnId); }
          catch (cause) { diagnostics.push(Object.freeze({ code: 'agent.turn-cancel-failed', message: cause instanceof Error ? cause.message : String(cause) })); }
          break;
        }
        try {
          if (!isRecord(event.payload.arguments)) throw new GameToolProtocolError('tool.arguments-invalid', 'Backend tool arguments must be a JSON object.');
          const args = event.payload.arguments as JsonObject;
          const preparation = await this.runtime.prepare({ schemaVersion: 1, id: toolCallId, sessionId: event.sessionId, turnId: event.turnId, taskId: input.taskId, toolId, toolVersion: '1.0.0', arguments: args }, controller.signal);
          if (preparation.approvalId) {
            const approval = this.runtime.approval(preparation.approvalId);
            if (!approval) throw new Error('Prepared approval is unavailable.');
            const decision = await this.approvals.request(preparation, approval, controller.signal);
            await this.runtime.decide(approval.approvalId, decision);
          }
          const result = await this.runtime.execute(preparation.id, controller.signal);
          results.push(result);
          if (result.afterRevision > highestDocumentRevision) { highestDocumentRevision = result.afterRevision; noProgressToolRequests = 0; }
          const complete = Object.freeze({ status: result.status, value: result.value, documentId: result.documentId, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, ...(result.historyLabel ? { historyLabel: result.historyLabel } : {}) });
          const submitted = modelToolResult(complete, this.options.maxModelToolResultBytes);
          await backend.submitToolResult(toolCallId, submitted, controller.signal);
          await recordToolAccounting(this.turns, event.turnId, toolCallId, complete, diagnostics);
        } catch (cause) {
          if (controller.signal.aborted) { await this.runtime.cancel(toolCallId).catch(() => undefined); throw controller.signal.reason ?? cause; }
          const diagnostic = Object.freeze({ code: hasCode(cause) ? cause.code : 'tool.execution-failed', message: cause instanceof Error ? cause.message : String(cause) });
          diagnostics.push(diagnostic);
          const submitted = Object.freeze({ status: 'failed', error: diagnostic });
          await backend.submitToolResult(toolCallId, submitted, controller.signal);
          await recordToolAccounting(this.turns, event.turnId, toolCallId, submitted, diagnostics);
        }
      } else if (event.kind === 'question' && this.options.questionTakeover) {
        const nodeId = stablePayloadId(event.payload.nodeId, 'question node id');
        const answer = await this.options.questionTakeover.answer(event, controller.signal);
        if (answer) {
          await backend.answerQuestion(nodeId, answer, controller.signal);
          diagnostics.push(Object.freeze({ code: 'agent.question-auto-answered', message: `Studio automatically answered backend question ${nodeId} using the configured takeover policy.` }));
        } else {
          diagnostics.push(Object.freeze({ code: 'agent.question-takeover-declined', message: `The configured takeover policy declined backend question ${nodeId}.` }));
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
function validateOptionalLimit(value: number | undefined, label: string): void { if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new TypeError(`${label} must be a positive integer.`); }
function modelToolResult(result: JsonObject, maximum: number | undefined): JsonObject {
  if (maximum === undefined || Buffer.byteLength(canonicalStringify(result)) <= maximum) return result;
  const value = isRecord(result.value) ? result.value : {};
  const retained = Object.fromEntries(Object.entries(value).filter(([key, entry]) => /(?:^id$|id$|revision|state|status|count|digest|canApply|requiredAction|planId|proposalId)/iu.test(key) && (entry === null || ['boolean', 'number', 'string'].includes(typeof entry))).slice(0, 32));
  const compact = Object.freeze({
    ...result,
    value: Object.freeze({ ...retained, truncated: true, originalBytes: Buffer.byteLength(canonicalStringify(result)), originalDigest: `sha256:${sha256(canonicalStringify(result))}`, topLevelKeys: Object.keys(value).sort().slice(0, 64) }),
  }) as JsonObject;
  if (Buffer.byteLength(canonicalStringify(compact)) <= maximum) return compact;
  return Object.freeze({ status: result.status, documentId: result.documentId, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, value: Object.freeze({ truncated: true, originalBytes: Buffer.byteLength(canonicalStringify(result)), originalDigest: `sha256:${sha256(canonicalStringify(result))}` }) }) as JsonObject;
}
function toolRequestSafeguard(options: AgentGameAuthoringCoordinatorOptions, total: number, repetitions: number, noProgress: number): Readonly<{ code: string; message: string }> | null {
  if (options.maxToolRequests !== undefined && total > options.maxToolRequests) return Object.freeze({ code: 'agent.tool-call-budget-exceeded', message: `Agent emitted more than ${options.maxToolRequests} tool requests in one turn.` });
  if (options.maxRepeatedToolRequests !== undefined && repetitions > options.maxRepeatedToolRequests) return Object.freeze({ code: 'agent.tool-loop-detected', message: `Agent repeated the same tool request more than ${options.maxRepeatedToolRequests} consecutive times.` });
  if (options.maxNoProgressToolRequests !== undefined && noProgress > options.maxNoProgressToolRequests) return Object.freeze({ code: 'agent.tool-progress-stalled', message: `Agent emitted more than ${options.maxNoProgressToolRequests} tool requests without advancing the document revision.` });
  return null;
}
async function recordToolAccounting(turns: AgentTurnExecutionPort | undefined, turnId: StableId, toolCallId: StableId, result: JsonObject, diagnostics: Array<Readonly<{ code: string; message: string }>>): Promise<void> {
  if (!turns) return;
  try { await turns.recordToolResult(turnId, toolCallId, result, Date.now()); }
  catch (cause) { diagnostics.push(Object.freeze({ code: 'accounting.tool-result-failed', message: cause instanceof Error ? cause.message : String(cause) })); }
}
function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}
