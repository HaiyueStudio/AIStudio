import { scanRetainedEvents as retainedOperationEvents, type DurableOperationEvent, type OperationLog } from '@haiyue/ai-studio-operation-log';
export { retainedOperationEvents };

export async function queryRetainedOperationEvents(operationLog: Pick<OperationLog, 'query' | 'status'>, kinds: readonly string[], retainedEventLimit: number): Promise<readonly DurableOperationEvent[]> {
  if (!Number.isSafeInteger(retainedEventLimit) || retainedEventLimit < 1) throw new TypeError('Retained event limit must be a positive safe integer.');
  const events: DurableOperationEvent[] = [];
  for await (const event of retainedOperationEvents(operationLog, kinds)) {
    events.push(event); if (events.length > retainedEventLimit) events.shift();
  }
  return Object.freeze(events);
}
