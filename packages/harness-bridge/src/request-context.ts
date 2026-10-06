import { isModelRequestPreparationV1, type JsonObject, type ModelRequestContextPortV1, type ModelRequestContextV1, type ModelRequestPreparationV1 } from '@haiyue/ai-studio-contracts';
import { LlmError, createUserMessage, type GenerateOptions, type RequestMessage, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { isSurfaceEvent, Session, type SurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'studio.request-context': { kind: 'studio.request-context'; form: 'recall' };
  }
}

export const REQUEST_REBUILD = 'STUDIO_CONTEXT_REBUILD';

/** Public append-only Surface operations only: no frozen request or private loop mutation. */
export class HarnessRequestContext {
  port?: ModelRequestContextPortV1;
  private epoch = 0;
  private usage: ModelRequestContextV1['previousUsage'] = null;
  private staged?: ModelRequestPreparationV1;
  private original?: readonly SurfaceEvent[];
  private readonly activeSurface = new Map<number, SurfaceEvent>();
  private currentTurn = 0;
  constructor(private readonly session: Session, private readonly capacity: (model: string) => number | null, private readonly prepared: (id: string, turnId: string, confirmed?: boolean) => void) {}

  get turn(): number { return this.currentTurn; }

  /** Maintain only the active Surface from committed events, never scan the full log. */
  observe(event: SessionEvent): void {
    if (event.type === 'turn/start') this.currentTurn = event.data.turn;
    if (!isSurfaceEvent(event)) return;
    this.activeSurface.set(event.seq, event);
    if (event.surfaceOp !== 'append') {
      const retained = new Set<number>(this.session.surface.nodes);
      for (const seq of this.activeSurface.keys()) if (!retained.has(seq)) this.activeSurface.delete(seq);
    }
  }

  async *stream(request: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (!this.currentTurn) throw new Error('Request has no turn boundary.');
    // Size includes replay payload and complete tool schemas without exporting hidden reasoning.
    const requestBytes = Buffer.byteLength(JSON.stringify({ model: request.model, messages: request.messages, tools: request.tools ?? [], maxTokens: request.maxTokens, reasoningEffort: request.reasoningEffort }));
    const names = new Map(request.messages.flatMap(m => m.content.flatMap(b => b.type === 'tool-call' ? [[String(b.id), b.name] as const] : [])));
    const projection: ModelRequestContextV1 = {
      schemaVersion: 1, sessionId: String(this.session.id), turnId: `${this.session.id}:turn:${this.currentTurn}`, model: request.model,
      epoch: this.epoch + (this.original ? 1 : 0), maxInputTokens: this.capacity(request.model), reservedOutputTokens: request.maxTokens ?? 8192,
      requestBytes, previousUsage: this.usage,
      tools: (request.tools ?? []) as unknown as readonly JsonObject[],
      messages: request.messages.map(message => {
        if (!message.id || !message.source) throw new LlmError('Studio context requires identified session messages.', 'context.unidentified-message');
        return { id: String(message.id), requestBytes: Buffer.byteLength(JSON.stringify(message)), failed: failedToolResult(message), role: message.role === 'developer' ? 'system' : message.role,
        text: message.content.filter(block => block.type !== 'reasoning').map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('\n'),
        toolCallIds: message.content.flatMap(block => block.type === 'tool-call' ? [String(block.id)] : []),
        toolName: message.role === 'tool' ? names.get(String(message.toolCallId)) ?? null : null,
        resultFor: message.role === 'tool' ? String(message.toolCallId) : null };
      }),
    };
    try {
      const prepared = this.port ? await this.port.prepare(projection, request.signal) : this.defaultPreparation(projection);
      if (!isModelRequestPreparationV1(prepared)) throw new Error('Invalid request preparation.');
      request.signal?.throwIfAborted();
      if (prepared.replacement) {
        if (this.original) throw new Error('A staged request cannot be compacted again before confirmation.');
        this.staged = prepared;
        yield { type: 'finish', reason: { kind: 'error', failure: { code: REQUEST_REBUILD, message: 'Rebuild from prepared Studio context.' } } };
        return;
      }
      if (this.port) this.prepared(prepared.id, projection.turnId);
      let usage: TokenUsage | undefined;
      let successful = false;
      for await (const chunk of next()) {
        request.signal?.throwIfAborted();
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') {
          successful = chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted';
          if (!successful) this.rollback();
        }
        yield chunk;
      }
      if (!successful) { this.rollback(); return; }
      request.signal?.throwIfAborted();
      await this.port?.confirm(prepared.id, request.signal);
      if (this.original) this.epoch += 1;
      this.original = undefined;
      if (usage) this.usage = { inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), requestBytes };
      if (this.port) this.prepared(prepared.id, projection.turnId, true);
    } catch (cause) {
      this.rollback();
      if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string' && /^context\.[a-z-]+$/u.test(cause.code)) throw new LlmError(cause.message, cause.code, { cause });
      throw cause;
    }
  }

  finish(): void { if (this.original || this.staged) this.rollback(); }

  rebuild(): boolean {
    const replacement = this.staged?.replacement;
    this.staged = undefined;
    if (!replacement) return false;
    const surface = this.surface();
    const start = surface.findIndex(e => !protectedEvent(e));
    const end = surface.findIndex(e => this.session.deriveEventMessage(e)?.id === replacement.throughMessageId);
    if (start < 0 || end < start || surface.slice(start, end + 1).some(protectedEvent)) throw new Error('Prepared replacement range is stale.');
    const open = new Set<string>();
    for (const event of surface.slice(start, end + 1)) {
      const m = this.session.deriveEventMessage(event);
      for (const block of m?.content ?? []) if (block.type === 'tool-call') open.add(String(block.id));
      if (m?.role === 'tool') open.delete(String(m.toolCallId));
    }
    if (open.size) throw new Error('Prepared replacement splits a tool call/result pair.');
    const message = createUserMessage({ content: [{ type: 'text', text: replacement.summary }], source: { kind: 'studio.request-context', form: 'recall' } });
    const intent = { surfaceOp: { op: 'replace' as const, startSeq: surface[start]!.seq, endSeq: surface[end]!.seq }, sourceEventSeqs: surface.slice(start, end + 1).map(e => e.seq) };
    // Session.append validates the complete replacement before its atomic publication.
    this.session.append('user/message', message, intent);
    this.original = surface;
    return true;
  }

  private defaultPreparation(request: ModelRequestContextV1): ModelRequestPreparationV1 {
    const usable = request.maxInputTokens === null ? null : request.maxInputTokens - request.reservedOutputTokens - 4096;
    if (usable !== null && (usable <= 0 || request.requestBytes / 3 >= usable * 0.92)) throw new Error('context.emergency-request-blocked: actual request exceeds the context window.');
    return { id: 'bridge-request' };
  }
  private surface(): SurfaceEvent[] {
    return this.session.surface.nodes.map(seq => {
      const event = this.activeSurface.get(seq);
      if (!event) throw new Error('Studio Surface projection is incomplete.');
      return event;
    });
  }
  private rollback(): void {
    this.port?.discard?.();
    this.staged = undefined;
    if (!this.original) return;
    const original = this.original;
    const current = this.surface();
    // Restore the complete original non-system sequence, including exact native tool pairing.
    const retained = original.filter(e => !protectedEvent(e));
    const replaced = current.filter(e => !protectedEvent(e));
    if (retained[0]?.type !== 'user/message' || !replaced.length) throw new Error('Request Surface cannot be rolled back safely.');
    if (current.slice(current.indexOf(replaced[0]!), current.indexOf(replaced.at(-1)!) + 1).some(protectedEvent)) throw new Error('Request rollback would replace protected context.');
    // Validate only the retained Surface, not another copy of the entire transcript.
    // No await occurs between this validation and the append-only restoration.
    const validation = Session.create(this.session.id);
    for (const event of retained) appendRetained(validation, event);
    const restore = (session: Session): void => {
      session.append('user/message', retained[0]!.data as Extract<SessionEvent, { type: 'user/message' }>['data'], {
        surfaceOp: { op: 'replace', startSeq: replaced[0]!.seq, endSeq: replaced.at(-1)!.seq }, sourceEventSeqs: replaced.map(e => e.seq),
      });
      for (const event of retained.slice(1)) appendRetained(session, event);
    };
    restore(this.session);
    this.original = undefined;
  }
}

function protectedEvent(event: SurfaceEvent): boolean { return event.type === 'system/message' || event.type === 'developer/message'; }
function appendRetained(session: Session, event: SurfaceEvent): void {
  if (event.type === 'user/message') session.append(event.type, event.data, { surfaceOp: 'append' });
  else if (event.type === 'assistant/message') {
    const { usage: _usage, ...data } = event.data;
    session.append(event.type, data, { surfaceOp: 'append' });
  } else if (event.type === 'tool/result') session.append(event.type, event.data, { surfaceOp: 'append' });
}
function failedToolResult(message: RequestMessage): boolean {
  if (message.role !== 'tool') return false;
  return message.isError === true || message.content.some(part => {
    if (part.type !== 'text') return false;
    try { const value: unknown = JSON.parse(part.text); return value !== null && typeof value === 'object' && 'status' in value && ['failed', 'cancelled', 'rejected'].includes(String(value.status)); }
    catch { return false; }
  });
}
