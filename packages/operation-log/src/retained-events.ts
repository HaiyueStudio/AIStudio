import type { DurableOperationEvent } from './types.js';
import type { OperationLog } from './index.js';

/** Bounded-window traversal of retained facts. Consumers reduce to their own recovery indexes. */
export async function* scanRetainedEvents(log: Pick<OperationLog, 'query' | 'status'>, kinds: readonly string[], fromSequence = 0): AsyncGenerator<DurableOperationEvent> {
  if (!Number.isSafeInteger(fromSequence) || fromSequence < 0) throw new TypeError('Invalid retained event start sequence.');
  const status = log.status(); let start = Math.max(status.retainedFromSequence, fromSequence), width = 5000;
  while (start < status.nextSequence) {
    const end = Math.min(status.nextSequence, start + width), events: DurableOperationEvent[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await log.query({ kinds, limit: 200, traverseCorrelation: false, ...(start > 0 ? { afterSequence: start - 1 } : {}), beforeSequence: end, ...(cursor ? { cursor } : {}) });
        events.push(...page.events); cursor = page.nextCursor;
      } while (cursor);
    } catch (cause) {
      if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'query-scan-budget-exceeded' || width === 1) throw cause;
      width = Math.max(1, Math.floor(width / 2)); continue;
    }
    yield* events; start = end;
  }
}
