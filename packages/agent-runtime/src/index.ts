import { asStableId, createStudioServiceToken, defineStudioPlugin, type JsonObject, type JsonValue, type StableId, type StudioPluginDefinition } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, operationLogServiceToken, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';

export type AgentBackendKind = 'harness-api-key' | 'codex-app-server';
export type AgentBackendEventKind = 'status' | 'conversation-node' | 'tool-request' | 'question' | 'approval' | 'usage' | 'completed' | 'diagnostic';
export type AgentTerminalStatus = 'completed' | 'cancelled' | 'failed' | 'interrupted';

export interface AgentBackendCapabilities {
  readonly resume: boolean; readonly questions: boolean; readonly structuredTools: true;
  readonly backendApprovals: boolean; readonly usage: boolean; readonly rateLimits: boolean;
}
export interface AgentBackendDescriptor {
  readonly schemaVersion: 1; readonly id: StableId; readonly kind: AgentBackendKind;
  readonly protocolVersion: string; readonly capabilities: AgentBackendCapabilities;
}
export interface AgentRateLimitSnapshot { readonly name: string; readonly usedPercent?: number; readonly resetsAt?: string; }
export interface AgentBackendStatus {
  readonly state: 'ready' | 'auth-required' | 'authenticating' | 'unavailable' | 'error';
  readonly authMode: 'api-key' | 'chatgpt' | 'none'; readonly accountPlan?: string;
  readonly rateLimits: readonly AgentRateLimitSnapshot[]; readonly diagnostic?: Readonly<{ code: string; message: string }>;
}
export interface AgentLoginHandoff { readonly id: StableId; readonly kind: 'browser' | 'device-code'; readonly url?: string; readonly userCode?: string; }
export interface AgentTurnInput {
  readonly sessionId?: StableId; readonly prompt: string; readonly contextArtifactIds: readonly StableId[];
  readonly tools: readonly Readonly<{ id: StableId; description: string; inputSchema: JsonObject }>[];
}
export interface AgentBackendEvent {
  readonly schemaVersion: 1; readonly backendId: StableId; readonly sessionId: StableId; readonly turnId: StableId;
  readonly kind: AgentBackendEventKind; readonly payload: JsonObject;
}
export interface AgentBackend {
  readonly descriptor: AgentBackendDescriptor;
  readonly upstream?: Readonly<Record<string, string>>;
  authenticate(signal?: AbortSignal): Promise<AgentLoginHandoff | null>;
  status(signal?: AbortSignal): Promise<AgentBackendStatus>;
  logout(signal?: AbortSignal): Promise<void>;
  startTurn(input: AgentTurnInput, signal?: AbortSignal): AsyncIterable<AgentBackendEvent>;
  resumeTurn(sessionId: StableId, turnId: StableId, signal?: AbortSignal): AsyncIterable<AgentBackendEvent>;
  submitToolResult(toolCallId: StableId, result: JsonObject, signal?: AbortSignal): Promise<void>;
  answerQuestion(nodeId: StableId, answer: JsonObject, signal?: AbortSignal): Promise<void>;
  resolveBackendApproval(id: StableId, decision: 'allow' | 'reject', signal?: AbortSignal): Promise<void>;
  cancelTurn(sessionId: StableId, turnId: StableId): Promise<void>;
  dispose(): void | Promise<void>;
}

export class AgentBackendProtocolError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AgentBackendProtocolError'; }
}

export class AgentBackendRegistry {
  private readonly backends = new Map<StableId, AgentBackend>();
  private disposed = false;
  register(backend: AgentBackend): Readonly<{ dispose(): Promise<void> }> {
    this.assertActive(); validateAgentBackendDescriptor(backend.descriptor);
    if (this.backends.has(backend.descriptor.id)) throw new AgentBackendProtocolError('agent.backend-duplicate', `Backend ${backend.descriptor.id} is already registered.`);
    this.backends.set(backend.descriptor.id, backend);
    let active = true;
    return Object.freeze({ dispose: async () => { if (!active) return; active = false; if (this.backends.get(backend.descriptor.id) === backend) this.backends.delete(backend.descriptor.id); await backend.dispose(); } });
  }
  get(id: StableId): AgentBackend { this.assertActive(); const value = this.backends.get(id); if (!value) throw new AgentBackendProtocolError('agent.backend-missing', `Backend ${id} is not registered.`); return value; }
  descriptors(): readonly AgentBackendDescriptor[] { this.assertActive(); return Object.freeze([...this.backends.values()].map((item) => item.descriptor).sort((a, b) => a.id.localeCompare(b.id))); }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true; const values = [...this.backends.values()].reverse(); this.backends.clear(); const errors: unknown[] = [];
    for (const backend of values) { try { await backend.dispose(); } catch (cause) { errors.push(cause); } }
    if (errors.length === 1) throw errors[0]; if (errors.length > 1) throw new AggregateError(errors, 'Multiple agent backends failed during disposal.');
  }
  private assertActive(): void { if (this.disposed) throw new AgentBackendProtocolError('agent.registry-disposed', 'Agent backend registry is disposed.'); }
}

export class AgentTurnRuntime {
  private readonly active = new Map<StableId, AbortController>();
  private disposed = false;
  constructor(private readonly registry: AgentBackendRegistry, private readonly log: OperationLog) {}
  async *start(backendId: StableId, input: AgentTurnInput, signal?: AbortSignal): AsyncIterable<AgentBackendEvent> {
    this.assertActive(); validateTurnInput(input);
    const backend = this.registry.get(backendId);
    yield* this.consume(backend, backend.startTurn(input, signal), input, signal);
  }
  async *resume(backendId: StableId, sessionId: StableId, turnId: StableId, signal?: AbortSignal): AsyncIterable<AgentBackendEvent> {
    this.assertActive(); const backend = this.registry.get(backendId);
    yield* this.consume(backend, backend.resumeTurn(sessionId, turnId, signal), undefined, signal);
  }
  async cancel(backendId: StableId, sessionId: StableId, turnId: StableId): Promise<void> {
    this.active.get(turnId)?.abort(new Error('Studio turn cancelled.'));
    await this.registry.get(backendId).cancelTurn(sessionId, turnId);
  }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; for (const controller of this.active.values()) controller.abort(new Error('Agent runtime disposed.')); this.active.clear(); await this.registry.dispose(); }
  private async *consume(backend: AgentBackend, events: AsyncIterable<AgentBackendEvent>, input?: AgentTurnInput, signal?: AbortSignal): AsyncIterable<AgentBackendEvent> {
    const controller = new AbortController(); const unlink = fuseAbort(signal, controller);
    let terminal = false; let coordinates: Readonly<{ sessionId: StableId; turnId: StableId }> | null = null;
    try {
      if (input) await this.log.append({ kind: 'agent/context-prepared', severity: 'info', source: asStableId('studio.agent-runtime'), payload: {
        backendId: backend.descriptor.id, promptDigest: sha256(input.prompt), promptBytes: Buffer.byteLength(input.prompt), contextArtifactIds: input.contextArtifactIds, toolIds: input.tools.map((tool) => tool.id),
      }, provenance: { backendId: backend.descriptor.id, upstream: backend.upstream ?? { protocolVersion: backend.descriptor.protocolVersion } } }, { signal: controller.signal });
      for await (const raw of events) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const event = validateAgentBackendEvent(raw, backend.descriptor.id);
        coordinates ??= Object.freeze({ sessionId: event.sessionId, turnId: event.turnId });
        if (event.sessionId !== coordinates.sessionId || event.turnId !== coordinates.turnId) throw new AgentBackendProtocolError('agent.coordinate-drift', 'Backend changed session/turn identity within one stream.');
        if (terminal) throw new AgentBackendProtocolError('agent.event-after-terminal', 'Backend emitted an event after terminal completion.');
        if (event.kind === 'completed') terminal = true;
        this.active.set(event.turnId, controller);
        await this.log.append({ kind: `agent/${event.kind}`, severity: event.kind === 'diagnostic' ? 'error' : 'info', source: asStableId('studio.agent-runtime'),
          correlation: eventCorrelation(event),
          payload: eventLogPayload(event),
          provenance: { backendId: backend.descriptor.id, upstream: backend.upstream ?? { protocolVersion: backend.descriptor.protocolVersion } },
        }, { signal: controller.signal });
        yield event;
      }
      if (!terminal) throw new AgentBackendProtocolError('agent.stream-without-terminal', 'Backend stream closed without a terminal event.');
    } finally { if (coordinates) this.active.delete(coordinates.turnId); unlink(); }
  }
  private assertActive(): void { if (this.disposed) throw new AgentBackendProtocolError('agent.runtime-disposed', 'Agent turn runtime is disposed.'); }
}

export interface AgentRuntimeService { readonly registry: AgentBackendRegistry; readonly turns: AgentTurnRuntime; }
export const agentRuntimeServiceToken = createStudioServiceToken<AgentRuntimeService>('studio.agent-runtime');
export const agentBackendRegistryToken = createStudioServiceToken<AgentBackendRegistry>('studio.agent-backend-registry');

export interface AgentRuntimePluginOptions { readonly createBackends: () => readonly AgentBackend[] | Promise<readonly AgentBackend[]>; }
export function createAgentRuntimePlugin(options: AgentRuntimePluginOptions): StudioPluginDefinition<JsonObject> {
  return defineStudioPlugin({
    manifest: {
      schemaVersion: 1, id: asStableId('studio.agent-runtime.plugin'), version: '0.0.0', apiVersion: '1.0',
      required: [{ id: asStableId('studio.operation-log'), version: '^1.0.0' }], optional: [],
      provides: [{ id: asStableId('studio.agent-runtime'), version: '1.0.0' }], contributions: [], activationPolicy: 'required',
    },
    validateConfig(value): JsonObject { if (!isRecord(value)) throw new TypeError('Agent runtime config must be an object.'); return Object.freeze({}); },
    async activate(context) {
      const log = context.services.get(operationLogServiceToken).log;
      const registry = new AgentBackendRegistry();
      try {
        for (const backend of await options.createBackends()) registry.register(backend);
        context.owner.assertActive();
      } catch (cause) { await registry.dispose(); throw cause; }
      const turns = new AgentTurnRuntime(registry, log); const service = Object.freeze({ registry, turns });
      context.services.provide(agentBackendRegistryToken, registry); context.services.provide(agentRuntimeServiceToken, service);
      context.effects.own('agent-runtime.dispose', () => turns.dispose());
    },
  });
}

export function validateAgentBackendDescriptor(value: unknown): AgentBackendDescriptor {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isStableId(value.id) || !isKind(value.kind) || typeof value.protocolVersion !== 'string' || value.protocolVersion.length === 0
    || !isRecord(value.capabilities) || Object.keys(value).some((key) => !descriptorKeys.has(key))) throw new AgentBackendProtocolError('agent.descriptor-invalid', 'Agent backend descriptor is invalid.');
  const caps = value.capabilities;
  if (Object.keys(caps).some((key) => !capabilityKeys.has(key))) throw new AgentBackendProtocolError('agent.descriptor-invalid', 'Agent backend capabilities contain unknown fields.');
  for (const key of ['resume', 'questions', 'structuredTools', 'backendApprovals', 'usage', 'rateLimits']) if (typeof caps[key] !== 'boolean') throw new AgentBackendProtocolError('agent.descriptor-invalid', `Capability ${key} is invalid.`);
  if (caps.structuredTools !== true) throw new AgentBackendProtocolError('agent.structured-tools-required', 'Backend must support structured tools.');
  return deepFreeze(value) as unknown as AgentBackendDescriptor;
}
export function validateAgentBackendEvent(value: unknown, backendId?: StableId): AgentBackendEvent {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isStableId(value.backendId) || !isStableId(value.sessionId) || !isStableId(value.turnId)
    || !eventKinds.has(value.kind as string) || !isJsonObject(value.payload) || (backendId && value.backendId !== backendId)) throw new AgentBackendProtocolError('agent.event-invalid', 'Agent backend event is invalid.');
  if (value.kind === 'completed' && (!isRecord(value.payload) || !terminalStatuses.has(value.payload.status as string))) throw new AgentBackendProtocolError('agent.terminal-invalid', 'Agent terminal status is invalid.');
  return deepFreeze(value) as unknown as AgentBackendEvent;
}
export function normalizeBackendFailure(cause: unknown): Readonly<{ code: string; message: string; retryable: boolean }> {
  const record = isRecord(cause) ? cause : undefined; const status = typeof record?.status === 'number' ? record.status : undefined;
  if (cause instanceof AgentBackendProtocolError && status !== 401 && status !== 429) return Object.freeze({ code: cause.code, message: cause.message, retryable: false });
  const code = status === 401 ? 'agent.auth-required' : status === 429 ? 'agent.rate-limited' : 'agent.backend-failed';
  return Object.freeze({ code, message: cause instanceof Error ? cause.message : String(cause), retryable: status === 429 || (status !== undefined && status >= 500) });
}

function validateTurnInput(input: AgentTurnInput): void {
  if (typeof input.prompt !== 'string' || input.prompt.length === 0 || input.prompt.length > 200_000 || !Array.isArray(input.tools) || !Array.isArray(input.contextArtifactIds)
    || input.contextArtifactIds.some((id) => !isStableId(id)) || input.tools.some((tool) => !isStableId(tool?.id) || typeof tool.description !== 'string' || !isJsonObject(tool.inputSchema))) throw new AgentBackendProtocolError('agent.turn-input-invalid', 'Agent turn input is invalid.');
}
function fuseAbort(parent: AbortSignal | undefined, controller: AbortController): () => void { if (!parent) return () => {}; const abort = (): void => controller.abort(parent.reason); if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true }); return () => parent.removeEventListener('abort', abort); }
function isKind(value: unknown): value is AgentBackendKind { return value === 'harness-api-key' || value === 'codex-app-server'; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isStableId(value: unknown): value is StableId { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value); }
function isJsonObject(value: unknown): value is JsonObject { try { return isRecord(value) && JSON.stringify(value) !== undefined && !containsInvalidJson(value); } catch { return false; } }
function containsInvalidJson(value: unknown): boolean { if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || (typeof value === 'number' && !Number.isFinite(value))) return true; if (Array.isArray(value)) return value.some(containsInvalidJson); if (isRecord(value)) return Object.values(value).some(containsInvalidJson); return false; }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); Object.freeze(value); } return value; }
const eventKinds = new Set(['status', 'conversation-node', 'tool-request', 'question', 'approval', 'usage', 'completed', 'diagnostic']);
const terminalStatuses = new Set<string>(['completed', 'cancelled', 'failed', 'interrupted']);
const descriptorKeys = new Set(['schemaVersion', 'id', 'kind', 'protocolVersion', 'capabilities']);
const capabilityKeys = new Set(['resume', 'questions', 'structuredTools', 'backendApprovals', 'usage', 'rateLimits']);

function eventCorrelation(event: AgentBackendEvent): Readonly<{ sessionId: StableId; turnId: StableId; toolCallId?: StableId; approvalId?: StableId }> {
  const toolCallId = isStableId(event.payload.toolCallId) ? event.payload.toolCallId : undefined;
  const approvalId = isStableId(event.payload.approvalId) ? event.payload.approvalId : undefined;
  return Object.freeze({ sessionId: event.sessionId, turnId: event.turnId, ...(toolCallId ? { toolCallId } : {}), ...(approvalId ? { approvalId } : {}) });
}

function eventLogPayload(event: AgentBackendEvent): JsonObject {
  const base: JsonObject = { backendId: event.backendId, eventKind: event.kind, payloadDigest: sha256(canonicalStringify(event.payload)), payloadKeys: Object.keys(event.payload).sort() };
  if (event.kind === 'usage') return Object.freeze({ ...base, usage: safeUsage(event.payload) });
  if (event.kind === 'tool-request') return Object.freeze({ ...base,
    ...(isStableId(event.payload.toolCallId) ? { toolCallId: event.payload.toolCallId } : {}),
    ...(typeof event.payload.toolId === 'string' ? { toolId: event.payload.toolId } : {}),
    argumentsDigest: sha256(canonicalStringify(event.payload.arguments ?? null)),
    argumentKeys: isRecord(event.payload.arguments) ? Object.keys(event.payload.arguments).sort() : [],
  });
  if (event.kind === 'conversation-node') return Object.freeze({ ...base,
    ...(typeof event.payload.nodeKind === 'string' ? { nodeKind: event.payload.nodeKind } : {}),
    ...(typeof event.payload.status === 'string' ? { status: event.payload.status } : {}),
    ...(typeof event.payload.nodeId === 'string' ? { nodeId: event.payload.nodeId } : {}),
    ...(typeof event.payload.delta === 'string' ? { deltaDigest: sha256(event.payload.delta), deltaBytes: Buffer.byteLength(event.payload.delta) } : {}),
  });
  if (event.kind === 'diagnostic') return Object.freeze({ ...base,
    ...(typeof event.payload.code === 'string' ? { code: event.payload.code } : {}),
    ...(typeof event.payload.retryable === 'boolean' ? { retryable: event.payload.retryable } : {}),
    ...(typeof event.payload.message === 'string' ? { messageDigest: sha256(event.payload.message), messageBytes: Buffer.byteLength(event.payload.message) } : {}),
  });
  return Object.freeze({ ...base, ...pickScalars(event.payload, ['status', 'nodeId', 'approvalId', 'domain', 'requestKind', 'decision', 'isBlocking']) });
}

function safeUsage(payload: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) result[key] = value;
    else if (key === 'rateLimits' && Array.isArray(value)) result[key] = value.map((item) => isRecord(item) ? pickScalars(item, ['name', 'usedPercent', 'resetsAt']) : null);
    else if ((key === 'total' || key === 'last') && isRecord(value)) result[key] = pickNumeric(value);
  }
  return Object.freeze(result);
}
function pickNumeric(value: Record<string, unknown>): JsonObject { return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'number')) as Record<string, number>); }
function pickScalars(value: Record<string, unknown>, keys: readonly string[]): JsonObject { const result: Record<string, JsonValue> = {}; for (const key of keys) { const item = value[key]; if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) result[key] = item; } return Object.freeze(result); }
