import type { DurableOperationEvent, OperationLog } from '@haiyue/ai-studio-operation-log';
import { errorCode } from './value-utils.js';

export async function queryRetainedOperationEvents(
  operationLog: Pick<OperationLog, 'query' | 'status'>,
  kinds: readonly string[],
  retainedEventLimit: number,
): Promise<readonly DurableOperationEvent[]> {
  if (!Number.isSafeInteger(retainedEventLimit) || retainedEventLimit < 1) throw new TypeError('Retained event limit must be a positive safe integer.');
  const status = operationLog.status();
  const events: DurableOperationEvent[] = [];
  let nextStart = status.retainedFromSequence;
  let scanWindow = 5_000;
  scan: while (nextStart < status.nextSequence) {
    const beforeSequence = Math.min(status.nextSequence, nextStart + scanWindow);
    let cursor: string | undefined;
    try {
      do {
        const page = await operationLog.query({
          kinds,
          limit: 200,
          traverseCorrelation: false,
          ...(nextStart > 0 ? { afterSequence: nextStart - 1 } : {}),
          beforeSequence,
          ...(cursor ? { cursor } : {}),
        });
        events.push(...page.events);
        if (events.length > retainedEventLimit) events.splice(0, events.length - retainedEventLimit);
        cursor = page.nextCursor;
      } while (cursor);
    } catch (cause) {
      if (errorCode(cause) !== 'query-scan-budget-exceeded' || scanWindow === 1) throw cause;
      scanWindow = Math.max(1, Math.floor(scanWindow / 2));
      continue scan;
    }
    nextStart = beforeSequence;
  }
  return Object.freeze(events);
}
