import type { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import SessionPersistence, { SessionPersistenceRevision, SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionPersistenceNotFoundError, SessionHandleClosedError, SessionReadOnlyError,
  materializeCreateHeader, materializeAppendBatch, validateStoredEvents, assertVersion, assertStoredId, assertContiguous,
  type SessionHandle, type SessionAccess, type SessionPersistenceCreateOptions, type SessionPersistenceOpenOptions, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import { asStableId, isTeamSessionFrameV1, type JsonObject, type TeamSessionJournalPortV1 } from '@haiyue/ai-studio-contracts';

/** Upstream types stay private. All physical storage and leases belong to Studio. */
export class StudioTeamPersistence extends SessionPersistence {
  private handles = new Set<SessionHandle>();
  private closed = false;
  private visible = new Map<string, { header: SessionHeader; inheritedEventCount: SessionLogOffset; events: SessionEvent[] }>();
  private writers = new Map<string, SessionHandle>();
  constructor(ctx: Context, private readonly journal: TeamSessionJournalPortV1) {
    super(ctx);
    ctx.on('session/event', (session, event) => { void this.writers.get(String(session.id))?.append([event]).catch(() => undefined); });
    ctx.on('session/flush', async session => {
      const writer = this.writers.get(String(session.id));
      if (!writer) throw new Error('team.persistence-no-writer');
      await writer.flush();
    });
    ctx.effect(() => async () => { this.closed = true; const results = await Promise.allSettled([...this.handles].map(handle => handle.close())); const errors = results.filter(r => r.status === 'rejected'); if (errors.length) throw new AggregateError(errors.map(r => r.reason), 'team.persistence-disposal'); }, 'studio.team-persistence');
  }
  private async load(id: SessionId) {
    const live = this.visible.get(String(id)); if (live) return live;
    const frames = await this.journal.read(asStableId(String(id)));
    if (!frames.length) return undefined;
    if (frames.some(frame => !isTeamSessionFrameV1(frame) || String(frame.sessionId) !== String(id))) throw new Error('team.persistence-frame-invalid');
    const first = frames[0]!;
    const header = materializeCreateHeader(first.header as unknown as SessionHeader);
    assertVersion(header); assertStoredId(id, header);
    const events: SessionEvent[] = [];
    for (const frame of frames) {
      if (frame.offset !== events.length || JSON.stringify(frame.header) !== JSON.stringify(first.header) || frame.inheritedEventCount !== first.inheritedEventCount) throw new Error('team.persistence-prefix-invalid');
      const batch = validateStoredEvents(header, structuredClone(frame.events) as unknown as SessionEvent[]);
      assertContiguous(id, batch, events.length); events.push(...batch);
    }
    if ((!header.isSeeded && first.inheritedEventCount !== 0) || first.inheritedEventCount > events.length) throw new Error('team.persistence-inheritance-invalid');
    return { header, events, inheritedEventCount: SessionLogOffset(first.inheritedEventCount) };
  }
  async create(input: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const header = materializeCreateHeader(input); assertVersion(header);
    const inherited = options?.inheritedEventCount ?? 0;
    if (!Number.isSafeInteger(inherited) || inherited < 0 || (!header.isSeeded && inherited !== 0) || (header.isSeeded && options?.inheritedEventCount === undefined)) throw new Error('team.persistence-inheritance-invalid');
    return this.handle(header.id, 'write', options?.signal, { header, inheritedEventCount: SessionLogOffset(inherited), events: [] });
  }
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    if (access !== 'read' && access !== 'write') throw new Error('team.persistence-access-invalid');
    return this.handle(id, access, options?.signal);
  }
  private async handle(id: SessionId, access: SessionAccess, signal?: AbortSignal, creating?: { header: SessionHeader; inheritedEventCount: SessionLogOffset; events: SessionEvent[] }): Promise<SessionHandle> {
    if (this.closed) throw new Error('team.persistence-disposed');
    signal?.throwIfAborted();
    const lease = access === 'write' ? await this.journal.acquire(asStableId(String(id))) : null;
    if (access === 'write' && !lease) throw new SessionAlreadyOwnedError(id);
    try {
      const stored = await this.load(id);
      if (creating && stored) throw new SessionAlreadyExistsError(id);
      const initial = creating ?? stored;
      if (!initial) throw new SessionPersistenceNotFoundError(id);
      signal?.throwIfAborted(); if (this.closed) throw new Error('team.persistence-disposed');
      let closed = false, closing: Promise<void> | undefined, count = initial.events.length, materialized = !!stored;
      const current = { ...initial, events: [...initial.events] };
      if (access === 'write') this.visible.set(String(id), current);
      let tail: Promise<void> = Promise.resolve();
      const assert = (operation: string, write = false) => { if (closed) throw new SessionHandleClosedError(id, operation); if (write && access !== 'write') throw new SessionReadOnlyError(id, operation); };
      const commit = async () => {
        // The public append feed is buffered; one flush owns the durability barrier.
        while (count < current.events.length || !materialized) {
          const events = current.events.slice(count, count + 2048);
          await this.journal.append({ schemaVersion: 1, sessionId: asStableId(String(id)), header: initial.header as unknown as JsonObject,
            inheritedEventCount: initial.inheritedEventCount, offset: count, events: events as unknown as JsonObject[] });
          count += events.length; materialized = true;
        }
      };
      const handle: SessionHandle = {
        id, header: Object.freeze(initial.header), inheritedEventCount: initial.inheritedEventCount, access,
        read: async (offset = 0, length, opts) => {
          assert('read'); opts?.signal?.throwIfAborted(); await tail;
          if (!Number.isSafeInteger(offset) || offset < 0 || length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new TypeError('team.persistence-slice-invalid');
          const current = await this.load(id) ?? initial;
          return { events: structuredClone(current.events.slice(offset, length === undefined ? undefined : offset + length)), eventState: 'detached' };
        },
        append: (input, opts) => {
          assert('append', true); opts?.signal?.throwIfAborted();
          const events = publicReplayEvents(materializeAppendBatch(input));
          const work = tail.then(async () => { opts?.signal?.throwIfAborted(); assertContiguous(id, events, current.events.length); current.events.push(...events); });
          tail = work; return work;
        },
        flush: (opts) => { assert('flush', true); opts?.signal?.throwIfAborted(); return tail = tail.then(async () => { opts?.signal?.throwIfAborted(); await commit(); }); },
        close: () => closing ??= (async () => { closed = true; try { await tail; if (access === 'write' && current.events.length >= initial.inheritedEventCount) await commit(); } finally { this.handles.delete(handle); if (this.writers.get(String(id)) === handle) { this.writers.delete(String(id)); this.visible.delete(String(id)); } await lease?.release(); } })(),
        [Symbol.asyncDispose]: () => handle.close(),
      };
      this.handles.add(handle); if (access === 'write') this.writers.set(String(id), handle); return handle;
    } catch (error) { await lease?.release(); throw error; }
  }
  async flush(): Promise<void> { const results = await Promise.allSettled([...this.handles].filter(h => h.access === 'write').map(h => h.flush())); const errors = results.filter(r => r.status === 'rejected'); if (errors.length) throw new AggregateError(errors.map(r => r.reason)); }
  async stat(id: SessionId, options?: SessionPersistenceOpenOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted(); const value = await this.load(id); return value ? { header: structuredClone(value.header), eventCount: value.events.length, revision: SessionPersistenceRevision(`${id}:${value.events.length}`) } : undefined;
  }
  async list(options?: SessionPersistenceOpenOptions): Promise<readonly SessionPersistenceSnapshot[]> { const result = []; for (const id of new Set([...await this.journal.ids(), ...this.visible.keys()])) { const value = await this.stat(SessionId(id), options); if (value) result.push(value); } return result; }
}
/** Hidden reasoning and token-level stream transcripts are never persisted in Studio. */
function publicReplayEvents(input: readonly SessionEvent[]): readonly SessionEvent[] {
  return input.map(event => {
    if (event.type === 'assistant/attempt') return { ...event, data: { ...event.data, stream: [] } };
    if (event.type !== 'assistant/message') return event;
    const source = { ...event.data.message.source };
    // Provider replay metadata indexes the original content and may carry private reasoning state.
    if ('replayState' in source) delete source.replayState;
    return { ...event, data: { ...event.data, stream: [], message: { ...event.data.message, source, content: event.data.message.content.filter(block => block.type !== 'reasoning') } } };
  });
}
