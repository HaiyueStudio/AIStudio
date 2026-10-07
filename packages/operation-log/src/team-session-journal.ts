import { asStableId, isTeamSessionFrameV1, type JsonObject, type StableId, type TeamSessionFrameV1, type TeamSessionJournalPortV1 } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from './canonical.js';
import { redactObject } from './redaction.js';
import { scanRetainedEvents } from './retained-events.js';
import type { OperationLog } from './operation-log.js';

const kind = 'agent/team-session-frame';
/** No sidecar database: immutable frames and their hash chain live in the existing journal. */
export function createTeamSessionJournal(log: OperationLog, claims: Pick<TeamSessionJournalPortV1, 'acquire'>): TeamSessionJournalPortV1 {
  const owned = new Set<StableId>();
  const tails = new Map<StableId, Promise<void>>();
  const records = async (id?: StableId) => {
    if (log.status().retainedFromSequence > 0) throw new Error('team.journal-retained-prefix-missing');
    const result = [];
    for await (const event of scanRetainedEvents(log, [kind])) if (!id || event.correlation.sessionId === id) result.push(event);
    return result;
  };
  const read = async (id: StableId): Promise<readonly TeamSessionFrameV1[]> => {
    asStableId(id);
    const frames: TeamSessionFrameV1[] = []; let previous: string | null = null, offset = 0;
    for (const event of await records(id)) {
      if (event.source !== 'studio.team-journal' || event.payload.previous !== previous || typeof event.payload.artifactId !== 'string') throw new Error('team.journal-chain-invalid');
      const artifact = await log.readArtifact(asStableId(event.payload.artifactId));
      const value = artifact?.value;
      if (!isTeamSessionFrameV1(value) || value.sessionId !== id || value.offset !== offset || (frames.length && (canonicalStringify(value.header) !== canonicalStringify(frames[0]!.header) || value.inheritedEventCount !== frames[0]!.inheritedEventCount))) throw new Error('team.journal-frame-invalid');
      frames.push(value); offset += value.events.length; previous = artifact!.id;
    }
    return frames;
  };
  return {
    read,
    async ids() { return [...new Set((await records()).map(event => event.correlation.sessionId!).filter(Boolean))]; },
    async acquire(id) {
      asStableId(id); if (owned.has(id)) return null;
      owned.add(id);
      try {
        const lease = await claims.acquire(id);
        if (!lease) { owned.delete(id); return null; }
        let released = false;
        return { async release() { if (released) return; try { await tails.get(id); } finally { await lease.release(); released = true; owned.delete(id); } } };
      } catch (error) { owned.delete(id); throw error; }
    },
    async append(input) {
      if (!isTeamSessionFrameV1(input)) throw new Error('team.journal-frame-invalid');
      const frame = JSON.parse(JSON.stringify(input)) as TeamSessionFrameV1;
      const encoded = canonicalStringify(frame as unknown as JsonObject);
      if (containsReasoning(frame) || Buffer.byteLength(encoded) > 1_048_576 || encoded !== canonicalStringify(redactObject(frame as unknown as JsonObject).value)) throw new Error('team.journal-unsafe-frame');
      const prior = tails.get(frame.sessionId) ?? Promise.resolve();
      const run = prior.then(async () => {
        if (!owned.has(frame.sessionId) || !log.status().canPersist) throw new Error('team.journal-write-unavailable');
        const frames = await read(frame.sessionId);
        const offset = frames.reduce((count, entry) => count + entry.events.length, 0);
        if (frame.offset !== offset || (frames.length && (!frame.events.length || canonicalStringify(frame.header) !== canonicalStringify(frames[0]!.header) || frame.inheritedEventCount !== frames[0]!.inheritedEventCount))) throw new Error('team.journal-conflict');
        const priorEvents = await records(frame.sessionId);
        const previous = priorEvents.at(-1)?.payload.artifactId ?? null;
        const artifact = await log.putArtifact(frame as unknown as JsonObject, { schemaVersion: 'team-session-frame/1' });
        await log.append({ kind, source: asStableId('studio.team-journal'), severity: 'info', correlation: { sessionId: frame.sessionId },
          payload: { artifactId: artifact.id, previous, offset, count: frame.events.length, digest: sha256(encoded) }, artifactRefs: [artifact.id] });
        await log.flush();
      });
      tails.set(frame.sessionId, run);
      // A failed write poisons this handle; never continue past an ambiguous durable outcome.
      await run;
    },
  };
}

function containsReasoning(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && (value as Record<string, unknown>).type === 'reasoning') return true;
  return Object.values(value).some(containsReasoning);
}
